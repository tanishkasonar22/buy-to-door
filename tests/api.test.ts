import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { allColumns } from '../src/db.js';
import { readToken } from '../src/tickets.js';
import { buy, claim, secret, setup } from './helpers.js';

describe('checkout API', () => {
  it('issues a signed ticket, an order and a receipt for a verified adult', async () => {
    const { app } = setup();
    const res = await buy(app);
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('passed');
    expect(readToken(res.body.ticket.token, secret)).toEqual({ ok: true, id: res.body.ticket.id });
    expect(res.body.order.quantity).toBe(1);
    expect(res.body.order.claimLinks).toEqual([]);
    expect(res.body.receipt.source).toBe('checkout');
    expect(res.body.receipt.storedFieldNames).toEqual(['age_verified', 'verified_at', 'verification_ref']);
    expect(res.body.receipt.discardedFieldNames).toContain('given_name');
    const fetched = await request(app).get(`/api/receipts/${res.body.receipt.id}`).expect(200);
    expect(fetched.body.id).toBe(res.body.receipt.id);
  });

  it('issues no ticket and keeps nothing for an under-age result', async () => {
    const { app, db } = setup();
    const res = await buy(app, 'under');
    expect(res.body.outcome).toBe('failed');
    expect(res.body.ticket).toBeNull();
    expect(res.body.order).toBeNull();
    expect(res.body.receipt.storedFieldNames).toEqual([]);
    expect((db.prepare('select count(*) as n from tickets').get() as any).n).toBe(0);
    expect((db.prepare('select count(*) as n from orders').get() as any).n).toBe(0);
  });

  it('issues no ticket when the wallet is cancelled', async () => {
    const { app } = setup();
    const res = await buy(app, 'cancel');
    expect(res.body.outcome).toBe('cancelled');
    expect(res.body.ticket).toBeNull();
  });

  it('issues no ticket when the age field is missing', async () => {
    const { app } = setup();
    const res = await buy(app, 'noage');
    expect(res.body.outcome).toBe('indeterminate');
    expect(res.body.ticket).toBeNull();
  });

  it('refuses to reuse a verification session', async () => {
    const { app } = setup();
    const start = await request(app).post('/api/verify/start').expect(200);
    const body = { sessionId: start.body.sessionId, data: 'mock:pass' };
    await request(app).post('/api/verify/confirm').send(body).expect(200);
    await request(app).post('/api/verify/confirm').send(body).expect(400);
  });

  it('refuses an unknown session and a malformed request', async () => {
    const { app } = setup();
    await request(app).post('/api/verify/confirm').send({ sessionId: 'nope', data: 'mock:pass' }).expect(400);
    await request(app).post('/api/verify/confirm').send({}).expect(400);
  });

  it('rejects a bad ticket quantity', async () => {
    const { app } = setup();
    for (const q of [0, 7, 2.5, 'lots']) {
      const start = await request(app).post('/api/verify/start').expect(200);
      const res = await request(app)
        .post('/api/verify/confirm')
        .send({ sessionId: start.body.sessionId, data: 'mock:pass', quantity: q });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('bad_quantity');
    }
  });

  it('returns a generic error when the verifier throws', async () => {
    const { app } = setup();
    const start = await request(app).post('/api/verify/start').expect(200);
    const res = await request(app)
      .post('/api/verify/confirm')
      .send({ sessionId: start.body.sessionId, data: 'mock:bogus-scenario' });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('verifier_unavailable');
    expect(JSON.stringify(res.body)).not.toContain('bogus');
  });

  it('serves a QR code as SVG and rejects empty or oversized text', async () => {
    const { app } = setup();
    const ok = await request(app)
      .get('/api/qr.svg')
      .query({ text: 'T-ABC.def' })
      .buffer(true)
      .parse((res, cb) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => cb(null, data));
      })
      .expect(200);
    expect(ok.headers['content-type']).toContain('image/svg+xml');
    expect(String(ok.body)).toContain('<svg');
    await request(app).get('/api/qr.svg').expect(400);
    await request(app).get('/api/qr.svg').query({ text: 'x'.repeat(301) }).expect(400);
  });
});

describe('privacy guarantees', () => {
  it('never writes the verifier personal data anywhere in the database', async () => {
    const { app, db } = setup();
    const group = await buy(app, 'pass', 3);
    await buy(app, 'under');
    await claim(app, group.body.order.claimLinks[0].path, 'pass');
    await claim(app, group.body.order.claimLinks[1].path, 'under');
    const dump = JSON.stringify(Object.keys(allColumns(db)).map((t) => db.prepare(`select * from ${t}`).all()));
    for (const value of ['Testperson', 'Examplesurname', '1990-01-01', 'AAAA']) {
      expect(dump).not.toContain(value);
    }
  });

  it('keeps every table column on the allowlist', () => {
    const { db } = setup();
    expect(allColumns(db)).toEqual({
      orders: ['id', 'event_id', 'quantity', 'created_at'],
      tickets: [
        'id', 'event_id', 'order_id', 'status', 'age_verified', 'verified_at', 'verification_ref',
        'claim_token_hash', 'claim_expires_at', 'claimed_at', 'created_at', 'gate_check',
      ],
      privacy_receipts: [
        'id', 'ticket_id', 'verification_ref', 'source', 'outcome',
        'received_field_names', 'stored_field_names', 'discarded_field_names', 'created_at', 'issuer_trust',
      ],
      checkout_events: ['id', 'session_id', 'step', 'reason', 'ts'],
      scans: [
        'id', 'ticket_id', 'gate_id', 'method', 'result', 'reason', 'duration_ms',
        'simulated', 'staff_recorded', 'receipt_id', 'ts',
      ],
    });
  });

  it('computes the privacy summary live', async () => {
    const { app } = setup();
    await buy(app);
    const res = await request(app).get('/api/privacy/summary').expect(200);
    expect(res.body.verifications.passed).toBe(1);
    expect(res.body.discardedFieldNames).toContain('birth_date');
    expect(res.body.personalDataShapedColumns).toEqual([]);
  });
});
