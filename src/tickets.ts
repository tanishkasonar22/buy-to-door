import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function newTicketId(): string {
  return 'T-' + randomBytes(5).toString('hex').toUpperCase();
}

function sign(id: string, secret: string): string {
  return createHmac('sha256', secret).update(id).digest('base64url');
}

/** The value encoded in the ticket QR: "<ticketId>.<signature>". */
export function makeToken(id: string, secret: string): string {
  return `${id}.${sign(id, secret)}`;
}

export function readToken(token: string, secret: string): { ok: true; id: string } | { ok: false } {
  const dot = token.lastIndexOf('.');
  if (dot < 1) return { ok: false };
  const id = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(id, secret));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false };
  return { ok: true, id };
}
