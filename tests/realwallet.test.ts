import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { allColumns } from '../src/db.js';
import { applyFirewall } from '../src/firewall.js';
import { CredenceVerifier, type RawVerification } from '../src/identity.js';
import { redactForLog } from '../src/inspect.js';
import { setup } from './helpers.js';

// A portrait big and distinctive enough that any leak is easy to spot.
const PORTRAIT = 'UE9SVFJBSVQtU0VDUkVU' + 'Qk'.repeat(4000);
const NS = 'org.iso.18013.5.1';

/** Stands in for the Cloud SDK in REAL mode: no network, a canned verifyDocRequest answer. */
function realApp(answer: RawVerification & { message?: string }, extra: { inspect?: boolean } = {}) {
  const calls: { sessionId: string; data: string }[] = [];
  const client = {
    async getDocRequest() {
      return { sessionId: `sdk-${calls.length + 1}`, dcRequest: { deviceRequest: 'device-request', encryptionInfo: 'enc' } };
    },
    async verifyDocRequest(sessionId: string, data: string) {
      calls.push({ sessionId, data });
      return answer;
    },
  };
  const logs: string[] = [];
  const { app, db } = setup({
    verifier: new CredenceVerifier(client as any),
    mode: 'real',
    inspect: extra.inspect,
    log: (...a) => logs.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')),
  });
  return { app, db, calls, logs };
}

const ok = (details: unknown): RawVerification => ({ res: true, resDetails: JSON.stringify(details) });

/** The browser sends whatever the wallet returned; the server passes it to verifyDocRequest unchanged. */
async function buyReal(app: ReturnType<typeof realApp>['app'], quantity = 1) {
  const start = await request(app).post('/api/verify/start').expect(200);
  expect(start.body.dcRequest.deviceRequest).toBe('device-request');
  return request(app).post('/api/verify/confirm').send({ sessionId: start.body.sessionId, data: 'wallet-response-from-browser', quantity });
}

describe('real mode: reading the age answer', () => {
  it('passes on age_over_21: true and sends {sessionId, data} to verifyDocRequest', async () => {
    const { app, calls } = realApp(ok({ age_over_21: true, portrait: PORTRAIT }));
    const res = await buyReal(app);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ outcome: 'passed', reason: 'age_confirmed' });
    expect(res.body.ticket.idCheck).toBe('online');
    expect(calls).toEqual([{ sessionId: 'sdk-1', data: 'wallet-response-from-browser' }]);
  });

  it('refuses on age_over_21: false', async () => {
    const { app, db } = realApp(ok({ age_over_21: false, portrait: PORTRAIT }));
    const res = await buyReal(app);
    expect(res.body).toMatchObject({ outcome: 'failed', reason: 'under_age', ticket: null });
    expect(db.prepare('select count(*) as n from tickets').get()).toEqual({ n: 0 });
  });

  it('is indeterminate when the age claim is missing', async () => {
    const { app } = realApp(ok({ portrait: PORTRAIT }));
    const res = await buyReal(app);
    expect(res.body).toMatchObject({ outcome: 'indeterminate', reason: 'age_claim_missing', ticket: null });
  });

  it('finds the claim nested under a namespace inside documents', async () => {
    const { app } = realApp(ok({ documents: [{ docType: 'org.iso.18013.5.1.mDL', [NS]: { age_over_21: true, portrait: PORTRAIT } }] }));
    const res = await buyReal(app);
    expect(res.body).toMatchObject({ outcome: 'passed', reason: 'age_confirmed' });
    expect(res.body.receipt.receivedFieldNames).toEqual(['age_over_21', 'portrait']);
    expect(res.body.receipt.discardedFieldNames).toEqual(['portrait']);
  });

  it('finds the claim in an elementIdentifier / elementValue list', async () => {
    const { app } = realApp(ok({ [NS]: [{ elementIdentifier: 'portrait', elementValue: PORTRAIT }, { elementIdentifier: 'age_over_21', elementValue: true }] }));
    const res = await buyReal(app);
    expect(res.body).toMatchObject({ outcome: 'passed', reason: 'age_confirmed' });
    expect(res.body.receipt.discardedFieldNames).toEqual(['portrait']);
  });

  it('does NOT pass the string "true"', async () => {
    const { app, db } = realApp(ok({ [NS]: { age_over_21: 'true', portrait: PORTRAIT } }));
    const res = await buyReal(app);
    expect(res.body.outcome).not.toBe('passed');
    expect(res.body).toMatchObject({ outcome: 'failed', reason: 'unreadable_response', ticket: null });
    expect(db.prepare('select count(*) as n from tickets').get()).toEqual({ n: 0 });
  });

  it('reports cancelled: true as a cancelled wallet, checked before anything else', async () => {
    const { app } = realApp({ res: true, resDetails: JSON.stringify({ age_over_21: true }), cancelled: true, message: 'User cancelled' });
    const res = await buyReal(app);
    expect(res.body).toMatchObject({ outcome: 'cancelled', reason: 'wallet_cancelled', ticket: null });
  });

  it('treats res: false with an error description as a failed verification', async () => {
    const { app } = realApp({ res: false, resDetails: 'Issuer certificate not trusted' });
    const res = await buyReal(app);
    expect(res.body).toMatchObject({ outcome: 'failed', reason: 'verification_failed', ticket: null });
  });

  it('works for a guest claim in real mode too', async () => {
    const { app } = realApp(ok({ [NS]: { age_over_21: true, portrait: PORTRAIT } }));
    const order = (await buyReal(app, 2)).body.order;
    const token = new URL(order.claimLinks[0].path, 'http://x').searchParams.get('t')!;
    const start = await request(app).post(`/api/claims/${token}/start`).expect(200);
    const res = await request(app).post(`/api/claims/${token}/confirm`).send({ sessionId: start.body.sessionId, data: 'guest-wallet-response' });
    expect(res.body).toMatchObject({ outcome: 'passed', ticket: { id: order.claimLinks[0].ticketId } });
  });
});

describe('real mode: the portrait never leaves the firewall', () => {
  it('is not stored, returned, put in the receipt, or logged (even with DEV_INSPECT on)', async () => {
    const { app, db, logs } = realApp(ok({ documents: [{ [NS]: { age_over_21: true, portrait: PORTRAIT } }] }), { inspect: true });
    const bought = await buyReal(app, 2);
    expect(bought.body.outcome).toBe('passed');

    const token = new URL(bought.body.order.claimLinks[0].path, 'http://x').searchParams.get('t')!;
    const start = await request(app).post(`/api/claims/${token}/start`);
    const claimed = await request(app).post(`/api/claims/${token}/confirm`).send({ sessionId: start.body.sessionId, data: 'guest' });

    const receipt = await request(app).get(`/api/receipts/${bought.body.receipt.id}`).expect(200);
    const others = await Promise.all(['/api/metrics', '/api/privacy/summary', '/api/export/audit.csv', `/api/orders/${bought.body.order.id}`].map((p) => request(app).get(p)));
    const rows = JSON.stringify(Object.keys(allColumns(db)).map((t) => db.prepare(`select * from ${t}`).all()));

    const marker = PORTRAIT.slice(0, 20);
    for (const text of [rows, bought.text, claimed.text, receipt.text, ...others.map((r) => r.text), logs.join('\n')]) {
      expect(text).not.toContain(marker);
    }
    // The receipt names the portrait as discarded, as a field NAME only.
    expect(receipt.body.discardedFieldNames).toEqual(['portrait']);
    expect(receipt.body.storedFieldNames).not.toContain('portrait');
    // DEV_INSPECT prints the raw response with the portrait replaced by its size.
    const inspectLine = logs.find((l) => l.startsWith('[inspect] raw verifier response'))!;
    expect(inspectLine).toContain(`[portrait omitted, ${Buffer.byteLength(PORTRAIT)} bytes]`);
    expect(inspectLine).toContain('"age_over_21":true');
  });

  it('redacts portraits in every shape before printing', () => {
    const shapes: RawVerification[] = [
      ok({ portrait: PORTRAIT }),
      ok({ documents: [{ [NS]: { Portrait: PORTRAIT } }] }),
      ok({ [NS]: [{ elementIdentifier: 'portrait', elementValue: PORTRAIT }] }),
      ok({ portrait: [1, 2, 3, 4] }),
      { res: false, resDetails: PORTRAIT }, // a non-JSON blob is never printed whole
    ];
    for (const raw of shapes) {
      const line = redactForLog(raw);
      expect(line).not.toContain(PORTRAIT.slice(0, 20));
      expect(line.length).toBeLessThan(4100);
    }
    expect(redactForLog(ok({ portrait: [1, 2, 3, 4] }))).toContain('[portrait omitted, 4 bytes]');
  });
});

describe('firewall: tolerant but strict age reading', () => {
  const run = (details: unknown, key = 'age_over_21') => applyFirewall(ok(details), key);

  it('accepts only a real boolean', () => {
    for (const v of ['true', 1, 'yes', {}, [true]]) {
      expect(run({ age_over_21: v }).outcome).not.toBe('passed');
    }
    expect(run({ age_over_21: true }).outcome).toBe('passed');
    expect(run({ age_over_21: false }).reason).toBe('under_age');
    expect(run({ age_over_21: null }).reason).toBe('age_claim_missing');
  });

  it('never passes when two copies of the claim disagree', () => {
    expect(run({ a: { age_over_21: true }, b: { age_over_21: false } }).reason).toBe('under_age');
    expect(run({ a: { age_over_21: true }, b: { age_over_21: 'true' } }).outcome).toBe('failed');
  });

  it('uses the configured key, and age_over_21 when the key is blank', () => {
    expect(run({ age_over_18: true }, 'age_over_18').outcome).toBe('passed');
    expect(run({ age_over_21: true }, 'age_over_18').reason).toBe('age_claim_missing');
    expect(run({ age_over_21: true }, '').outcome).toBe('passed');
    expect(run({ age_over_21: true }, '   ').outcome).toBe('passed');
  });

  it('still fails when an authentication check is false', () => {
    expect(run({ documents: [{ [NS]: { age_over_21: true }, authentication: { issuerRecognized: false } }] }).reason).toBe('authentication_checks_failed');
  });

  it('carries field names only, never values', () => {
    const text = JSON.stringify(run({ [NS]: { age_over_21: true, portrait: PORTRAIT } }));
    expect(text).not.toContain(PORTRAIT.slice(0, 20));
  });
});
