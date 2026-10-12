import { api } from './api.js';
import { copyText, el } from './render.js';
import { initShell } from './shell.js';

const $ = (id) => document.getElementById(id);
const orderId = new URLSearchParams(location.search).get('o') ?? '';
const STATUS = { issued: 'Claimed', unclaimed: 'Waiting for guest', expired: 'Link expired', used: 'Entered', revoked: 'Revoked' };
const open = new Map(); // ticket id -> newest link shown this visit

async function regenerate(ticketId) {
  const res = await api(`/api/orders/${encodeURIComponent(orderId)}/tickets/${encodeURIComponent(ticketId)}/link`, {});
  open.set(ticketId, location.origin + res.path);
  await load();
}

function row(ticket, index) {
  const status = el('td', {}, el('span', { class: `badge badge-${ticket.status}`, text: STATUS[ticket.status] ?? ticket.status }));
  if (ticket.idCheck === 'gate') status.append(' ', el('span', { class: 'gate-check-label', text: 'ID check at gate' }));
  const cells = [el('th', { scope: 'row', text: ticket.label }), status];
  const link = el('td');
  if (ticket.status === 'unclaimed' || ticket.status === 'expired') {
    const shown = open.get(ticket.id);
    if (shown) {
      const input = el('input', { type: 'text', readonly: '', value: shown, 'aria-label': `New claim link for ${ticket.label}` });
      const copy = el('button', { type: 'button', class: 'secondary', text: 'Copy' });
      copy.addEventListener('click', async () => {
        copy.textContent = (await copyText(shown)) ? 'Copied' : 'Press Ctrl+C';
      });
      link.append(el('div', { class: 'copy-row' }, input, copy));
    } else {
      const btn = el('button', { type: 'button', class: 'secondary', text: 'Make a new link' });
      btn.addEventListener('click', () => regenerate(ticket.id).catch((e) => ($('status').textContent = e.message)));
      link.append(btn);
    }
  } else {
    link.append(document.createTextNode('—'));
  }
  return el('tr', {}, ...cells, link);
}

async function load() {
  try {
    const order = await api(`/api/orders/${encodeURIComponent(orderId)}`);
    $('order-id').textContent = `${order.event}, order ${order.id}`;
    const body = $('tickets').querySelector('tbody');
    body.replaceChildren(...order.tickets.map(row));
    $('tickets').hidden = false;
    $('status').textContent = '';
  } catch (err) {
    $('status').textContent = err.status === 404 ? 'This order was not found.' : err.message;
    $('status').dataset.tone = 'error';
    clearInterval(timer);
  }
}

await initShell('');
await load();
const timer = setInterval(() => { if (!document.hidden) load(); }, 3000);
