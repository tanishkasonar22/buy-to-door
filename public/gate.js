import { api } from './api.js';
import { label, methodLabel } from './labels.js';
import { renderReceipt } from './render.js';
import { doorIcon, initShell, setJourney } from './shell.js';

const $ = (id) => document.getElementById(id);
let ticketId = null;
let startedAt = 0;

// Verdict icons: an opening door to admit, a lock to refuse. Always paired with the text.
const ICONS = {
  ok: '<rect x="6" y="4" width="36" height="48" rx="3" fill="none" stroke="currentColor" stroke-width="4"/><rect class="leaf" x="8" y="6" width="32" height="44" rx="2" fill="currentColor" opacity=".25"/><circle cx="33" cy="30" r="3" fill="currentColor"/>',
  error: '<rect x="8" y="24" width="32" height="26" rx="4" fill="currentColor"/><path d="M14 24v-7a10 10 0 0 1 20 0v7" fill="none" stroke="currentColor" stroke-width="5"/>',
};

function verdict(ok, text) {
  const v = $('verdict');
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 48 56');
  icon.setAttribute('class', 'verdict-icon');
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = ok ? ICONS.ok : ICONS.error;
  const words = document.createElement('span');
  words.textContent = text;
  v.replaceChildren(icon, words);
  v.dataset.tone = ok ? 'ok' : 'error';
  // Restart the short admit/refuse animation each time.
  v.hidden = true;
  void v.offsetWidth;
  v.hidden = false;
  setJourney({ buy: 'done', verify: 'done', ticket: 'done', door: ok ? 'done' : 'blocked' });
}

function reset() {
  ticketId = null;
  $('step2').hidden = true;
}

async function validate(e) {
  e.preventDefault();
  $('verdict').hidden = true;
  $('receipt-box').replaceChildren();
  reset();
  const code = $('code').value.trim();
  if (!code) return ($('status').textContent = 'Enter a ticket code.');
  try {
    const res = await api('/api/gate/validate', { code });
    if (!res.ok) {
      $('status').textContent = '';
      return verdict(false, `Do not admit. ${label(res.reason)}.`);
    }
    ticketId = res.ticket.id;
    startedAt = performance.now();
    $('status').textContent = '';
    $('ticket-line').textContent = `${res.ticket.event}, ticket ${ticketId}`;
    setJourney({ buy: 'done', verify: res.ticket.idCheck === 'gate' ? 'later' : 'done', ticket: 'done', door: 'current' });
    // A ticket bought without a mobile ID has had no age check yet, so no override.
    const atGate = res.ticket.idCheck === 'gate';
    $('gate-note').textContent = atGate
      ? 'Age was NOT checked online. Check a physical ID or a mobile ID. An override is not allowed.'
      : 'Age was verified online.';
    $('gate-note').dataset.tone = atGate ? 'warn' : 'ok';
    $('override-section').hidden = atGate;
    $('step2').hidden = false;
  } catch (err) {
    $('status').textContent = err.message;
  }
}

function finish(res, method) {
  const ok = res.result === 'pass';
  verdict(ok, ok ? `Admit. ${methodLabel(method)}.` : `Do not admit. ${label(res.reason)}.`);
  if (res.receipt) renderReceipt($('receipt-box'), res.receipt);
  reset();
  $('code').value = '';
  $('code').focus();
}

const elapsed = () => Math.round(performance.now() - startedAt);
const gateId = () => $('gate-id').value;

async function act(promise, method) {
  try {
    finish(await promise, method);
  } catch (err) {
    if (err.body?.reason) verdict(false, `Do not admit. ${label(err.body.reason)}.`);
    else verdict(false, err.message);
    reset();
  }
}

const config = await initShell('/gate.html', { journey: { buy: 'done', verify: 'done', ticket: 'done', door: 'current' } });
$('gate-door-slot').replaceWith(doorIcon('gate-door'));
if (config?.mode === 'real') $('mobile-section').hidden = true;
$('validate-form').addEventListener('submit', validate);
$('mobile-btn').addEventListener('click', () =>
  act(api('/api/gate/verify', { ticketId, scenario: $('scenario').value, gateId: gateId(), durationMs: elapsed() }), 'mobile_id_simulated'));
$('phys-pass').addEventListener('click', () =>
  act(api('/api/gate/scan', { ticketId, method: 'physical_id_staff_recorded', result: 'pass', gateId: gateId(), durationMs: elapsed() }), 'physical_id_staff_recorded'));
$('phys-fail').addEventListener('click', () =>
  act(api('/api/gate/scan', { ticketId, method: 'physical_id_staff_recorded', result: 'fail', reason: $('fail-reason').value, gateId: gateId(), durationMs: elapsed() }), 'physical_id_staff_recorded'));
$('override-btn').addEventListener('click', () =>
  act(api('/api/gate/scan', { ticketId, method: 'override', result: 'pass', reason: $('override-reason').value, gateId: gateId(), durationMs: elapsed() }), 'override'));
