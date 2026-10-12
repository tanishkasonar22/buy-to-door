// Asks for a wallet response. In mock and hybrid mode the answer comes from the separate simulated
// wallet page (/wallet.html), opened on a phone or in another tab. In real mode it calls the
// browser's Digital Credentials API (Credence ID Cloud SDK flow A).

import { PHASES, describeCredential } from './wallet-debug.js';

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Closes a wallet sheet with a short exit animation, then removes it. Callers settle first. */
function closeSheet(dialog) {
  if (!dialog.open || reducedMotion()) {
    if (dialog.open) dialog.close();
    dialog.remove();
    return;
  }
  dialog.classList.add('is-closing');
  const done = () => {
    if (dialog.open) dialog.close();
    dialog.remove();
  };
  dialog.addEventListener('animationend', done, { once: true });
  setTimeout(done, 320); // in case animationend never fires
}

/** Decorative phone-wallet card shown at the top of the sheet. */
function credentialCard() {
  const card = document.createElement('div');
  card.className = 'cred-card compact';
  card.setAttribute('aria-hidden', 'true');
  card.innerHTML =
    '<div class="cred-top"><span>Test credential</span><span class="cred-chip"></span></div>' +
    '<div><div class="cred-name">Demo mobile ID</div><div class="cred-line"><span>Not a real ID</span><span>Simulated</span></div></div>';
  return card;
}

/** Same-tab simulated sheet. Only used for "Quick test on this tab". */
function quickSimulatedWallet(host) {
  return new Promise((resolve, reject) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'wallet-sheet';
    dialog.setAttribute('aria-labelledby', 'wallet-title');

    const badge = document.createElement('p');
    badge.className = 'wallet-badge';
    badge.textContent = 'Simulated wallet. Test credential. Not a real ID.';

    const title = document.createElement('h2');
    title.id = 'wallet-title';
    title.textContent = 'Share your age?';

    const body = document.createElement('p');
    body.textContent = `${host} is asking: are you 21 or older? Only a yes or no is shared. Your name, birth date and photo are not shared.`;

    const labelEl = document.createElement('label');
    labelEl.htmlFor = 'wallet-scenario';
    labelEl.textContent = 'Test result to simulate';
    const select = document.createElement('select');
    select.id = 'wallet-scenario';
    for (const [value, text] of [
      ['pass', 'Adult, all checks pass'],
      ['under', 'Under 21'],
      ['invalid', 'ID checks fail'],
      ['noage', 'No age result returned'],
    ]) {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = text;
      select.append(o);
    }

    const actions = document.createElement('div');
    actions.className = 'wallet-actions';
    const share = document.createElement('button');
    share.type = 'button';
    share.className = 'primary';
    share.textContent = 'Share yes or no';
    const decline = document.createElement('button');
    decline.type = 'button';
    decline.className = 'secondary';
    decline.textContent = 'Don’t share';
    actions.append(decline, share);

    dialog.append(badge, credentialCard(), title, body, labelEl, select, actions);
    document.body.append(dialog);

    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      closeSheet(dialog);
      fn();
    };
    share.addEventListener('click', () => finish(() => resolve(`mock:${select.value}`)));
    decline.addEventListener('click', () => finish(() => reject(new DOMException('Cancelled', 'NotAllowedError'))));
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      finish(() => reject(new DOMException('Cancelled', 'NotAllowedError')));
    });
    dialog.showModal();
    share.focus();
  });
}

// ---- Real mode only -------------------------------------------------------------------------

/** How long the real wallet prompt may stay open before we stop waiting. */
export const REAL_WALLET_TIMEOUT_MS = 2 * 60_000;

/** Calm, specific messages for the real wallet. Hybrid and mock never use these. */
export const REAL_MESSAGES = {
  unsupported: 'Open this page in a browser on the phone that holds your wallet.',
  cancelled: 'The wallet was closed before anything was shared. Nothing was shared. Press Verify to try again.',
  timeout: 'The wallet did not answer in time. Nothing was shared. Press Verify to try again.',
  blocked: 'The browser blocked the wallet prompt. Tap Verify again.',
  network: 'The wallet request could not reach the network. Check your connection, then press Verify to try again.',
  noDeviceRequest: 'The Cloud SDK did not return a deviceRequest. Run the readiness page and check your profile.',
  empty: 'The wallet did not share an ID. Check that the Driver license credential is in your wallet, then try again.',
};

const REAL_OUTCOMES = {
  under_age: 'Your wallet says you are not 21 or older. No ticket was issued.',
  age_claim_missing: 'Your wallet did not share an age answer. No ticket was issued. Check that the Driver license credential is in your wallet, then try again.',
  verification_failed: 'The ID could not be verified. No ticket was issued. You can try again, or buy without a mobile ID.',
  authentication_checks_failed: 'The ID did not pass a security check. No ticket was issued.',
  unreadable_response: 'The wallet answer could not be read. No ticket was issued. Try again.',
  wallet_cancelled: 'The wallet request was cancelled. Nothing was shared.',
};

/** A problem with the real wallet prompt that has its own message. */
class WalletProblem extends Error {
  /** `cause` keeps the browser's original error, so the debug panel can show what really happened. */
  constructor(kind, cause) {
    super(REAL_MESSAGES[kind], cause ? { cause } : undefined);
    this.name = 'WalletProblem';
    this.kind = kind;
  }
}

/**
 * True only when the browser has the Digital Credentials API. navigator.credentials alone is not
 * enough: it exists in every modern browser for passkeys.
 */
export function hasDigitalCredentials(win = globalThis) {
  return typeof win.DigitalCredential !== 'undefined' && typeof win.navigator?.credentials?.get === 'function';
}

/** Message for a real-mode result that did not pass, or null to keep the default wording. */
export function realOutcomeMessage(reason) {
  return REAL_OUTCOMES[reason] ?? null;
}

/**
 * What goes in the `data` of the org-iso-mdoc request. Credence's official sample
 * (React-CloudSDK-Integration, useISO18013Flow) passes the whole dcRequest object
 * ({deviceRequest, encryptionInfo}). For quick testing on a phone, ?dcdata=deviceRequest in the
 * page address passes only dcRequest.deviceRequest instead.
 */
export function walletRequestData(dcRequest, search = globalThis.location?.search ?? '') {
  if (!dcRequest || typeof dcRequest !== 'object' || !dcRequest.deviceRequest) throw new WalletProblem('noDeviceRequest');
  return new URLSearchParams(search).get('dcdata') === 'deviceRequest' ? dcRequest.deviceRequest : dcRequest;
}

/** `trace` (optional) records the phase and the shape of the wallet's answer for the debug panel. */
async function realWallet(dcRequest, trace) {
  if (trace) trace.phase = PHASES.before;
  if (!hasDigitalCredentials()) throw new WalletProblem('unsupported');
  const data = walletRequestData(dcRequest);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REAL_WALLET_TIMEOUT_MS);
  let credential;
  try {
    if (trace) trace.phase = PHASES.during;
    credential = await navigator.credentials.get({
      digital: { requests: [{ protocol: 'org-iso-mdoc', data }] },
      mediation: 'required',
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted || err?.name === 'AbortError') throw new WalletProblem('timeout', err);
    // Chrome uses NotAllowedError both for a user cancel and for a call outside a user gesture
    // ("requires transient activation"). The second is not the user's choice, so say so.
    if (err?.name === 'NotAllowedError') throw new WalletProblem(/transient/i.test(err.message ?? '') ? 'blocked' : 'cancelled', err);
    if (err?.name === 'NetworkError') throw new WalletProblem('network', err);
    if (err?.name === 'NotSupportedError' || err instanceof TypeError) throw new WalletProblem('unsupported', err);
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (trace) {
    trace.phase = PHASES.after;
    trace.credential = describeCredential(credential);
  }
  if (!credential) throw new WalletProblem('empty');
  return typeof credential.data === 'string' ? credential.data : JSON.stringify(credential.data);
}

const POLL_MS = 1000;
const WALLET_TIMEOUT_MS = 5 * 60_000;

/**
 * Cross-device simulated wallet. Shows a QR code for /wallet.html and waits until that page
 * shares or declines. Resolves 'wallet', which tells the server to use the stored answer.
 */
function separateWallet(sessionId) {
  return new Promise((resolve, reject) => {
    const walletUrl = `${location.origin}/wallet.html?s=${encodeURIComponent(sessionId)}`;

    const dialog = document.createElement('dialog');
    dialog.className = 'wallet-sheet';
    dialog.setAttribute('aria-labelledby', 'wallet-title');

    const badge = document.createElement('p');
    badge.className = 'wallet-badge';
    badge.textContent = 'Simulated wallet. Test credential. Not a real ID.';

    const title = document.createElement('h2');
    title.id = 'wallet-title';
    title.textContent = 'Open your wallet';

    const body = document.createElement('p');
    body.textContent = 'Scan this code with your phone, or open the wallet in another tab. This page continues by itself once the wallet answers.';

    const qr = document.createElement('img');
    qr.className = 'wallet-qr';
    qr.src = `/api/qr.svg?text=${encodeURIComponent(walletUrl)}`;
    qr.alt = 'QR code that opens the test wallet';
    qr.width = 200;
    qr.height = 200;

    const link = document.createElement('a');
    link.href = walletUrl;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = 'Open the wallet in a new tab';

    const status = document.createElement('p');
    status.className = 'status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.textContent = 'Waiting for the wallet…';
    status.classList.add('is-waiting');

    const parts = [badge, credentialCard(), title, body, qr, link, status];
    if (location.hostname === 'localhost') {
      const note = document.createElement('p');
      note.className = 'fineprint';
      note.textContent = 'A phone cannot reach localhost. To use a phone, open this shop through its public address.';
      parts.push(note);
    }

    const actions = document.createElement('div');
    actions.className = 'wallet-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'secondary';
    cancel.textContent = 'Cancel';
    const quick = document.createElement('button');
    quick.type = 'button';
    quick.className = 'secondary';
    quick.textContent = 'Quick test on this tab';
    actions.append(cancel, quick);
    parts.push(actions);

    dialog.append(...parts);
    document.body.append(dialog);

    let settled = false;
    let timer = null;
    let deadline = null;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      clearTimeout(deadline);
      closeSheet(dialog);
      fn();
    };
    const declined = () => reject(new DOMException('Declined', 'NotAllowedError'));

    const poll = async () => {
      try {
        const res = await fetch(`/api/verify/status/${encodeURIComponent(sessionId)}`);
        const json = await res.json();
        if (settled) return;
        if (json.status === 'shared') finish(() => resolve('wallet'));
        else if (json.status === 'declined') finish(declined);
        else if (json.status === 'unknown') finish(() => reject(new Error('This verification expired. Start again.')));
        else status.textContent = 'Waiting for the wallet…';
      } catch {
        if (!settled) status.textContent = 'Cannot reach the shop server. Still trying…';
      }
    };
    timer = setInterval(poll, POLL_MS);
    deadline = setTimeout(() => finish(() => reject(new DOMException('Timed out', 'AbortError'))), WALLET_TIMEOUT_MS);

    cancel.addEventListener('click', () => finish(declined));
    quick.addEventListener('click', () => finish(() => quickSimulatedWallet(location.host).then(resolve, reject)));
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      finish(declined);
    });
    dialog.showModal();
    link.focus();
  });
}

export function requestWallet({ mode, dcRequest, sessionId, trace = undefined }) {
  return mode === 'real' ? realWallet(dcRequest, trace) : separateWallet(sessionId);
}

/**
 * Real mode never shows the generic "Something went wrong": an HTTP error keeps the server's
 * message, and anything else names the error, for example "Wallet error: DataError".
 */
function realWalletError(err) {
  if (typeof err?.status === 'number') return err.body?.message || `Wallet error: HTTP ${err.status}`;
  return `Wallet error: ${err?.name || 'Error'}`;
}

export function walletError(err, mode) {
  if (err instanceof WalletProblem) return err.message; // real mode only
  if (mode === 'real') return realWalletError(err);
  if (err instanceof DOMException) {
    if (err.name === 'NotAllowedError') return 'The wallet prompt was cancelled or blocked. Try again.';
    if (err.name === 'AbortError') return 'The wallet request timed out. Try again.';
    if (err.name === 'NetworkError') return 'The wallet request could not complete. Check your connection.';
  }
  return err.message || 'Something went wrong. Try again.';
}
