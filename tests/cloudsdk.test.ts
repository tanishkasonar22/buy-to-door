import { describe, expect, it } from 'vitest';
import { CloudSdkClient, CloudSdkError } from '../src/cloudsdk.js';

const opts = { baseUrl: 'https://api.test', licenseKey: 'CS_x', profileId: 'p-1', origin: 'https://shop.test' };

function fakeFetch(handler: (url: string, init: RequestInit) => { status?: number; body: unknown }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const { status = 200, body } = handler(url, init);
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const tokenBody = (n: number) => ({ accessToken: `a${n}`, refreshToken: `r${n}`, expiresIn: 900 });

describe('CloudSdkClient', () => {
  it('sets up once with the Origin header, then reuses the token', async () => {
    const { fn, calls } = fakeFetch((url) =>
      url.endsWith('/v1/setup') ? { body: tokenBody(1) } : { body: { sessionId: 's1', dcRequest: {} } },
    );
    const client = new CloudSdkClient(opts, fn);
    await client.getDocRequest();
    await client.getDocRequest();
    const setups = calls.filter((c) => c.url.endsWith('/v1/setup'));
    expect(setups).toHaveLength(1);
    expect((setups[0].init.headers as Record<string, string>).Origin).toBe('https://shop.test');
    expect(JSON.parse(setups[0].init.body as string)).toEqual({ licenseKey: 'CS_x', profileId: 'p-1' });
    const doc = calls.find((c) => c.url.endsWith('/v1/getDocRequest'))!;
    expect((doc.init.headers as Record<string, string>).Authorization).toBe('Bearer a1');
  });

  it('refreshes a token that is about to expire', async () => {
    let t = 0;
    const { fn, calls } = fakeFetch((url) => {
      if (url.endsWith('/v1/setup')) return { body: tokenBody(1) };
      if (url.endsWith('/v1/refresh')) return { body: tokenBody(2) };
      return { body: { sessionId: 's', dcRequest: {} } };
    });
    const client = new CloudSdkClient(opts, fn, () => t);
    await client.getDocRequest();
    t = 880_000; // inside the 60 second margin of a 900 second token
    await client.getDocRequest();
    expect(calls.some((c) => c.url.endsWith('/v1/refresh'))).toBe(true);
    const last = calls[calls.length - 1];
    expect((last.init.headers as Record<string, string>).Authorization).toBe('Bearer a2');
  });

  it('falls back to setup when refresh fails', async () => {
    let t = 0;
    let setups = 0;
    const { fn } = fakeFetch((url) => {
      if (url.endsWith('/v1/setup')) return { body: tokenBody(++setups) };
      if (url.endsWith('/v1/refresh')) return { status: 401, body: {} };
      return { body: { sessionId: 's', dcRequest: {} } };
    });
    const client = new CloudSdkClient(opts, fn, () => t);
    await client.getDocRequest();
    t = 890_000;
    await client.getDocRequest();
    expect(setups).toBe(2);
  });

  it('throws a status-only error and does not echo the response body', async () => {
    const { fn } = fakeFetch(() => ({ status: 403, body: { secret: 'do-not-leak' } }));
    const client = new CloudSdkClient(opts, fn);
    const err = await client.getDocRequest().catch((e) => e);
    expect(err).toBeInstanceOf(CloudSdkError);
    expect(err.status).toBe(403);
    expect(err.message).not.toContain('do-not-leak');
  });

  it('keeps only a short error code from the body', async () => {
    const { fn } = fakeFetch(() => ({ status: 403, body: { code: 'DOMAIN_MISMATCH', detail: 'private details' } }));
    const err = await new CloudSdkClient(opts, fn).getDocRequest().catch((e) => e);
    expect(err.code).toBe('DOMAIN_MISMATCH');
    expect(err.message).not.toContain('private');
  });

  it('ignores an error code that is not a short upper-case code', async () => {
    const { fn } = fakeFetch(() => ({ status: 500, body: { code: 'this is a long sentence with secrets' } }));
    const err = await new CloudSdkClient(opts, fn).getDocRequest().catch((e) => e);
    expect(err.code).toBeUndefined();
  });

  it('does not call setup when a refresh is rate limited', async () => {
    let t = 0;
    let setups = 0;
    const { fn } = fakeFetch((url) => {
      if (url.endsWith('/v1/setup')) return { body: tokenBody(++setups) };
      if (url.endsWith('/v1/refresh')) return { status: 429, body: {} };
      return { body: { sessionId: 's', dcRequest: {} } };
    });
    const client = new CloudSdkClient(opts, fn, () => t);
    await client.getDocRequest();
    t = 890_000;
    const err = await client.getDocRequest().catch((e) => e);
    expect(err.status).toBe(429);
    expect(setups).toBe(1);
  });

  it('drops a stale token and retries once after a 401 mid-call', async () => {
    let setups = 0;
    let docCalls = 0;
    const { fn } = fakeFetch((url) => {
      if (url.endsWith('/v1/setup')) return { body: tokenBody(++setups) };
      docCalls += 1;
      return docCalls === 1 ? { status: 401, body: { code: 'TOKEN_EXPIRED' } } : { body: { sessionId: 's', dcRequest: {} } };
    });
    const doc = await new CloudSdkClient(opts, fn).getDocRequest();
    expect(doc.sessionId).toBe('s');
    expect(setups).toBe(2);
  });

  it('does not retry forever when 401 keeps coming back', async () => {
    let docCalls = 0;
    const { fn } = fakeFetch((url) => {
      if (url.endsWith('/v1/setup')) return { body: tokenBody(1) };
      docCalls += 1;
      return { status: 401, body: { code: 'INVALID_TOKEN' } };
    });
    const err = await new CloudSdkClient(opts, fn).getDocRequest().catch((e) => e);
    expect(err.status).toBe(401);
    expect(docCalls).toBe(2);
  });

  it('ensureToken sets up once and then reuses the token', async () => {
    const { fn, calls } = fakeFetch(() => ({ body: tokenBody(1) }));
    const client = new CloudSdkClient(opts, fn);
    await client.ensureToken();
    await client.ensureToken();
    expect(calls).toHaveLength(1);
  });
});
