import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { HybridVerifier } from '../src/identity.js';
import { buy, claim, setup } from './helpers.js';

/** Stands in for the Credence Cloud SDK and records every call that reaches it. */
function fakeSdk() {
  const calls: string[] = [];
  return {
    calls,
    client: {
      async getDocRequest() {
        calls.push('getDocRequest');
        return { sessionId: `sdk-${calls.length}`, dcRequest: { real: true } };
      },
      async verifyDocRequest(_id: string, _data: string) {
        calls.push('verifyDocRequest');
        return { res: false, resDetails: '{}' };
      },
    },
  };
}

function hybridApp() {
  const sdk = fakeSdk();
  const verifier = new HybridVerifier(sdk.client);
  return { sdk, verifier, ...setup({ verifier, mode: 'hybrid' }) };
}

describe('hybrid mode', () => {
  it('creates every checkout request through the Cloud SDK and judges the simulated answer locally', async () => {
    const { app, sdk } = hybridApp();
    const res = await buy(app, 'pass', 2);
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('passed');
    expect(sdk.calls).toEqual(['getDocRequest']);
  });

  it('makes a real SDK request for each guest claim too', async () => {
    const { app, sdk } = hybridApp();
    const order = await buy(app, 'pass', 2);
    await claim(app, order.body.order.claimLinks[0].path, 'pass');
    expect(sdk.calls).toEqual(['getDocRequest', 'getDocRequest']);
  });

  it('sends a non-simulated answer to the real SDK verify call', async () => {
    const sdk = fakeSdk();
    const verifier = new HybridVerifier(sdk.client);
    const started = await verifier.start();
    await verifier.verify(started.sessionId, 'real-wallet-response');
    expect(sdk.calls).toEqual(['getDocRequest', 'verifyDocRequest']);
  });

  it('keeps the data firewall in hybrid mode', async () => {
    const { app, db } = hybridApp();
    await buy(app, 'pass');
    const dump = JSON.stringify(db.prepare('select * from tickets').all()) + JSON.stringify(db.prepare('select * from privacy_receipts').all());
    expect(dump).not.toMatch(/Testperson|Examplesurname|1990-01-01|AAAA/);
  });

  it('reports live SDK request count and mode on the metrics endpoint', async () => {
    const { app } = hybridApp();
    await buy(app, 'pass');
    await buy(app, 'under');
    const m = await request(app).get('/api/metrics').expect(200);
    expect(m.body.sdk).toMatchObject({ mode: 'hybrid', live: true, label: 'Live SDK', requestsCreated: 2 });
  });

  it('shows zero live requests in mock mode', async () => {
    const { app } = setup();
    const m = await request(app).get('/api/metrics').expect(200);
    expect(m.body.sdk).toMatchObject({ mode: 'mock', live: false, label: 'Mock', requestsCreated: 0 });
  });

  it('allows the simulated gate check, which also makes a real SDK request', async () => {
    const { app, sdk } = hybridApp();
    const bought = await buy(app, 'pass');
    sdk.calls.length = 0;
    const res = await request(app).post('/api/gate/verify').send({ ticketId: bought.body.ticket.id, scenario: 'pass' });
    expect(res.status).toBe(200);
    expect(sdk.calls).toEqual(['getDocRequest']);
  });

  it('requires the readiness token in hybrid mode', async () => {
    const { app } = hybridApp();
    const res = await request(app).get('/api/readiness');
    expect(res.status).toBe(403);
  });
});
