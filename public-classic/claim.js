import { api } from './api.js';
import { label } from './labels.js';
import { renderNoData, renderReceipt, renderTicket } from './render.js';
import { initShell } from './shell.js';
import { requestWallet, walletError } from './wallet.js';

const $ = (id) => document.getElementById(id);
const verifyBtn = $('verify');
const noWalletBtn = $('no-wallet');
const statusEl = $('status');
const token = new URLSearchParams(location.search).get('t') ?? '';
let mode = 'mock';

const setStatus = (text, tone = '') => {
  statusEl.textContent = text;
  statusEl.dataset.tone = tone;
};

let prefetched = null;
const fresh = () => prefetched && performance.now() - prefetched.ts < 60_000;
function prefetchStart() {
  if (!fresh()) prefetched = { ts: performance.now(), promise: api(`/api/claims/${encodeURIComponent(token)}/start`, {}) };
}
const takeStart = () => {
  const p = fresh() ? prefetched.promise : api(`/api/claims/${encodeURIComponent(token)}/start`, {});
  prefetched = null;
  return p;
};

const setBusy = (busy) => {
  verifyBtn.disabled = busy;
  noWalletBtn.disabled = busy;
};
const hideButtons = () => {
  verifyBtn.hidden = true;
  noWalletBtn.hidden = true;
  $('no-wallet-help').hidden = true;
};

async function claim() {
  setBusy(true);
  setStatus('Waiting for your wallet…');
  try {
    const { sessionId, dcRequest } = await takeStart();
    const data = await requestWallet({ mode, dcRequest, sessionId });
    setStatus('Checking your ID…');
    const result = await api(`/api/claims/${encodeURIComponent(token)}/confirm`, { sessionId, data });
    renderTicket($('ticket-box'), result.ticket);
    renderReceipt($('receipt-box'), result.receipt);
    if (result.outcome === 'passed') {
      setStatus('Age confirmed. Your ticket is ready.', 'ok');
      hideButtons();
      return;
    }
    setStatus(`${label(result.reason)}. The ticket was not claimed. You can try again.`, 'error');
  } catch (err) {
    setStatus(err.status === 409 || err.status === 404 ? err.message : walletError(err), 'error');
    if (err.body?.receipt) renderReceipt($('receipt-box'), err.body.receipt);
    if (err.status === 404 || err.status === 409) hideButtons();
  } finally {
    setBusy(false);
  }
}

// No mobile ID: claim now, show a physical ID at the gate. Nothing is collected online.
async function claimWithoutWallet() {
  setBusy(true);
  setStatus('Claiming your ticket…');
  try {
    const result = await api(`/api/claims/${encodeURIComponent(token)}/no-wallet`, {});
    renderTicket($('ticket-box'), result.ticket);
    renderNoData($('receipt-box'));
    setStatus('Ticket claimed. You will show a physical ID at the gate.', 'ok');
    hideButtons();
  } catch (err) {
    setStatus(err.message, 'error');
    if (err.status === 404 || err.status === 409) hideButtons();
  } finally {
    setBusy(false);
  }
}

async function init() {
  const config = await initShell('');
  if (!config) return setStatus('The page could not reach the server. Reload to try again.', 'error');
  mode = config.mode;
  $('event-meta').textContent = `${config.event.name}, ${config.event.venue}, ${config.event.date}`;
  try {
    await api(`/api/claims/${encodeURIComponent(token)}`);
  } catch (err) {
    hideButtons();
    return setStatus(err.message, 'error');
  }
  if (mode === 'real') verifyBtn.addEventListener('pointerdown', prefetchStart);
  setBusy(false);
  verifyBtn.addEventListener('click', claim);
  noWalletBtn.addEventListener('click', claimWithoutWallet);
}

init();
