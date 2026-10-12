// Asks for a wallet response. In mock and hybrid mode the answer comes from the separate simulated
// wallet page (/wallet.html), opened on a phone or in another tab. In real mode it calls the
// browser's Digital Credentials API (Credence ID Cloud SDK flow A).

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

async function realWallet(dcRequest) {
  if (!navigator.credentials || !navigator.credentials.get) {
    throw new Error('This browser cannot read wallet IDs. Use Safari on iOS 17.4 or later.');
  }
  // The Cloud SDK integration guide (flow A) says to pass dcRequest.deviceRequest as the request data.
  const deviceRequest = dcRequest && typeof dcRequest === 'object' ? dcRequest.deviceRequest : undefined;
  if (!deviceRequest) throw new Error('The Cloud SDK did not return a deviceRequest. Run the readiness page and check your profile.');
  const credential = await navigator.credentials.get({
    digital: { requests: [{ protocol: 'org-iso-mdoc', data: deviceRequest }] },
    mediation: 'required',
  });
  if (!credential) throw new Error('The wallet did not return an ID.');
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

export function requestWallet({ mode, dcRequest, sessionId }) {
  return mode === 'real' ? realWallet(dcRequest) : separateWallet(sessionId);
}

export function walletError(err) {
  if (err instanceof DOMException) {
    if (err.name === 'NotAllowedError') return 'The wallet prompt was cancelled or blocked. Try again.';
    if (err.name === 'AbortError') return 'The wallet request timed out. Try again.';
    if (err.name === 'NetworkError') return 'The wallet request could not complete. Check your connection.';
  }
  return err.message || 'Something went wrong. Try again.';
}
