import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { CloudSdkClient } from '../src/cloudsdk.js';
import { HybridVerifier } from '../src/identity.js';
import { shortId } from '../src/sdkstats.js';
import { buy, setup } from './helpers.js';

const opts = { baseUrl: 'https://api.test/cloudsdk/playground', licenseKey: 'CS-secret-license-key', profileId: 'p-1', origin: 'https://shop.test' };
const sessionId = '0a1b2c3d-4e5f-6789-abcd-ef0123456789';

/** A real CloudSdkClient talking to a fake service, with a clock the test controls. */
function liveApp(mode: 'hybrid' | 'real' = 'hybrid', fail = false) {
  let t = 0;
  const calls: string[] = [];
  const fetchFn = (async (url: string) => {
    const path = new URL(url).pathname.replace('/cloudsdk/playground', '');
    calls.push(path);
    if (path === '/v1/setup') return Response.json({ accessToken: 'access-secret', refreshToken: 'rt_secret', expiresIn: 900 });
    if (path === '/v1/refresh') return Response.json({ accessToken: 'access-secret-2', refreshToken: 'rt_secret_2', expiresIn: 900 });
    if (fail) return Response.json({ error: 'UPSTREAM_ERROR' }, { status: 502 });
    return Response.json({ sessionId, dcRequest: { deviceRequest: 'x', encryptionInfo: 'y' } }, { status: 201 });
  }) as unknown as typeof fetch;
  const client = new CloudSdkClient(opts, fetchFn, () => t);
  const verifier = new HybridVerifier(client);
  const { app } = setup({ verifier, mode, cloud: { ...opts, client } });
  return { app, calls, advance: (ms: number) => (t += ms) };
}

const metrics = async (app: Parameters<typeof request>[0]) => (await request(app).get('/api/metrics').expect(200)).body.sdk;

describe('SDK proof panel', () => {
  it('labels mock mode and records nothing, because no SDK call is made', async () => {
    const { app } = setup();
    await buy(app, 'pass');
    expect(await metrics(app)).toEqual({
      mode: 'mock', live: false, label: 'Mock', endpoint: null,
      requestsCreated: 0, failedRequests: 0, avgResponseMs: null,
      lastRequestAt: null, lastResponseMs: null, lastSessionId: null,
      tokenTracking: false, tokenSetups: null, tokenRefreshes: null,
    });
  });

  it('counts requests, timing, the last request and token setup in hybrid mode', async () => {
    const { app, calls } = liveApp();
    await buy(app, 'pass');
    await buy(app, 'under');
    const s = await metrics(app);
    expect(s).toMatchObject({
      mode: 'hybrid', live: true, label: 'Live SDK', endpoint: 'api.test/cloudsdk/playground',
      requestsCreated: 2, failedRequests: 0, tokenTracking: true, tokenSetups: 1, tokenRefreshes: 0,
      lastSessionId: '0a1b2c3d…',
    });
    expect(s.avgResponseMs).toBeGreaterThanOrEqual(0);
    expect(s.lastResponseMs).toBeGreaterThanOrEqual(0);
    expect(Date.now() - new Date(s.lastRequestAt).getTime()).toBeLessThan(5000);
    expect(calls).toEqual(['/v1/setup', '/v1/getDocRequest', '/v1/getDocRequest']);
  });

  it('counts a token refresh once the access token is close to expiry', async () => {
    const { app, advance } = liveApp();
    await buy(app, 'pass');
    advance(880_000); // inside the 60 second margin of a 900 second token
    await buy(app, 'pass');
    expect(await metrics(app)).toMatchObject({ requestsCreated: 2, tokenSetups: 1, tokenRefreshes: 1 });
  });

  it('counts failed requests separately in real mode', async () => {
    const { app } = liveApp('real', true);
    const res = await request(app).post('/api/verify/start');
    expect(res.status).toBe(502);
    expect(await metrics(app)).toMatchObject({ mode: 'real', label: 'Live SDK', requestsCreated: 0, failedRequests: 1, tokenSetups: 1 });
  });

  it('says token activity is not tracked when the client cannot be observed', async () => {
    const client = {
      getDocRequest: async () => ({ sessionId, dcRequest: {} }),
      verifyDocRequest: async () => ({ res: false, resDetails: '{}' }),
    };
    const { app } = setup({ verifier: new HybridVerifier(client), mode: 'hybrid' });
    await buy(app, 'pass');
    expect(await metrics(app)).toMatchObject({ requestsCreated: 1, tokenTracking: false, tokenSetups: null, tokenRefreshes: null });
  });

  it('never exposes tokens, the license key or the full session ID', async () => {
    const { app } = liveApp();
    await buy(app, 'pass');
    const text = (await request(app).get('/api/metrics')).text;
    for (const secret of ['access-secret', 'rt_secret', 'CS-secret-license-key', sessionId]) expect(text).not.toContain(secret);
  });

  it('shortens session IDs to eight characters', () => {
    expect(shortId(sessionId)).toBe('0a1b2c3d…');
    expect(shortId('short')).toBe('short');
  });
});
