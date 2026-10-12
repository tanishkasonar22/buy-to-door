import type { IdentityVerifier } from './identity.js';

/**
 * Evidence that the Credence ID Cloud SDK is really being called: request count, timing,
 * token activity and the last request. Counters live in memory and cover this server process only.
 * Nothing secret is kept here: no tokens, no license key, and only a shortened session ID.
 */
export class SdkStats {
  private requests = 0;
  private failures = 0;
  private totalMs = 0;
  private last: { at: string; ms: number; sessionId: string } | null = null;
  private tokenSetups = 0;
  private tokenRefreshes = 0;
  tokenTracking = false;

  recordRequest(ms: number, sessionId: string) {
    this.requests += 1;
    this.totalMs += ms;
    this.last = { at: new Date().toISOString(), ms: Math.round(ms), sessionId: shortId(sessionId) };
  }

  recordFailure() {
    this.failures += 1;
  }

  recordToken(kind: 'setup' | 'refresh') {
    if (kind === 'setup') this.tokenSetups += 1;
    else this.tokenRefreshes += 1;
  }

  snapshot(mode: 'mock' | 'hybrid' | 'real', baseUrl?: string) {
    const live = mode !== 'mock';
    return {
      mode,
      live,
      label: live ? 'Live SDK' : 'Mock',
      endpoint: live && baseUrl ? endpointName(baseUrl) : null,
      requestsCreated: this.requests,
      failedRequests: this.failures,
      avgResponseMs: this.requests ? Math.round(this.totalMs / this.requests) : null,
      lastRequestAt: this.last?.at ?? null,
      lastResponseMs: this.last?.ms ?? null,
      lastSessionId: this.last?.sessionId ?? null,
      tokenTracking: this.tokenTracking,
      tokenSetups: this.tokenTracking ? this.tokenSetups : null,
      tokenRefreshes: this.tokenTracking ? this.tokenRefreshes : null,
    };
  }
}

/** First 8 characters only, enough to match a log line but useless as a handle. */
export function shortId(id: string) {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

/** Host and path of the base URL, for example credenceid.com/cloudsdk/playground. Never a query string. */
function endpointName(baseUrl: string) {
  try {
    const u = new URL(baseUrl);
    return (u.host + u.pathname).replace(/\/$/, '');
  } catch {
    return null;
  }
}

/** Times every request the verifier creates. Only used in hybrid and real mode, where start() calls the Cloud SDK. */
export function instrumentVerifier(verifier: IdentityVerifier, stats: SdkStats): IdentityVerifier {
  return {
    async start() {
      const t0 = performance.now();
      try {
        const started = await verifier.start();
        stats.recordRequest(performance.now() - t0, started.sessionId);
        return started;
      } catch (e) {
        stats.recordFailure();
        throw e;
      }
    },
    verify: (sessionId, data) => verifier.verify(sessionId, data),
    liveRequests: verifier.liveRequests ? () => verifier.liveRequests!() : undefined,
  };
}

/**
 * Counts successful /v1/setup and /v1/refresh calls made by a CloudSdkClient.
 * The client keeps its token logic private, so this wraps its internal post() on this one
 * instance and passes every call through unchanged. Returns false (and the dashboard says
 * "not tracked") if the client does not have that method, for example a test double.
 */
export function watchTokenCalls(client: unknown, stats: SdkStats): boolean {
  const c = client as { post?: (path: string, ...rest: unknown[]) => Promise<unknown> } | undefined;
  if (!c || typeof c.post !== 'function') return false;
  const original = c.post.bind(c);
  c.post = async (path: string, ...rest: unknown[]) => {
    const result = await original(path, ...rest);
    if (path === '/v1/setup') stats.recordToken('setup');
    else if (path === '/v1/refresh') stats.recordToken('refresh');
    return result;
  };
  stats.tokenTracking = true;
  return true;
}
