import { label } from './labels.js';

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

export { el };

export function renderTicket(container, ticket) {
  container.replaceChildren();
  if (!ticket) return;
  const url = `/api/qr.svg?text=${encodeURIComponent(ticket.token)}`;
  const token = el('code', { text: ticket.token });
  container.append(
    el(
      'article',
      { class: 'ticket' },
      el('p', { class: 'ticket-label', text: 'Your ticket' }),
      el('p', { class: 'ticket-event', text: ticket.event }),
      el('p', { class: 'ticket-id', text: ticket.id }),
      ticket.idCheck === 'gate'
        ? el('p', { class: 'ticket-state ticket-state-gate', text: 'ID check at the gate' })
        : el('p', { class: 'ticket-state', text: 'Age confirmed' }),
      el('img', { class: 'ticket-qr', src: url, alt: `QR code for ticket ${ticket.id}`, width: '176', height: '176' }),
      el('p', { class: 'ticket-hint', text: 'Show this code at the gate.' }),
      el('details', { class: 'ticket-token' }, el('summary', { text: 'Ticket code as text' }), token),
    ),
  );
}

export function renderReceipt(container, receipt) {
  container.replaceChildren();
  if (!receipt) return;
  const names = (list) => (list.length ? list.join(', ') : 'nothing');
  const row = (term, desc) => el('div', { class: 'receipt-row' }, el('dt', { text: term }), el('dd', { text: desc }));
  container.append(
    el(
      'article',
      { class: 'receipt', 'aria-labelledby': 'receipt-title' },
      el('h2', { id: 'receipt-title', text: 'Privacy receipt' }),
      el('p', { class: 'receipt-id', text: `${receipt.id}  ${new Date(receipt.createdAt).toLocaleString()}` }),
      el(
        'dl',
        {},
        row('Result', `${label(receipt.outcome === 'passed' ? 'age_confirmed' : receipt.outcome)} (${receipt.source})`),
        row('Received from the verifier', names(receipt.receivedFieldNames)),
        row('Kept', names(receipt.storedFieldNames)),
        row('Discarded', names(receipt.discardedFieldNames)),
      ),
      el('p', { class: 'receipt-foot', text: 'Field names only. This receipt is built from what the server actually did.' }),
    ),
  );
}

/** Shown instead of a privacy receipt when no ID data was collected at all. */
export function renderNoData(container) {
  container.replaceChildren(
    el(
      'article',
      { class: 'receipt', 'aria-labelledby': 'receipt-title' },
      el('h2', { id: 'receipt-title', text: 'Privacy receipt' }),
      el('p', { class: 'receipt-lead', text: 'No ID data was collected online.' }),
      el('p', { class: 'receipt-foot', text: 'Your age will be checked at the gate with a physical ID or a mobile ID. Nothing about you was received or stored.' }),
    ),
  );
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
