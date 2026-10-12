import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { readToken } from '../src/tickets.js';
import { buy, secret, setup, type TestApp } from './helpers.js';

const tokenOf = (path: string) => new URL(path, 'http://x').searchParams.get('t')!;
const noWallet = (app: TestApp, body: object = {}) => request(app).post('/api/orders/no-wallet').send(body);
const validate = (app: TestApp, code: string) => request(app).post('/api/gate/validate').send({ code });
const scan = (app: TestApp, body: object) => request(app).post('/api/gate/scan').send({ gateId: 'gate-a', ...body });

describe('I do not have a mobile ID', () => {
  it('issues a gate-check ticket with no verification data and no privacy receipt', async () => {
    const { app, db } = setup();
    const res = await noWallet(app).expect(200);
    expect(res.body).toMatchObject({ outcome: 'deferred', reason: 'id_check_at_gate', receipt: null });
    expect(res.body.ticket).toMatchObject({ event: 'Harbor Nights', idCheck: 'gate' });
    expect(readToken(res.body.ticket.token, secret)).toEqual({ ok: true, id: res.body.ticket.id });
    expect(res.body.order).toMatchObject({ quantity: 1, claimLinks: [] });

    const row = db.prepare('select * from tickets where id = ?').get(res.body.ticket.id) as any;
    expect(row).toMatchObject({ status: 'issued', age_verified: 0, gate_check: 1, verified_at: null, verification_ref: null });
    expect(db.prepare('select count(*) as n from privacy_receipts').get()).toEqual({ n: 0 });
  });

  it('creates guest claim links like a normal order', async () => {
    const { app, db } = setup();
    const res = await noWallet(app, { quantity: 3 }).expect(200);
    expect(res.body.order.claimLinks).toHaveLength(2);
    const statuses = (db.prepare('select status, gate_check from tickets order by rowid').all() as any[]);
    expect(statuses).toEqual([
      { status: 'issued', gate_check: 1 },
      { status: 'unclaimed', gate_check: 0 },
      { status: 'unclaimed', gate_check: 0 },
    ]);
  });

  it('validates the quantity', async () => {
    const { app, db } = setup();
    for (const quantity of [0, 99, -1, 1.5, 'two', null]) {
      const res = await noWallet(app, { quantity });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('bad_quantity');
    }
    expect(db.prepare('select count(*) as n from orders').get()).toEqual({ n: 0 });
  });

  it('tells the gate whether the age was checked online', async () => {
    const { app } = setup();
    const gate = (await noWallet(app)).body.ticket;
    const online = (await buy(app, 'pass')).body.ticket;
    expect(online.idCheck).toBe('online');
    expect((await validate(app, gate.token)).body.ticket).toEqual({ id: gate.id, event: 'Harbor Nights', idCheck: 'gate' });
    expect((await validate(app, online.token)).body.ticket).toEqual({ id: online.id, event: 'Harbor Nights', idCheck: 'online' });
  });

  it('refuses a manager override on a gate-check ticket and leaves it unused', async () => {
    const { app, db } = setup();
    const t = (await noWallet(app)).body.ticket;
    const res = await scan(app, { ticketId: t.id, method: 'override', result: 'pass', reason: 'no_mobile_id' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'id_check_required',
      message: 'This ticket has not been age-checked online. Check a physical ID or a mobile ID.',
    });
    expect(db.prepare('select status from tickets where id = ?').get(t.id)).toEqual({ status: 'issued' });
    expect(db.prepare('select count(*) as n from scans').get()).toEqual({ n: 0 });
  });

  it('admits a gate-check ticket after a physical ID check, and still allows overrides on online tickets', async () => {
    const { app, db } = setup();
    const gate = (await noWallet(app)).body.ticket;
    const pass = await scan(app, { ticketId: gate.id, method: 'physical_id_staff_recorded', result: 'pass' });
    expect(pass.body).toEqual({ result: 'pass', reason: 'age_confirmed' });
    expect(db.prepare('select status from tickets where id = ?').get(gate.id)).toEqual({ status: 'used' });

    const online = (await buy(app, 'pass')).body.ticket;
    const over = await scan(app, { ticketId: online.id, method: 'override', result: 'pass', reason: 'manager_approved' });
    expect(over.body).toEqual({ result: 'pass', reason: 'manager_approved' });
  });

  it('lets the simulated mobile check admit a gate-check ticket', async () => {
    const { app } = setup();
    const t = (await noWallet(app)).body.ticket;
    const res = await request(app).post('/api/gate/verify').send({ ticketId: t.id, scenario: 'pass' });
    expect(res.body.result).toBe('pass');
  });

  it('lets a guest claim without a mobile ID, once', async () => {
    const { app, db } = setup();
    const order = (await buy(app, 'pass', 2)).body.order;
    const token = tokenOf(order.claimLinks[0].path);

    const res = await request(app).post(`/api/claims/${token}/no-wallet`).expect(200);
    expect(res.body).toMatchObject({ outcome: 'deferred', reason: 'id_check_at_gate', receipt: null });
    expect(res.body.ticket).toMatchObject({ id: order.claimLinks[0].ticketId, idCheck: 'gate' });
    expect(readToken(res.body.ticket.token, secret)).toEqual({ ok: true, id: order.claimLinks[0].ticketId });

    const again = await request(app).post(`/api/claims/${token}/no-wallet`);
    expect(again.status).toBe(404);
    expect(again.body.error).toBe('invalid_link');
    expect((await request(app).post('/api/claims/not-a-real-token/no-wallet')).status).toBe(404);

    const row = db.prepare('select * from tickets where id = ?').get(order.claimLinks[0].ticketId) as any;
    expect(row).toMatchObject({ status: 'issued', gate_check: 1, age_verified: 0, claim_token_hash: null, claim_expires_at: null });
    expect(row.claimed_at).toBeTruthy();
    expect(db.prepare("select count(*) as n from privacy_receipts where source = 'claim'").get()).toEqual({ n: 0 });
  });

  it('closes the claim link for the wallet flow after a no-wallet claim', async () => {
    const { app } = setup();
    const order = (await buy(app, 'pass', 2)).body.order;
    const token = tokenOf(order.claimLinks[0].path);
    await request(app).post(`/api/claims/${token}/no-wallet`).expect(200);
    const start = await request(app).post(`/api/claims/${token}/start`);
    expect(start.status).toBe(404);
    expect(start.body.error).toBe('invalid_link');
  });

  it('shows how each ticket in an order is age-checked', async () => {
    const { app } = setup();
    const online = (await buy(app, 'pass', 3)).body.order;
    await request(app).post(`/api/claims/${tokenOf(online.claimLinks[0].path)}/no-wallet`).expect(200);
    const view = (await request(app).get(`/api/orders/${online.id}`).expect(200)).body;
    expect(view.tickets.map((t: any) => t.idCheck)).toEqual(['online', 'gate', null]);

    const gate = (await noWallet(app)).body.order;
    const gateView = (await request(app).get(`/api/orders/${gate.id}`).expect(200)).body;
    expect(gateView.tickets.map((t: any) => t.idCheck)).toEqual(['gate']);
  });

  it('counts the no-mobile-ID path in the metrics funnel', async () => {
    const { app } = setup();
    const a = (await noWallet(app, { quantity: 2 })).body;
    await request(app).post(`/api/claims/${tokenOf(a.order.claimLinks[0].path)}/no-wallet`).expect(200);
    await noWallet(app);
    await scan(app, { ticketId: a.ticket.id, method: 'physical_id_staff_recorded', result: 'pass' });
    const f = (await request(app).get('/api/metrics').expect(200)).body.funnel;
    expect(f).toMatchObject({ noWallet: 3, gateCheckTickets: 3, gateCheckEntered: 1 });
  });

  it('adds the gate_check column to an existing database and keeps its tickets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'b2d-'));
    try {
      const path = join(dir, 'old.db');
      const old = new Database(path);
      old.exec(`create table tickets (id text primary key, event_id text not null, order_id text, status text not null,
        age_verified integer not null default 0, verified_at text, verification_ref text, claim_token_hash text,
        claim_expires_at text, claimed_at text, created_at text not null);
        insert into tickets (id, event_id, order_id, status, created_at) values ('T-OLD', 'evt-demo', 'O-1', 'issued', '2026-01-01');`);
      old.close();
      const db = openDb(path);
      expect(db.prepare('select id, gate_check from tickets').all()).toEqual([{ id: 'T-OLD', gate_check: 0 }]);
      db.close();
      expect(() => openDb(path).close()).not.toThrow(); // second open: column exists, no second alter
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rate limits repeated no-wallet orders', async () => {
    const { app } = setup();
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await noWallet(app)).status);
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });
});
