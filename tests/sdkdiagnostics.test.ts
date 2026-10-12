import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { CloudSdkClient, CloudSdkError, originForLog } from '../src/cloudsdk.js';
import { CredenceVerifier } from '../src/identity.js';
import { setup } from './helpers.js';

const LICENSE = 'CS-license-key-must-never-be-logged';
const ACCESS = 'access-token-must-never-be-logged';
const WALLET = 'wallet-response-must-never-be-logged';
const opts = { baseUrl: 'https://api.test', licenseKey: LICENSE, profileId: 'p-1', origin: 'https://shop.ngrok-free.dev/some/path?x=1' };

/** A fake Cloud SDK: setup works, getDocRequest works, verifyDocRequest answers with `verifyStatus`. */
function fakeSdk(verifyStatus = 200, verifyBody: unknown = { res: true, resDetails: JSON.stringify({ age_over_21: true }) }, seen: { path: string; headers: Record<string, string> }[] = []) {
  return (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    seen.push({ path, headers: init.headers as Record<string, string> });
    if (path === '/v1/setup') return Response.json({ accessToken: ACCESS, refreshToken: 'rt_x', expiresIn: 900 });
    if (path === '/v1/getDocRequest') return Response.json({ sessionId: 'sdk-1', dcRequest: { deviceRequest: 'x', encryptionInfo: 'y' } }, { status: 201 });
    return new Response(typeof verifyBody === 'string' ? verifyBody : JSON.stringify(verifyBody), { status: verifyStatus });
  }) as unknown as typeof fetch;
}

describe('originForLog', () => {
  it('keeps scheme and host only', () => {
    expect(originForLog('https://shop.ngrok-free.dev/some/path?x=1#y')).toBe('https://shop.ngrok-free.dev');
    expect(originForLog('https://shop.example:8443/')).toBe('https://shop.example:8443');
    expect(originForLog('')).toBe('(none)');
    expect(originForLog(undefined)).toBe('(none)');
    expect(originForLog('not a url')).toBe('(not a valid URL)');
  });
});

describe('Cloud SDK call logging', () => {
  it('real mode: sends Origin (scheme + host) on getDocRequest and verifyDocRequest too, and logs each call', async () => {
    const lines: string[] = [];
    const seen: { path: string; headers: Record<string, string> }[] = [];
    const client = new CloudSdkClient({ ...opts, originOnAllCalls: true, log: (l) => lines.push(l) }, fakeSdk(200, undefined, seen));
    await client.getDocRequest();
    await client.verifyDocRequest('sdk-1', WALLET);
    expect(seen.map((s) => [s.path, s.headers.Origin])).toEqual([
      ['/v1/setup', opts.origin], // setup and refresh keep sending the configured value exactly as before
      ['/v1/getDocRequest', 'https://shop.ngrok-free.dev'],
      ['/v1/verifyDocRequest', 'https://shop.ngrok-free.dev'],
    ]);
    expect(seen[1]!.headers.Authorization).toBe(`Bearer ${ACCESS}`);
    expect(lines).toEqual([
      '[cloudsdk] /v1/setup Origin header sent: https://shop.ngrok-free.dev',
      '[cloudsdk] /v1/getDocRequest Origin header sent: https://shop.ngrok-free.dev',
      '[cloudsdk] /v1/verifyDocRequest Origin header sent: https://shop.ngrok-free.dev',
    ]);
    for (const secret of [LICENSE, ACCESS, WALLET, '/some/path']) expect(lines.join('\n')).not.toContain(secret);
  });

  it('real mode: also sends Origin when a stale token is retried after a 401', async () => {
    const seen: { path: string; headers: Record<string, string> }[] = [];
    let first = true;
    const fetchFn = (async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      seen.push({ path, headers: init.headers as Record<string, string> });
      if (path === '/v1/setup') return Response.json({ accessToken: ACCESS, refreshToken: 'rt_x', expiresIn: 900 });
      if (first) { first = false; return Response.json({ error: 'TOKEN_EXPIRED' }, { status: 401 }); }
      return Response.json({ sessionId: 'sdk-2', dcRequest: {} }, { status: 201 });
    }) as unknown as typeof fetch;
    await new CloudSdkClient({ ...opts, originOnAllCalls: true }, fetchFn).getDocRequest();
    expect(seen.filter((s) => s.path === '/v1/getDocRequest').map((s) => s.headers.Origin)).toEqual(['https://shop.ngrok-free.dev', 'https://shop.ngrok-free.dev']);
  });

  it('hybrid (no originOnAllCalls): token calls still carry no Origin, as before', async () => {
    const lines: string[] = [];
    const seen: { path: string; headers: Record<string, string> }[] = [];
    const client = new CloudSdkClient({ ...opts, log: (l) => lines.push(l) }, fakeSdk(200, undefined, seen));
    await client.getDocRequest();
    await client.verifyDocRequest('sdk-1', WALLET);
    expect(seen.map((s) => [s.path, s.headers.Origin])).toEqual([
      ['/v1/setup', opts.origin],
      ['/v1/getDocRequest', undefined],
      ['/v1/verifyDocRequest', undefined],
    ]);
    expect(lines.slice(1)).toEqual([
      '[cloudsdk] /v1/getDocRequest Origin header sent: (none sent)',
      '[cloudsdk] /v1/verifyDocRequest Origin header sent: (none sent)',
    ]);
  });

  it('never sends an Origin it cannot reduce to scheme + host', async () => {
    const seen: { path: string; headers: Record<string, string> }[] = [];
    const client = new CloudSdkClient({ ...opts, origin: 'not a url', originOnAllCalls: true }, fakeSdk(200, undefined, seen));
    await client.getDocRequest();
    expect(seen.find((s) => s.path === '/v1/getDocRequest')!.headers.Origin).toBeUndefined();
  });

  it('logs nothing when no logger is given (hybrid and mock)', async () => {
    const client = new CloudSdkClient(opts, fakeSdk());
    await expect(client.getDocRequest()).resolves.toMatchObject({ sessionId: 'sdk-1' });
  });

  it('keeps the upstream error body, flattened and cut to 500 characters, out of the message', async () => {
    // Pretty-printed upstream JSON: real newlines and indentation that must be flattened.
    const long = '{\n  "error": "INVALID_REQUEST",\n  "message": "Validation failed: ' + 'z'.repeat(900) + '"\n}';
    const client = new CloudSdkClient(opts, fakeSdk(400, long));
    const err = await client.verifyDocRequest('sdk-1', WALLET).catch((e) => e);
    expect(err).toBeInstanceOf(CloudSdkError);
    expect(err.message).toBe('Cloud SDK /v1/verifyDocRequest returned HTTP 400');
    expect(err.code).toBe('INVALID_REQUEST');
    expect(err.upstreamBody.startsWith('{ "error": "INVALID_REQUEST", "message": "Validation failed: zzz')).toBe(true);
    expect(err.upstreamBody).toHaveLength(501); // 500 characters plus the ellipsis
    expect(err.upstreamBody).not.toContain('\n');
  });
});

describe('real mode server logs', () => {
  function realApp(verifyStatus?: number, verifyBody?: unknown) {
    const logs: string[] = [];
    const log = (...a: unknown[]) => logs.push(a.join(' '));
    const client = new CloudSdkClient({ ...opts, originOnAllCalls: true, log: (l) => logs.push(l) }, fakeSdk(verifyStatus, verifyBody));
    const { app } = setup({ verifier: new CredenceVerifier(client), mode: 'real', cloud: { licenseKey: LICENSE, profileId: 'p-1', origin: opts.origin, client }, log });
    return { app, logs };
  }

  it('puts the Cloud SDK error body in the [error] line, never the request, token or wallet answer', async () => {
    const { app, logs } = realApp(400, { error: 'INVALID_REQUEST', message: 'Validation failed: device signature invalid' });
    const start = await request(app).post('/api/verify/start').expect(200);
    const res = await request(app).post('/api/verify/confirm').send({ sessionId: start.body.sessionId, data: WALLET });
    expect(res.status).toBe(502);
    expect(res.text).not.toContain('Validation failed'); // the browser still gets only the generic message
    const line = logs.find((l) => l.startsWith('[error]'))!;
    expect(line).toBe('[error] CloudSdkError Cloud SDK /v1/verifyDocRequest returned HTTP 400 upstream body: {"error":"INVALID_REQUEST","message":"Validation failed: device signature invalid"}');
    for (const secret of [LICENSE, ACCESS, WALLET]) expect(logs.join('\n')).not.toContain(secret);
  });

  it('logs whether the browser Origin matches the Cloud SDK Origin on confirm', async () => {
    const { app, logs } = realApp();
    const confirmWith = async (origin?: string) => {
      const start = await request(app).post('/api/verify/start');
      const r = request(app).post('/api/verify/confirm');
      if (origin) r.set('Origin', origin);
      await r.send({ sessionId: start.body.sessionId, data: WALLET }).expect(200);
      return logs.filter((l) => l.startsWith('[origin]')).at(-1);
    };
    expect(await confirmWith('https://shop.ngrok-free.dev')).toBe('[origin] confirm: browser Origin https://shop.ngrok-free.dev, Cloud SDK Origin https://shop.ngrok-free.dev, match=true');
    expect(await confirmWith('https://other.ngrok-free.dev')).toBe('[origin] confirm: browser Origin https://other.ngrok-free.dev, Cloud SDK Origin https://shop.ngrok-free.dev, match=false');
    expect(await confirmWith()).toBe('[origin] confirm: browser Origin (none sent), Cloud SDK Origin https://shop.ngrok-free.dev, match=false');
  });

  it('adds no origin line outside real mode', async () => {
    const logs: string[] = [];
    const { app } = setup({ log: (...a) => logs.push(a.join(' ')) });
    const start = await request(app).post('/api/verify/start');
    await request(app).post('/api/verify/confirm').set('Origin', 'https://x.test').send({ sessionId: start.body.sessionId, data: 'mock:pass' });
    expect(logs.filter((l) => l.startsWith('[origin]'))).toEqual([]);
  });
});
