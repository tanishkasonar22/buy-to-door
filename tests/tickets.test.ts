import { describe, expect, it } from 'vitest';
import { makeToken, newTicketId, readToken } from '../src/tickets.js';

const secret = 'a-test-secret-long-enough';

describe('signed tickets', () => {
  it('round-trips a valid token', () => {
    const id = newTicketId();
    expect(readToken(makeToken(id, secret), secret)).toEqual({ ok: true, id });
  });

  it('rejects a tampered id', () => {
    const token = makeToken('T-AAAAAAAAAA', secret).replace('T-AAAAAAAAAA', 'T-BBBBBBBBBB');
    expect(readToken(token, secret).ok).toBe(false);
  });

  it('rejects a different secret', () => {
    expect(readToken(makeToken('T-AAAAAAAAAA', secret), 'another-secret-value').ok).toBe(false);
  });

  it('rejects garbage', () => {
    expect(readToken('nonsense', secret).ok).toBe(false);
    expect(readToken('', secret).ok).toBe(false);
  });
});
