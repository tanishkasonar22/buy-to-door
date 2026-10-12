import { api } from './api.js';
import { detectFlows } from './flows.js';
import { label } from './labels.js';
import { copyText, el, renderNoData, renderReceipt, renderTicket } from './render.js';
import { mountStage, openInSteps, setDoor } from './door.js';
import { initShell, setJourney } from './shell.js';
import { hasDigitalCredentials, realOutcomeMessage, requestWallet, walletError } from './wallet.js';
import { markConfirm, newTrace, reportRealFailure } from './wallet-debug.js';

const $ = (id) => document.getElementById(id);
const verifyBtn = $('verify');
const noWalletBtn = $('no-wallet');
const statusEl = $('status');
let mode = 'mock';

function setStatus(text, tone = '') {
  statusEl.textContent = text;
  statusEl.dataset.tone = tone;
}

// iOS Safari only allows navigator.credentials.get() inside the same user-gesture task.
// So in real mode the server session is requested when the finger goes down, before the click.
let prefetched = null;
const fresh = () => prefetched && performance.now() - prefetched.ts < 60_000;
function prefetchStart() {
  if (!fresh()) prefetched = { ts: performance.now(), promise: api('/api/verify/start', {}) };
}
function takeStart() {
  const p = fresh() ? prefetched.promise : api('/api/verify/start', {});
  prefetched = null;
  return p;
}

function renderOrder(order) {
  const box = $('order-box');
  box.replaceChildren();
  if (!order || order.claimLinks.length === 0) return;
  const rows = order.claimLinks.map((link, i) => {
    const full = location.origin + link.path;
    const input = el('input', { type: 'text', readonly: '', value: full, 'aria-label': `Claim link for guest ticket ${i + 1}` });
    const copy = el('button', { type: 'button', class: 'secondary', text: 'Copy' });
    copy.addEventListener('click', async () => {
      const ok = await copyText(full);
      if (!ok) input.select();
      copy.textContent = ok ? 'Copied' : 'Press Ctrl+C';
    });
    return el('li', {}, el('span', { class: 'guest-label', text: `Guest ticket ${i + 1}` }), el('div', { class: 'copy-row' }, input, copy));
  });
  box.append(
    el(
      'article',
      { class: 'card' },
      el('h2', { text: 'Guest claim links' }),
      el('p', { class: 'card-help', text: 'Send one link to each guest. Each guest proves their own age to claim a ticket. A link works once and expires. Links are shown only now. You can make a new one from the order page.' }),
      el('ul', { class: 'link-list' }, ...rows),
      el('a', { class: 'text-link', href: `/order.html?o=${encodeURIComponent(order.id)}`, text: 'Track which tickets are claimed' }),
    ),
  );
}

const setBusy = (busy) => {
  verifyBtn.disabled = busy;
  noWalletBtn.disabled = busy;
};

async function verify() {
  const trace = mode === 'real' ? newTrace() : undefined; // real-mode debug only
  setBusy(true);
  setStatus('Waiting for your wallet…');
  setJourney({ buy: 'done', verify: 'current' });
  setDoor('closed');
  try {
    const quantity = Number($('quantity').value);
    const { sessionId, dcRequest } = await takeStart();
    const data = await requestWallet({ mode, dcRequest, sessionId, trace });
    setStatus('Checking your ID…');
    const result = await api('/api/verify/confirm', { sessionId, data, quantity }, {}, markConfirm(trace));
    renderTicket($('ticket-box'), result.ticket);
    renderOrder(result.order);
    renderReceipt($('receipt-box'), result.receipt);
    if (result.outcome === 'passed') {
      setStatus('Age confirmed. Your ticket is ready.', 'ok');
      setJourney({ buy: 'done', verify: 'done', ticket: 'done', door: 'current' });
      openInSteps('open');
    } else {
      setStatus((mode === 'real' && realOutcomeMessage(result.reason)) || `${label(result.reason)}. No ticket was issued.`, 'error');
      if (trace) reportRealFailure(null, trace, { result, statusEl });
      setJourney({ buy: 'done', verify: 'blocked' });
      setDoor('locked', `Locked: ${label(result.reason).toLowerCase()}`);
    }
  } catch (err) {
    setStatus(walletError(err, mode), 'error');
    if (trace) reportRealFailure(err, trace, { statusEl });
    setJourney({ buy: 'current' });
    setDoor('closed');
  } finally {
    setBusy(false);
  }
}

// No mobile ID: the ticket is issued now and the age is checked at the gate. Nothing is collected online.
async function buyWithoutWallet() {
  setBusy(true);
  setStatus('Issuing your ticket…');
  try {
    const result = await api('/api/orders/no-wallet', { quantity: Number($('quantity').value) });
    renderTicket($('ticket-box'), result.ticket);
    renderOrder(result.order);
    renderNoData($('receipt-box'));
    setStatus('Ticket issued. You will show a physical ID at the gate.', 'ok');
    setJourney({ buy: 'done', verify: 'later', ticket: 'done', door: 'current' });
    setDoor('ajar', 'Ticket issued. Your ID is checked at the door.');
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    setBusy(false);
  }
}

async function init() {
  const config = await initShell('/', { journey: { buy: 'current' } });
  mountStage($('stage'), { event: config?.event, threeD: true });
  if (!config) return setStatus('The page could not reach the server. Reload to try again.', 'error');
  mode = config.mode;
  $('event-name').textContent = config.event.name;
  $('event-meta').textContent = `${config.event.venue}, ${config.event.date}`;
  $('event-ticket').textContent = config.event.ticket;
  $('event-note').textContent = config.event.note;
  const qty = $('quantity');
  for (let i = 1; i <= config.maxQuantity; i++) qty.append(el('option', { value: String(i), text: i === 1 ? '1 ticket (just me)' : `${i} tickets (me and ${i - 1} guest${i > 2 ? 's' : ''})` }));

  if (mode === 'real') {
    // Feature detection decides, not the user agent: flow A (org-iso-mdoc over the Digital
    // Credentials API) also works on Android, for example with the Multipaz Wallet in Chrome.
    const a = detectFlows(navigator.userAgent).flows.find((f) => f.id === 'A');
    const hint = $('hint');
    if (!hasDigitalCredentials()) {
      hint.hidden = false;
      hint.textContent = 'This browser cannot ask a wallet for an ID. Open this page in a browser on the phone that holds your wallet.';
    } else if (a.status === 'needs_flag') {
      hint.hidden = false;
      hint.textContent = a.reason;
    }
    verifyBtn.addEventListener('pointerdown', prefetchStart);
  }
  setBusy(false);
  verifyBtn.addEventListener('click', verify);
  noWalletBtn.addEventListener('click', buyWithoutWallet);
}

init();
