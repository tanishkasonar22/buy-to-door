import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { CloudSdkError } from '../src/cloudsdk.js';
import { checkOrigin, explainSdkError, runReadiness, type ReadinessClient } from '../src/readiness.js';
import { setup } from './helpers.js';

const goodClient = (): ReadinessClient => ({
  ensureToken: async () => {},
  getDocRequest: async () => ({ sessionId: 's-1', dcRequest: { deviceRequest: 'abc', encryptionInfo: 'def' } }),
});

const base = {
  mode: 'real' as const,
  ticketSecret: 'a-test-secret-long-enough',
  licenseKey: 'CS-abcdef123456',
  profileId: '123e4567-e89b-12d3-a456-426614174000',
  origin: 'https://demo.example.dev',
};

const byId = (checks: any[], id: string) => checks.find((c) => c.id === id)!;

describe('origin check', () => {
  it('accepts a public https origin', () => {
    expect(checkOrigin('https://demo.example.dev').ok).toBe(true);
    expect(checkOrigin('https://demo.example.dev:8443').ok).toBe(true);
    expect(checkOrigin('https://demo.example.dev/').ok).toBe(true);
  });
  it('rejects the cases the key page says are rejected', () => {
    expect(checkOrigin('http://demo.example.dev').ok).toBe(false);
    expect(checkOrigin('https://localhost:3000').ok).toBe(false);
    expect(checkOrigin('https://127.0.0.1').ok).toBe(false);
    expect(checkOrigin('https://[::1]').ok).toBe(false);
    expect(checkOrigin('').ok).toBe(false);
    expect(checkOrigin('not a url').ok).toBe(false);
  });
  it('rejects a path on the origin', () => {
    const r = checkOrigin('https://demo.example.dev/shop');
    expect(r.ok).toBe(false);
    expect(r.fix).toContain('https://demo.example.dev');
  });
});

describe('error explanations', () => {
  it('explains an origin mismatch', () => {
    const x = explainSdkError(new CloudSdkError('x', 403, 'DOMAIN_MISMATCH'));
    expect(x.fix).toContain('allowed-origins');
  });
  it('explains auth, missing endpoint, rate limit and network errors differently', () => {
    expect(explainSdkError(new CloudSdkError('x', 401)).detail).toContain('401');
    expect(explainSdkError(new CloudSdkError('x', 404)).fix).toContain('CLOUDSDK_BASE_URL');
    expect(explainSdkError(new CloudSdkError('x', 429)).detail).toContain('429');
    expect(explainSdkError(new TypeError('fetch failed')).detail).toContain('did not reach');
  });
});

describe('readiness run', () => {
  it('skips the live checks in mock mode', async () => {
    const checks = await runReadiness({ ...base, mode: 'mock' });
    expect(byId(checks, 'secret').status).toBe('pass');
    for (const id of ['key', 'profile', 'origin', 'setup', 'request']) expect(byId(checks, id).status).toBe('skipped');
  });

  it('passes every check when the service answers', async () => {
    const checks = await runReadiness({ ...base, client: goodClient() });
    expect(checks.filter((c) => c.status === 'fail')).toEqual([]);
    expect(byId(checks, 'setup').status).toBe('pass');
    expect(byId(checks, 'request').status).toBe('pass');
  });

  it('fails the request check when the response has no deviceRequest', async () => {
    const client: ReadinessClient = { ensureToken: async () => {}, getDocRequest: async () => ({ sessionId: 's', dcRequest: { x: 1 } }) };
    expect(byId(await runReadiness({ ...base, client }), 'request').status).toBe('fail');
  });

  it('fails when no origin is set, since setup always needs one', async () => {
    const checks = await runReadiness({ ...base, origin: '', client: goodClient() });
    expect(byId(checks, 'origin').status).toBe('fail');
    expect(byId(checks, 'setup').status).toBe('skipped');
  });

  it('shows the base URL it will call', async () => {
    const checks = await runReadiness({ ...base, baseUrl: 'https://credenceid.com/cloudsdk/playground', client: goodClient() });
    expect(byId(checks, 'baseurl').detail).toBe('https://credenceid.com/cloudsdk/playground');
  });

  it('explains documented error codes specifically', () => {
    expect(explainSdkError(new CloudSdkError('x', 401, 'LICENSE_EXPIRED_OR_REVOKED')).detail).toContain('expired');
    expect(explainSdkError(new CloudSdkError('x', 422, 'PROFILE_NOT_SUPPORTED')).fix).toContain('single-document');
  });

  it('never prints the key or profile id', async () => {
    const out = JSON.stringify(await runReadiness({ ...base, client: goodClient() }));
    expect(out).not.toContain(base.licenseKey);
    expect(out).not.toContain(base.profileId);
  });

  it('flags concatenated profiles and skips the live calls', async () => {
    const checks = await runReadiness({ ...base, profileId: base.profileId + base.profileId, client: goodClient() });
    expect(byId(checks, 'profile').status).toBe('fail');
    expect(byId(checks, 'profile').detail).toContain('several profiles');
    expect(byId(checks, 'setup').status).toBe('skipped');
  });

  it('reports a failed setup call with the fix, and skips the request check', async () => {
    const client: ReadinessClient = {
      ensureToken: async () => { throw new CloudSdkError('x', 403, 'DOMAIN_MISMATCH'); },
      getDocRequest: async () => { throw new Error('should not be called'); },
    };
    const checks = await runReadiness({ ...base, client });
    expect(byId(checks, 'setup').status).toBe('fail');
    expect(byId(checks, 'setup').fix).toContain('allowed-origins');
    expect(byId(checks, 'request').status).toBe('skipped');
  });

  it('reports a bad wallet request response', async () => {
    const client: ReadinessClient = { ensureToken: async () => {}, getDocRequest: async () => ({ sessionId: '', dcRequest: null }) };
    expect(byId(await runReadiness({ ...base, client }), 'request').status).toBe('fail');
  });

  it('warns, but does not fail, on an odd key format or a bad origin', async () => {
    const checks = await runReadiness({ ...base, licenseKey: 'weird-key-value', origin: 'https://localhost:3000', client: goodClient() });
    expect(byId(checks, 'key').status).toBe('warn');
    expect(byId(checks, 'origin').status).toBe('warn');
    expect(byId(checks, 'setup').status).toBe('pass');
  });
});

describe('readiness endpoint', () => {
  it('answers freely in mock mode', async () => {
    const { app } = setup();
    const res = await request(app).get('/api/readiness').expect(200);
    expect(res.body.mode).toBe('mock');
    expect(res.body.checks.length).toBeGreaterThan(3);
  });

  it('is locked in real mode until a token is configured and supplied', async () => {
    const off = setup({ mode: 'real' });
    expect((await request(off.app).get('/api/readiness')).status).toBe(403);

    const on = setup({ mode: 'real', readinessToken: 'tok-123', cloud: { ...base, client: goodClient() } });
    expect((await request(on.app).get('/api/readiness')).status).toBe(403);
    expect((await request(on.app).get('/api/readiness').set('x-readiness-token', 'wrong')).status).toBe(403);
    const ok = await request(on.app).get('/api/readiness').set('x-readiness-token', 'tok-123').expect(200);
    expect(ok.body.checks.find((c: any) => c.id === 'setup').status).toBe('pass');
  });
});
