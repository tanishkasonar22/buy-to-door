import { api } from './api.js';
import { detectFlows } from './flows.js';
import { el } from './render.js';
import { initShell } from './shell.js';

const $ = (id) => document.getElementById(id);
const STATE = { pass: 'Pass', fail: 'Fail', warn: 'Check', skipped: 'Skipped', info: 'Info' };
const FLOW = { supported: 'Supported', check_device: 'Check device', needs_flag: 'Needs a flag', unsupported: 'Not supported' };

function renderFlows() {
  const r = detectFlows(navigator.userAgent);
  const b = r.browser;
  const os = b.isIOS ? 'iOS' + (b.iosVersion ? ' ' + b.iosVersion.join('.') : '') : b.isAndroid ? 'Android' : 'desktop';
  const app = b.inApp ? 'an in-app browser' : b.firefox ? 'Firefox' : b.edge ? 'Edge' : b.iosChrome ? 'Chrome on iOS' : b.chromeVersion ? 'Chrome ' + b.chromeVersion : b.safari ? 'Safari' : 'an unknown browser';
  $('browser-line').textContent = `Detected: ${app} on ${os}.`;
  $('flows').replaceChildren(...r.flows.map((f) => el('tr', {}, el('td', { text: `${f.id}. ${f.name}` }), el('td', { text: FLOW[f.status] ?? f.status }), el('td', { text: f.reason }))));
  $('flow-note').textContent = 'This prototype implements flow A only. The SDK supports B, C and D, but they are not built here.';
}

function renderChecks(checks) {
  $('checks').replaceChildren(...checks.map((c) => {
    const li = el('li', { class: `check check-${c.status}` }, el('span', { class: 'check-state', text: STATE[c.status] ?? c.status }), el('span', { class: 'check-label', text: c.label }), el('span', { class: 'check-detail', text: c.detail }));
    if (c.fix) li.append(el('span', { class: 'check-fix', text: `Fix: ${c.fix}` }));
    return li;
  }));
}

async function run() {
  $('status').textContent = 'Running…';
  $('status').dataset.tone = '';
  try {
    const res = await api('/api/readiness', undefined, $('token').value ? { 'x-readiness-token': $('token').value } : {});
    renderChecks(res.checks);
    const bad = res.checks.filter((c) => c.status === 'fail').length;
    $('status').textContent = bad ? `${bad} check${bad > 1 ? 's' : ''} failed.` : 'No failed checks.';
    $('status').dataset.tone = bad ? 'error' : 'ok';
  } catch (err) {
    $('status').textContent = err.message;
    $('status').dataset.tone = 'error';
  }
}

const config = await initShell('/readiness.html');
if (config && config.mode !== 'mock') $('token-row').hidden = false;
$('run').addEventListener('click', run);
renderFlows();
