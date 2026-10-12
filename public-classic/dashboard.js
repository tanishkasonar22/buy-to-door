import { api } from './api.js';
import { label, methodLabel } from './labels.js';
import { el } from './render.js';
import { initShell } from './shell.js';

const $ = (id) => document.getElementById(id);
const ms = (v) => (v == null ? '—' : `${(v / 1000).toFixed(1)} s`);
const stat = (term, value) => el('div', { class: 'stat' }, el('dt', { text: term }), el('dd', { text: String(value) }));
const tr = (...cells) => el('tr', {}, ...cells.map((c) => (c instanceof Node ? c : el('td', { text: String(c) }))));

function empty(body, cols) {
  body.replaceChildren(el('tr', {}, el('td', { colspan: String(cols), class: 'empty', text: 'Nothing yet.' })));
}

const SDK_NOTES = {
  mock: 'Mock mode. No Cloud SDK calls are made, so these counters stay empty.',
  hybrid: 'Every wallet request is created by the Credence ID Cloud SDK. Only the wallet answer is simulated.',
  real: 'Every wallet request is created and checked by the Credence ID Cloud SDK.',
};

function ago(iso) {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return s < 60 ? `${s} s ago` : `${Math.floor(s / 60)} min ago`;
}

function renderSdk(s) {
  const badge = $('sdk-mode');
  badge.textContent = s.label;
  badge.dataset.live = String(s.live);
  $('sdk-note').textContent = SDK_NOTES[s.mode] + (s.endpoint ? ` Service: ${s.endpoint}.` : '') + ' Counts cover this server run.';
  const dash = (v, f = String) => (v == null ? '—' : f(v));
  const tokens = (v) => (s.live && !s.tokenTracking ? 'Not tracked' : dash(v));
  $('sdk').replaceChildren(
    stat('Requests created', s.requestsCreated),
    stat('Average response time', dash(s.avgResponseMs, (v) => `${v} ms`)),
    stat('Token setups', tokens(s.tokenSetups)),
    stat('Token refreshes', tokens(s.tokenRefreshes)),
    stat('Last request', dash(s.lastRequestAt, (v) => `${new Date(v).toLocaleTimeString()} (${ago(v)})`)),
    stat('Last session ID', dash(s.lastSessionId)),
    stat('Failed requests', s.failedRequests),
  );
}

function render(m) {
  const f = m.funnel;
  $('funnel').replaceChildren(
    stat('Wallet prompts', f.walletPrompted), stat('Buyers verified', f.verified), stat('Buyers not verified', f.notVerified),
    stat('Orders', f.ordersPlaced), stat('Tickets', f.ticketsTotal), stat('Waiting for guest', f.unclaimed),
    stat('Claimed by guests', f.claimed), stat('Claims failed', f.claimsFailed), stat('Entered', f.entered),
    stat('Chose no mobile ID', f.noWallet), stat('Tickets needing a gate ID check', f.gateCheckTickets),
    stat('Gate-check tickets entered', f.gateCheckEntered),
  );

  renderSdk(m.sdk);
  const methods = Object.entries(m.methods);
  const mb = $('methods');
  if (!methods.length) empty(mb, 5);
  else mb.replaceChildren(...methods.map(([k, v]) => {
    const t = m.scanTimes[k];
    const tag = v.simulated ? ' (simulated)' : v.staffRecorded ? ' (staff-recorded)' : '';
    return tr(methodLabel(k).replace(/ \(.*\)$/, '') + tag, v.pass, v.fail, ms(t?.p50), ms(t?.p95));
  }));

  const fails = Object.entries(m.failures);
  if (!fails.length) empty($('failures'), 2);
  else $('failures').replaceChildren(...fails.sort((a, b) => b[1] - a[1]).map(([k, v]) => tr(label(k), v)));

  if (!m.recent.length) empty($('recent'), 6);
  else $('recent').replaceChildren(...m.recent.map((r) => tr(
    new Date(r.ts).toLocaleTimeString(), r.ticketId, r.gateId, methodLabel(r.method), r.result === 'pass' ? 'Admitted' : 'Refused', r.reason ? label(r.reason) : '—')));

  const p = m.privacy;
  $('privacy').replaceChildren(
    stat('Passed', p.verifications.passed ?? 0), stat('Failed', (p.verifications.failed ?? 0)),
    stat('Fields discarded', p.discardedFieldNames.length ? p.discardedFieldNames.join(', ') : 'none yet'),
    stat('Personal-data columns', p.personalDataShapedColumns.length ? p.personalDataShapedColumns.map((c) => (typeof c === 'string' ? c : JSON.stringify(c))).join(', ') : 'none'),
  );
  $('privacy-note').textContent = 'Columns stored: ' + Object.entries(p.columns).map(([t, c]) => `${t} (${c.join(', ')})`).join('; ') + '.';
}

async function load() {
  try {
    render(await api('/api/metrics'));
    $('status').textContent = '';
  } catch (err) {
    $('status').textContent = `Could not refresh. ${err.message}`;
    $('status').dataset.tone = 'error';
  }
}

const config = await initShell('/dashboard.html');
if (config?.mode !== 'real') {
  $('reset').hidden = false;
  $('reset').addEventListener('click', async () => {
    if (!confirm('Delete all demo orders, tickets and scans?')) return;
    await api('/api/dev/reset', {});
    load();
  });
}
await load();
setInterval(() => { if (!document.hidden) load(); }, 3000);
