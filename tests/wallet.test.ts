import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buy, setup, type TestApp } from './helpers.js';

const tokenOf = (path: string) => new URL(path, 'http://x').searchParams.get('t')!;

async function startCheckout(app: TestApp) {
  const res = await request(app).post('/api/verify/start').expect(200);
  return res.body.sessionId as string;
}

const respond = (app: TestApp, sessionId: string, body: object) =>
  request(app).post(`/api/wallet/respond/${sessionId}`).send(body);

const confirm = (app: TestApp, sessionId: string, quantity?: number) =>
  request(app).post('/api/verify/confirm').send({ sessionId, data: 'wallet', ...(quantity ? { quantity } : {}) });

describe('separate simulated wallet', () => {
  it('shows the pending request to the wallet page without consuming it', async () => {
    const { app } = setup();
    const id = await startCheckout(app);
    const req = await request(app).get(`/api/wallet/request/${id}`).expect(200);
    expect(req.body).toEqual({ event: 'Harbor Nights', question: 'Are you 21 or older?', purpose: 'checkout', answered: false });
    expect((await request(app).get(`/api/verify/status/${id}`)).body).toEqual({ status: 'pending' });
  });

  it('issues a ticket after the wallet shares and the shop confirms with data "wallet"', async () => {
    const { app } = setup();
    const id = await startCheckout(app);
    await respond(app, id, { action: 'share', scenario: 'pass' }).expect(200, { ok: true });
    expect((await request(app).get(`/api/verify/status/${id}`)).body).toEqual({ status: 'shared' });
    const res = await confirm(app, id, 2);
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('passed');
    expect(res.body.ticket.id).toBeTruthy();
    expect(res.body.order.claimLinks).toHaveLength(1);
    // The session and the stored answer are both gone afterwards.
    expect((await request(app).get(`/api/verify/status/${id}`)).body).toEqual({ status: 'unknown' });
  });

  it('defaults the scenario to pass', async () => {
    const { app } = setup();
    const id = await startCheckout(app);
    await respond(app, id, { action: 'share' }).expect(200);
    expect((await confirm(app, id)).body.outcome).toBe('passed');
  });

  it('refuses an under-age test credential and issues no ticket', async () => {
    const { app, db } = setup();
    const id = await startCheckout(app);
    await respond(app, id, { action: 'share', scenario: 'under' }).expect(200);
    const res = await confirm(app, id);
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('failed');
    expect(res.body.reason).toBe('under_age');
    expect(res.body.ticket).toBeNull();
    expect(db.prepare('select count(*) as n from tickets').get()).toEqual({ n: 0 });
  });

  it('reports a decline and will not confirm it', async () => {
    const { app } = setup();
    const id = await startCheckout(app);
    await respond(app, id, { action: 'decline' }).expect(200);
    expect((await request(app).get(`/api/verify/status/${id}`)).body).toEqual({ status: 'declined' });
    const res = await confirm(app, id);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('no_wallet_answer');
  });

  it('rejects a confirm before the wallet answers, without consuming the session', async () => {
    const { app } = setup();
    const id = await startCheckout(app);
    const early = await confirm(app, id);
    expect(early.status).toBe(400);
    expect(early.body).toEqual({ error: 'no_wallet_answer', message: 'The wallet has not shared an answer yet.' });
    expect((await request(app).get(`/api/verify/status/${id}`)).body).toEqual({ status: 'pending' });
    await respond(app, id, { action: 'share', scenario: 'pass' }).expect(200);
    const later = await confirm(app, id);
    expect(later.status).toBe(200);
    expect(later.body.outcome).toBe('passed');
  });

  it('accepts only one answer per request', async () => {
    const { app } = setup();
    const id = await startCheckout(app);
    await respond(app, id, { action: 'share', scenario: 'pass' }).expect(200);
    const again = await respond(app, id, { action: 'decline' });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('already_answered');
    expect((await request(app).get(`/api/wallet/request/${id}`)).body.answered).toBe(true);
  });

  it('returns 404 for unknown sessions and 400 for a bad action or scenario', async () => {
    const { app } = setup();
    await request(app).get('/api/wallet/request/nope').expect(404, { error: 'unknown_session' });
    await respond(app, 'nope', { action: 'share' }).expect(404);
    expect((await request(app).get('/api/verify/status/nope')).body).toEqual({ status: 'unknown' });

    const id = await startCheckout(app);
    expect((await respond(app, id, { action: 'maybe' })).status).toBe(400);
    expect((await respond(app, id, { action: 'share', scenario: 'adult' })).status).toBe(400);
    expect((await respond(app, id, {})).status).toBe(400);
    // A rejected answer leaves the request open.
    expect((await request(app).get(`/api/verify/status/${id}`)).body).toEqual({ status: 'pending' });
  });

  it('never returns the answer data from the status endpoint', async () => {
    const { app } = setup();
    for (const scenario of ['pass', 'under', 'invalid', 'noage']) {
      const id = await startCheckout(app);
      await respond(app, id, { action: 'share', scenario }).expect(200);
      const res = await request(app).get(`/api/verify/status/${id}`).expect(200);
      expect(res.body).toEqual({ status: 'shared' });
      expect(res.text).not.toContain('mock:');
      expect(res.text).not.toContain(scenario);
    }
  });

  it('works for guest claims through the same wallet', async () => {
    const { app } = setup();
    const order = (await buy(app, 'pass', 2)).body.order;
    const token = tokenOf(order.claimLinks[0].path);
    const start = await request(app).post(`/api/claims/${token}/start`).expect(200);
    const id = start.body.sessionId;
    expect((await request(app).get(`/api/wallet/request/${id}`)).body.purpose).toBe('claim');

    const early = await request(app).post(`/api/claims/${token}/confirm`).send({ sessionId: id, data: 'wallet' });
    expect(early.status).toBe(400);
    expect(early.body.error).toBe('no_wallet_answer');

    await respond(app, id, { action: 'share', scenario: 'pass' }).expect(200);
    const res = await request(app).post(`/api/claims/${token}/confirm`).send({ sessionId: id, data: 'wallet' });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('passed');
    expect(res.body.ticket.id).toBe(order.claimLinks[0].ticketId);
  });

  it('turns all wallet endpoints off in real mode', async () => {
    const { app } = setup({ mode: 'real' });
    const id = await startCheckout(app);
    await request(app).get(`/api/wallet/request/${id}`).expect(404, { error: 'not_available' });
    await respond(app, id, { action: 'share', scenario: 'pass' }).expect(404, { error: 'not_available' });
    await request(app).get(`/api/verify/status/${id}`).expect(404, { error: 'not_available' });
  });
});
