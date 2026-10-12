import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { MockVerifier } from '../src/identity.js';
import { readToken } from '../src/tickets.js';
import { buy, claim, secret, setup } from './helpers.js';

/** Holds every verification until two have started, so two requests are genuinely in flight at once. */
class BarrierVerifier extends MockVerifier {
  private waiting = 0;
  private release!: () => void;
  private barrier = new Promise<void>((resolve) => (this.release = resolve));
  async verify(sessionId: string, data: string) {
    if (++this.waiting >= 2) this.release();
    await this.barrier;
    return super.verify(sessionId, data);
  }
}

const tokenOf = (path: string) => new URL(path, 'http://x').searchParams.get('t')!;

describe('group orders and guest claim links', () => {
  it('creates one claim link per extra ticket and stores only hashes', async () => {
    const { app, db } = setup();
    const res = await buy(app, 'pass', 3);
    expect(res.body.order.quantity).toBe(3);
    expect(res.body.order.claimLinks).toHaveLength(2);
    const rows = db.prepare('select status, claim_token_hash from tickets order by rowid').all() as any[];
    expect(rows.map((r) => r.status)).toEqual(['issued', 'unclaimed', 'unclaimed']);
    const dump = JSON.stringify(rows);
    for (const l of res.body.order.claimLinks) expect(dump).not.toContain(tokenOf(l.path));
    expect(rows[1].claim_token_hash).toHaveLength(64);
  });

  it('lets a verified guest claim a ticket with their own signed code', async () => {
    const { app } = setup();
    const order = (await buy(app, 'pass', 2)).body.order;
    const res = await claim(app, order.claimLinks[0].path);
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('passed');
    expect(readToken(res.body.ticket.token, secret)).toEqual({ ok: true, id: order.claimLinks[0].ticketId });
    expect(res.body.receipt.source).toBe('claim');
    expect(res.body.receipt.storedFieldNames).toEqual(['age_verified', 'verified_at', 'verification_ref']);
  });

  it('keeps the ticket unclaimed when the guest is under age, and shows the buyer only a status', async () => {
    const { app } = setup();
    const order = (await buy(app, 'pass', 2)).body.order;
    const res = await claim(app, order.claimLinks[0].path, 'under');
    expect(res.body.outcome).toBe('failed');
    expect(res.body.ticket).toBeNull();
    expect(res.body.receipt.storedFieldNames).toEqual([]);
    const view = (await request(app).get(`/api/orders/${order.id}`).expect(200)).body;
    expect(view.tickets.map((t: any) => t.status)).toEqual(['issued', 'unclaimed']);
    expect(JSON.stringify(view)).not.toMatch(/under_age|failed|reason/);
    // The link still works afterwards, so the guest can retry.
    expect((await claim(app, order.claimLinks[0].path, 'pass')).body.outcome).toBe('passed');
  });

  it('refuses a reused link', async () => {
    const { app } = setup();
    const order = (await buy(app, 'pass', 2)).body.order;
    await claim(app, order.claimLinks[0].path);
    const token = tokenOf(order.claimLinks[0].path);
    await request(app).get(`/api/claims/${token}`).expect(404);
    await request(app).post(`/api/claims/${token}/start`).expect(404);
  });

  it('refuses a tampered or unknown link', async () => {
    const { app } = setup();
    const order = (await buy(app, 'pass', 2)).body.order;
    const token = tokenOf(order.claimLinks[0].path);
    await request(app).get(`/api/claims/${token.slice(0, -2)}xx`).expect(404);
    await request(app).get('/api/claims/not-a-real-token').expect(404);
  });

  it('refuses an expired link', async () => {
    const { app, db } = setup();
    const order = (await buy(app, 'pass', 2)).body.order;
    db.prepare("update tickets set claim_expires_at = '2000-01-01T00:00:00.000Z' where status = 'unclaimed'").run();
    await request(app).get(`/api/claims/${tokenOf(order.claimLinks[0].path)}`).expect(404);
    const view = (await request(app).get(`/api/orders/${order.id}`)).body;
    expect(view.tickets[1].status).toBe('expired');
  });

  it('honours the configured expiry window', async () => {
    const { app, db } = setup({ claimTtlHours: 1 });
    await buy(app, 'pass', 2);
    const row = db.prepare("select claim_expires_at from tickets where status = 'unclaimed'").get() as any;
    const hours = (Date.parse(row.claim_expires_at) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(0.9);
    expect(hours).toBeLessThanOrEqual(1);
  });

  it('regenerating a link invalidates the old one', async () => {
    const { app } = setup();
    const order = (await buy(app, 'pass', 2)).body.order;
    const oldToken = tokenOf(order.claimLinks[0].path);
    const res = await request(app).post(`/api/orders/${order.id}/tickets/${order.claimLinks[0].ticketId}/link`).expect(200);
    const newToken = tokenOf(res.body.path);
    expect(newToken).not.toBe(oldToken);
    await request(app).get(`/api/claims/${oldToken}`).expect(404);
    await request(app).get(`/api/claims/${newToken}`).expect(200);
  });

  it('will not regenerate a link for a claimed ticket or the wrong order', async () => {
    const { app } = setup();
    const a = (await buy(app, 'pass', 2)).body.order;
    const b = (await buy(app, 'pass', 2)).body.order;
    await claim(app, a.claimLinks[0].path);
    await request(app).post(`/api/orders/${a.id}/tickets/${a.claimLinks[0].ticketId}/link`).expect(409);
    await request(app).post(`/api/orders/${a.id}/tickets/${b.claimLinks[0].ticketId}/link`).expect(404);
  });

  it('gives exactly one winner when two claims race on one link', async () => {
    const verifier = new BarrierVerifier('age_over_21');
    const { app, db } = setup({ verifier });
    // Buying also verifies, so release the barrier for the purchase first.
    (verifier as any).release();
    const order = (await buy(app, 'pass', 2)).body.order;
    (verifier as any).waiting = 0;
    (verifier as any).barrier = new Promise<void>((resolve) => ((verifier as any).release = resolve));
    const token = tokenOf(order.claimLinks[0].path);
    const [s1, s2] = await Promise.all([
      request(app).post(`/api/claims/${token}/start`),
      request(app).post(`/api/claims/${token}/start`),
    ]);
    const [r1, r2] = await Promise.all([
      request(app).post(`/api/claims/${token}/confirm`).send({ sessionId: s1.body.sessionId, data: 'mock:pass' }),
      request(app).post(`/api/claims/${token}/confirm`).send({ sessionId: s2.body.sessionId, data: 'mock:pass' }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    const loser = r1.status === 409 ? r1 : r2;
    expect(loser.body.receipt.storedFieldNames).toEqual([]);
    expect((db.prepare("select count(*) as n from tickets where claimed_at is not null").get() as any).n).toBe(1);
  });

  it('does not accept a session started for a different ticket', async () => {
    const { app } = setup();
    const order = (await buy(app, 'pass', 3)).body.order;
    const [one, two] = order.claimLinks.map((l: any) => tokenOf(l.path));
    const start = await request(app).post(`/api/claims/${one}/start`).expect(200);
    const res = await request(app).post(`/api/claims/${two}/confirm`).send({ sessionId: start.body.sessionId, data: 'mock:pass' });
    expect(res.status).toBe(400);
  });

  it('does not accept a checkout session for a claim', async () => {
    const { app } = setup();
    const order = (await buy(app, 'pass', 2)).body.order;
    const token = tokenOf(order.claimLinks[0].path);
    const start = await request(app).post('/api/verify/start').expect(200);
    const res = await request(app).post(`/api/claims/${token}/confirm`).send({ sessionId: start.body.sessionId, data: 'mock:pass' });
    expect(res.status).toBe(400);
  });

  it('rate limits repeated attempts on one link', async () => {
    const { app } = setup();
    const order = (await buy(app, 'pass', 2)).body.order;
    const token = tokenOf(order.claimLinks[0].path);
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await request(app).post(`/api/claims/${token}/start`)).status);
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses[11]).toBe(429);
  });

  it('reports 404 for an unknown order', async () => {
    const { app } = setup();
    await request(app).get('/api/orders/O-NOPE').expect(404);
  });
});
