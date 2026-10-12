// Server-side client for the Credence ID Cloud SDK REST service.
// The license key and tokens stay on the server. The browser never sees them.

export class CloudSdkError extends Error {
  constructor(message: string, public status: number, public code?: string) {
    super(message);
    this.name = 'CloudSdkError';
  }
}

/** Pull out only a short UPPER_SNAKE error code such as DOMAIN_MISMATCH. Nothing else from the body. */
function safeCode(text: string): string | undefined {
  try {
    const json = JSON.parse(text);
    const c = json?.code ?? json?.error;
    return typeof c === 'string' && /^[A-Z][A-Z0-9_]{2,39}$/.test(c) ? c : undefined;
  } catch {
    return undefined;
  }
}

export interface CloudSdkOptions {
  baseUrl: string;
  licenseKey: string;
  profileId: string;
  /** Must match the HTTPS domain registered with the license. Sent on /v1/setup. */
  origin: string;
}

interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

const EXPIRY_MARGIN_MS = 60_000;

export class CloudSdkClient {
  private tokens: Tokens | null = null;
  private pending: Promise<string> | null = null;

  constructor(
    private opts: CloudSdkOptions,
    private fetchFn: typeof fetch = fetch,
    private now: () => number = Date.now,
  ) {}

  private async post(path: string, body: object, token?: string): Promise<any> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    else if (this.opts.origin) headers.Origin = this.opts.origin;

    const res = await this.fetchFn(this.opts.baseUrl + path, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      // Status only. Response bodies are not echoed into errors or logs.
      throw new CloudSdkError(`Cloud SDK ${path} returned HTTP ${res.status}`, res.status, safeCode(text));
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new CloudSdkError(`Cloud SDK ${path} returned a non-JSON response`, 502);
    }
  }

  private store(r: { accessToken: string; refreshToken: string; expiresIn: number }) {
    this.tokens = {
      accessToken: r.accessToken,
      refreshToken: r.refreshToken,
      expiresAt: this.now() + r.expiresIn * 1000,
    };
    return this.tokens.accessToken;
  }

  private async obtainToken(): Promise<string> {
    if (this.tokens && this.tokens.expiresAt - this.now() > EXPIRY_MARGIN_MS) {
      return this.tokens.accessToken;
    }
    if (this.tokens?.refreshToken) {
      try {
        return this.store(await this.post('/v1/refresh', { refreshToken: this.tokens.refreshToken }));
      } catch (e) {
        // Only an expired or already-used refresh token (401) calls for a fresh setup.
        // Rate limits and server errors are passed on, because setup is limited to 30 per minute.
        if (!(e instanceof CloudSdkError && e.status === 401)) throw e;
      }
    }
    return this.store(
      await this.post('/v1/setup', { licenseKey: this.opts.licenseKey, profileId: this.opts.profileId }),
    );
  }

  /** One in-flight token request at a time. */
  private token(): Promise<string> {
    if (!this.pending) {
      this.pending = this.obtainToken().finally(() => {
        this.pending = null;
      });
    }
    return this.pending;
  }

  /** Makes sure a valid access token exists. Used by the readiness checker. */
  async ensureToken(): Promise<void> {
    await this.token();
  }

  /** Authorized call. A 401 means the cached token went stale, so drop it and retry once. */
  private async authed(path: string, body: object): Promise<any> {
    try {
      return await this.post(path, body, await this.token());
    } catch (e) {
      if (!(e instanceof CloudSdkError && e.status === 401)) throw e;
      this.tokens = null;
      return this.post(path, body, await this.token());
    }
  }

  /** Apple Wallet flow, step 1. The browser passes dcRequest.deviceRequest to navigator.credentials.get(). */
  async getDocRequest(): Promise<{ sessionId: string; dcRequest: unknown }> {
    return this.authed('/v1/getDocRequest', {});
  }

  /** Apple Wallet flow, step 2. data is the string returned by the wallet. */
  async verifyDocRequest(
    sessionId: string,
    data: string,
  ): Promise<{ res: boolean; resDetails: string; cancelled?: boolean }> {
    return this.authed('/v1/verifyDocRequest', { sessionId, data });
  }
}
