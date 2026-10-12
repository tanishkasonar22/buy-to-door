import { api } from './api.js';
import { label, methodLabel } from './labels.js';
import { el } from './render.js';
import { initShell } from './shell.js';

const $ = (id) => document.getElementById(id);
const ms = (v) => (v == null ? '—' : `${(v / 1000).toFixed(1)} s`);
// Long text values (field lists, times) use body type so they wrap cleanly instead of mid-word.
const stat = (term, value) => {
  const text = String(value);
  return el('div', { class: 'stat' }, el('dt', { text: term }), el('dd', { text, ...(text.length > 12 ? { class: 'stat-text' } : {}) }));
};
const tr = (...cells) => el('tr', {}, ...cells.map((c) => (c instanceof Node ? c : el('td', { text: String(c) }))));

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const SVGNS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
};

// ---- Count-up numbers: whole numbers animate from their previous value when they change ----
const previous = new Map();
function countUp(container) {
  for (const stat of container.querySelectorAll('.stat')) {
    const key = `${container.id}:${stat.querySelector('dt').textContent}`;
    const dd = stat.querySelector('dd');
    const text = dd.textContent;
    if (!/^\d+$/.test(text)) { previous.delete(key); continue; }
    const to = Number(text);
    const from = previous.get(key) ?? 0;
    previous.set(key, to);
    if (from === to || reduced()) continue;
    const start = performance.now();
    const dur = Math.min(900, 300 + Math.abs(to - from) * 40);
    dd.textContent = String(from);
    const step = (now) => {
      if (!dd.isConnected) return;
      const p = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      dd.textContent = String(Math.round(from + (to - from) * eased));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
}

// ---- Small SVG charts (no chart library) ----
/** Horizontal bars, updated in place so a refresh glides instead of redrawing. */
// Charts are drawn at their real on-screen width, so text stays legible on a phone.
const widthOf = (svg) => Math.max(280, Math.round(svg.getBoundingClientRect().width) || 420);

function barChart(svg, rows, { labelW = 168, rowH = 26, valueW = 44 } = {}) {
  const width = widthOf(svg);
  labelW = Math.min(labelW, Math.round(width * 0.38));
  const max = Math.max(1, ...rows.flatMap((r) => r.values));
  const height = Math.max(rowH, rows.length * rowH);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const barW = width - labelW - valueW;
  const sig = width + '|' + rows.map((r) => r.label).join('|');
  if (svg.dataset.sig !== sig) {
    svg.replaceChildren();
    svg.dataset.sig = sig;
    rows.forEach((r, i) => {
      const y = i * rowH;
      const g = svgEl('g', { 'data-row': i });
      const label = svgEl('text', { x: 0, y: y + rowH / 2 + 4, class: 'bar-label' });
      label.textContent = r.label;
      g.append(label, svgEl('rect', { x: labelW, y: y + 5, width: barW, height: rowH - 10, rx: 4, class: 'bar-track' }));
      r.values.forEach((_, j) => {
        const h = (rowH - 10) / r.values.length;
        g.append(svgEl('rect', { x: labelW, y: y + 5 + j * h, width: barW, height: h, rx: 3, class: j ? 'bar alt' : 'bar', style: 'transform: scaleX(0)' }));
      });
      g.append(svgEl('text', { x: labelW + barW + 8, y: y + rowH / 2 + 4, class: 'bar-value' }));
      svg.append(g);
    });
  }
  rows.forEach((r, i) => {
    const g = svg.querySelector(`[data-row="${i}"]`);
    const bars = g.querySelectorAll('.bar');
    const apply = () => r.values.forEach((v, j) => (bars[j].style.transform = `scaleX(${Math.max(0.004, v / max)})`));
    reduced() ? apply() : requestAnimationFrame(apply);
    g.querySelector('.bar-value').textContent = r.display ?? String(r.values[0]);
  });
}

const history = [];
function sparkline(svg, values) {
  const w = widthOf(svg), h = 120, pad = 8;
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  // Headroom above the highest value, so a flat line does not hug the top edge.
  const max = Math.max(1, ...values) * 1.35;
  const pts = values.map((v, i) => [pad + (i * (w - 2 * pad)) / Math.max(1, values.length - 1), h - pad - (v / max) * (h - 2 * pad)]);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
  const last = pts[pts.length - 1];
  svg.replaceChildren(
    svgEl('line', { class: 'spark-base', x1: pad, x2: w - pad, y1: h - pad, y2: h - pad }),
    svgEl('path', { class: 'spark-area', d: `${line}L${last[0].toFixed(1)},${h - pad}L${pts[0][0].toFixed(1)},${h - pad}Z` }),
    svgEl('path', { class: 'spark', d: line }),
    svgEl('circle', { class: 'spark-dot', cx: last[0], cy: last[1], r: 4 }),
  );
}

function renderCharts(m) {
  const f = m.funnel;
  const steps = [
    ['Wallet prompts', f.walletPrompted], ['Buyers verified', f.verified], ['Chose no mobile ID', f.noWallet],
    ['Tickets', f.ticketsTotal], ['Claimed by guests', f.claimed], ['Entered', f.entered],
  ];
  barChart($('funnel-chart'), steps.map(([label, v]) => ({ label, values: [v] })));
  $('funnel-chart-desc').textContent = steps.map(([l, v]) => `${l}: ${v}`).join('. ') + '.';

  history.push((f.walletPrompted ?? 0) + (f.noWallet ?? 0));
  if (history.length > 40) history.shift();
  sparkline($('spark-chart'), history.length > 1 ? history : [history[0], history[0]]);
  $('spark-desc').textContent = `Wallet prompts plus no-ID orders: ${history[history.length - 1]} now, sampled ${history.length} times this session.`;

  const times = Object.entries(m.scanTimes);
  const rows = times.length
    ? times.map(([k, t]) => ({ label: methodLabel(k).replace(/ \(.*\)$/, ''), values: [t.p50 ?? 0, t.p95 ?? 0], display: `${ms(t.p50)} / ${ms(t.p95)}` }))
    : [{ label: 'No timed scans yet', values: [0, 0], display: '—' }];
  barChart($('times-chart'), rows, { rowH: 30, labelW: 120, valueW: 112 });
  $('times-desc').textContent = times.length ? rows.map((r) => `${r.label}: median and slowest 5% ${r.display}`).join('. ') : 'No timed scans yet.';
}

function pulse(ok) {
  const p = $('live-pulse');
  p.dataset.state = ok ? 'live' : 'error';
  $('live-text').textContent = ok ? `Live · updated ${new Date().toLocaleTimeString()}` : 'Offline · retrying';
  const dot = $('live-dot');
  dot.classList.remove('beat');
  if (ok && !reduced()) {
    void dot.offsetWidth;
    dot.classList.add('beat');
  }
}

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
  countUp($('funnel'));
  countUp($('sdk'));
  renderCharts(m);
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
  countUp($('privacy'));
  $('privacy-note').textContent = 'Columns stored: ' + Object.entries(p.columns).map(([t, c]) => `${t} (${c.join(', ')})`).join('; ') + '.';
}

async function load() {
  try {
    render(await api('/api/metrics'));
    $('status').textContent = '';
    $('status').dataset.tone = '';
    pulse(true);
  } catch (err) {
    $('status').textContent = `Could not refresh. ${err.message}`;
    $('status').dataset.tone = 'error';
    pulse(false);
  }
}

const config = await initShell('/dashboard.html');
// The dashboard watches every journey, so the rail shows no single step in progress.
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
