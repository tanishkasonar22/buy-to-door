import { api } from './api.js';
import { label, methodLabel } from './labels.js';
import { renderReceipt } from './render.js';
import { initShell } from './shell.js';

const $ = (id) => document.getElementById(id);
let ticketId = null;
let startedAt = 0;

function verdict(ok, text) {
  const v = $('verdict');
  v.hidden = false;
  v.dataset.tone = ok ? 'ok' : 'error';
  v.textContent = text;
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

const config = await initShell('/gate.html');
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
