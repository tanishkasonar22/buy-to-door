// The separate simulated wallet. Opened from the QR code or link on the shop page.
// It holds a test credential and shares or declines. The shop page notices by itself.
import { api } from './api.js';
import { initShell, setJourney } from './shell.js';

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const sessionId = new URLSearchParams(location.search).get('s') ?? '';

const setStatus = (text, tone = '') => {
  statusEl.textContent = text;
  statusEl.dataset.tone = tone;
};

async function respond(action) {
  $('share').disabled = true;
  $('decline').disabled = true;
  try {
    await api(`/api/wallet/respond/${encodeURIComponent(sessionId)}`, { action, scenario: $('scenario').value });
    $('wallet-form').hidden = true;
    setJourney({ buy: 'done', verify: action === 'share' ? 'done' : 'blocked' });
    setStatus(action === 'share' ? 'Shared. Return to the shop page to continue.' : 'Not shared. Return to the shop page.', action === 'share' ? 'ok' : '');
  } catch (err) {
    if (err.status === 409) {
      $('wallet-form').hidden = true;
      return setStatus('This request was already answered.', 'error');
    }
    if (err.status === 404) {
      $('request').hidden = true;
      return setStatus('This request expired or does not exist. Start again on the shop page.', 'error');
    }
    setStatus(err.message, 'error');
    $('share').disabled = false;
    $('decline').disabled = false;
  }
}

async function init() {
  initShell('', { minimal: true, journey: { buy: 'done', verify: 'current' } });
  if (!sessionId) return setStatus('This wallet needs a request. Scan the code on the shop page.', 'error');
  let req;
  try {
    req = await api(`/api/wallet/request/${encodeURIComponent(sessionId)}`);
  } catch (err) {
    return setStatus(
      err.status === 404 ? 'This request expired or does not exist. Start again on the shop page.' : err.message,
      'error',
    );
  }
  $('sender').textContent = `${req.event} is asking`;
  $('question').textContent = req.question;
  $('request').hidden = false;
  if (req.answered) {
    $('wallet-form').hidden = true;
    return setStatus('This request was already answered.');
  }
  $('share').addEventListener('click', () => respond('share'));
  $('decline').addEventListener('click', () => respond('decline'));
  $('share').focus();
}

init();
