import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buy, claim, setup, type TestApp } from './helpers.js';

const validate = (app: TestApp, code: string) => request(app).post('/api/gate/validate').send({ code });

describe('gate validation', () => {
  it('accepts a valid issued ticket', async () => {
    const { app } = setup();
    const t = (await buy(app)).body.ticket;
    const res = await validate(app, t.token).expect(200);
    expect(res.body).toEqual({ ok: true, ticket: { id: t.id, event: 'Harbor Nights', idCheck: 'online' } });
  });

  it('rejects a forged code before any lookup', async () => {
    const { app } = setup();
    const t = (await buy(app)).body.ticket;
    const forged = t.token.replace(/.$/, (c: string) => (c === 'A' ? 'B' : 'A'));
    expect((await validate(app, forged)).body).toEqual({ ok: false, reason: 'signature_invalid' });
    expect((await validate(app, 'garbage')).body.reason).toBe('signature_invalid');
  });

  it('rejects an unknown ticket id with a valid signature shape only if it exists', async () => {
    const { app, db } = setup();
    const t = (await buy(app)).body.ticket;
    db.prepare('delete from tickets').run();
    expect((await validate(app, t.token)).body.reason).toBe('ticket_unknown');
  });

  it('rejects an unclaimed guest ticket', async () => {
    const { app, db } = setup();
    await buy(app, 'pass', 2);
    const row = db.prepare("select id from tickets where status = 'unclaimed'").get() as any;
    // An unclaimed ticket has no signed code yet, so build one the way the server would.
    const { makeToken } = await import('../src/tickets.js');
    const { secret } = await import('./helpers.js');
    const res = await validate(app, makeToken(row.id, secret));
    expect(res.body).toEqual({ ok: false, reason: 'ticket_unclaimed', ticketId: row.id });
  });

  it('requires a code', async () => {
    const { app } = setup();
    await request(app).post('/api/gate/validate').send({}).expect(400);
    await request(app).post('/api/gate/validate').send({ code: 'x'.repeat(201) }).expect(400);
  });
});

describe('gate decisions', () => {
  it('lets a simulated adult in once, then refuses a second entry', async () => {
    const { app } = setup();
    const t = (await buy(app)).body.ticket;
    const first = await request(app).post('/api/gate/verify').send({ ticketId: t.id, scenario: 'pass', durationMs: 900 }).expect(200);
    expect(first.body.result).toBe('pass');
    expect(first.body.receipt.source).toBe('gate');
    expect(first.body.receipt.storedFieldNames).toEqual([]);
    expect((await validate(app, t.token)).body.reason).toBe('ticket_used');
    await request(app).post('/api/gate/verify').send({ ticketId: t.id, scenario: 'pass' }).expect(409);
  });

  it('keeps the ticket usable after a simulated under-age result', async () => {
    const { app } = setup();
    const t = (await buy(app)).body.ticket;
    const res = await request(app).post('/api/gate/verify').send({ ticketId: t.id, scenario: 'under' }).expect(200);
    expect(res.body).toMatchObject({ result: 'fail', reason: 'under_age' });
    expect((await validate(app, t.token)).body.ok).toBe(true);
  });

  it('refuses unknown scenarios and bad input', async () => {
    const { app } = setup();
    const t = (await buy(app)).body.ticket;
    await request(app).post('/api/gate/verify').send({ ticketId: t.id, scenario: 'bogus' }).expect(400);
    await request(app).post('/api/gate/verify').send({}).expect(400);
  });

  it('only runs the simulated gate check in mock mode', async () => {
    const { app } = setup({ mode: 'real' });
    const res = await request(app).post('/api/gate/verify').send({ ticketId: 'T-X', scenario: 'pass' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('not_available');
  });

  it('records a staff-recorded physical ID pass and marks the ticket used', async () => {
    const { app, db } = setup();
    const t = (await buy(app)).body.ticket;
    const res = await request(app)
      .post('/api/gate/scan')
      .send({ ticketId: t.id, method: 'physical_id_staff_recorded', result: 'pass', gateId: 'gate-b', durationMs: 4200 })
      .expect(200);
    expect(res.body).toEqual({ result: 'pass', reason: 'age_confirmed' });
    const scan = db.prepare('select * from scans').get() as any;
    expect(scan).toMatchObject({ gate_id: 'gate-b', method: 'physical_id_staff_recorded', staff_recorded: 1, simulated: 0, duration_ms: 4200 });
    await request(app).post('/api/gate/scan').send({ ticketId: t.id, method: 'physical_id_staff_recorded', result: 'pass' }).expect(409);
  });

  it('records a refusal with a listed reason and leaves the ticket usable', async () => {
    const { app } = setup();
    const t = (await buy(app)).body.ticket;
    await request(app).post('/api/gate/scan').send({ ticketId: t.id, method: 'physical_id_staff_recorded', result: 'fail' }).expect(400);
    await request(app)
      .post('/api/gate/scan')
      .send({ ticketId: t.id, method: 'physical_id_staff_recorded', result: 'fail', reason: 'id_expired' })
      .expect(200);
    expect((await validate(app, t.token)).body.ok).toBe(true);
  });

  it('requires a listed reason for an override and does not accept free text', async () => {
    const { app } = setup();
    const t = (await buy(app)).body.ticket;
    for (const reason of [undefined, 'because I said so', 'John Smith born 1990']) {
      await request(app).post('/api/gate/scan').send({ ticketId: t.id, method: 'override', result: 'pass', reason }).expect(400);
    }
    const ok = await request(app).post('/api/gate/scan').send({ ticketId: t.id, method: 'override', result: 'pass', reason: 'no_mobile_id' }).expect(200);
    expect(ok.body.reason).toBe('no_mobile_id');
  });

  it('refuses unknown methods and unknown tickets', async () => {
    const { app } = setup();
    await request(app).post('/api/gate/scan').send({ ticketId: 'T-X', method: 'telepathy', result: 'pass' }).expect(400);
    await request(app).post('/api/gate/scan').send({ ticketId: 'T-NOPE', method: 'physical_id_staff_recorded', result: 'pass' }).expect(404);
  });

  it('walks a group order from purchase to the gate', async () => {
    const { app } = setup();
    const group = await buy(app, 'pass', 3);
    const links = group.body.order.claimLinks;
    const guest = (await claim(app, links[0].path)).body.ticket;
    const buyer = group.body.ticket;
    for (const t of [buyer, guest]) {
      expect((await validate(app, t.token)).body.ok).toBe(true);
      await request(app).post('/api/gate/verify').send({ ticketId: t.id, scenario: 'pass' }).expect(200);
    }
    const metrics = (await request(app).get('/api/metrics').expect(200)).body;
    expect(metrics.funnel).toMatchObject({ ordersPlaced: 1, ticketsTotal: 3, claimed: 1, unclaimed: 1, entered: 2 });
  });
});
