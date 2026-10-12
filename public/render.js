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

/** Field names as chips. A hidden comma keeps them a readable list for screen readers. */
function chips(list, cls) {
  if (!list.length) return [document.createTextNode('nothing')];
  return list.flatMap((name, i) => [
    el('span', { class: cls, text: name }),
    ...(i < list.length - 1 ? [el('span', { class: 'visually-hidden', text: ', ' })] : []),
  ]);
}

export function renderReceipt(container, receipt) {
  container.replaceChildren();
  if (!receipt) return;
  let i = 0;
  const row = (term, desc, cls = '') => {
    const dd = el('dd', {});
    dd.append(...(typeof desc === 'string' ? [document.createTextNode(desc)] : desc));
    return el('div', { class: `receipt-row ${cls}`.trim(), style: `--i:${i++}` }, el('dt', { text: term }), dd);
  };
  container.append(
    el(
      'article',
      { class: 'receipt', 'aria-labelledby': 'receipt-title' },
      el('h2', { id: 'receipt-title', text: 'Privacy receipt' }),
      el('p', { class: 'receipt-id', text: `${receipt.id}  ${new Date(receipt.createdAt).toLocaleString()}` }),
      // DEMO override only: the issuer of this ID is not on the trust list.
      ...(receipt.issuerTrust === 'demo-unlisted' ? [el('p', { class: 'receipt-warning', text: 'Issuer not on the trust list (demo setting)' })] : []),
      el(
        'dl',
        {},
        row('Result', `${label(receipt.outcome === 'passed' ? 'age_confirmed' : receipt.outcome)} (${receipt.source})`),
        row('What we kept', chips(receipt.storedFieldNames, 'chip'), 'kept'),
        row('Received, then discarded', chips(receipt.discardedFieldNames, 'chip redacted'), 'discarded'),
        row('Received from the verifier', chips(receipt.receivedFieldNames, 'chip')),
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
      { class: 'receipt no-data', 'aria-labelledby': 'receipt-title' },
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
