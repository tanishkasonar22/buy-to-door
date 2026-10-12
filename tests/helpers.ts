import request from 'supertest';
import { createApp, type AppDeps } from '../src/app.js';
import { openDb } from '../src/db.js';
import { MockVerifier } from '../src/identity.js';

export const secret = 'a-test-secret-long-enough';

export function setup(overrides: Partial<AppDeps> = {}) {
  const db = openDb(':memory:');
  const app = createApp({
    verifier: new MockVerifier('age_over_21'),
    db,
    mode: 'mock',
    ticketSecret: secret,
    ageClaimKey: 'age_over_21',
    ...overrides,
  });
  return { db, app };
}

export type TestApp = ReturnType<typeof setup>['app'];

export async function buy(app: TestApp, scenario = 'pass', quantity?: number) {
  const start = await request(app).post('/api/verify/start').expect(200);
  return request(app)
    .post('/api/verify/confirm')
    .send({ sessionId: start.body.sessionId, data: `mock:${scenario}`, ...(quantity ? { quantity } : {}) });
}

export async function claim(app: TestApp, path: string, scenario = 'pass') {
  const token = new URL(path, 'http://x').searchParams.get('t')!;
  const start = await request(app).post(`/api/claims/${token}/start`).expect(200);
  return request(app).post(`/api/claims/${token}/confirm`).send({ sessionId: start.body.sessionId, data: `mock:${scenario}` });
}
