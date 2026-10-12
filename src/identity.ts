import { randomUUID } from 'node:crypto';
import type { CloudSdkClient } from './cloudsdk.js';

export interface StartResult {
  sessionId: string;
  dcRequest: unknown;
}

export interface RawVerification {
  res: boolean;
  resDetails: string;
  cancelled?: boolean;
}

/** Everything else in the server talks to this interface, never to a vendor directly. */
export type VerifierMode = 'mock' | 'hybrid' | 'real';

export interface IdentityVerifier {
  start(): Promise<StartResult>;
  verify(sessionId: string, data: string): Promise<RawVerification>;
  /** Number of requests this process has really created through the Cloud SDK. */
  liveRequests?(): number;
}

const AGE_FLAG = /^age_over_\d+$/;
// Exactly "true" or "false" in any ASCII letter case. Without the u flag, /i never matches non-ASCII
// look-alikes (for example the long s), and no whitespace or other spelling is accepted.
const TRUE_OR_FALSE = /^(?:true|false)$/i;

/**
 * Credence returns age flags such as identity.age_over_21 as strings ("true", "True", ...) rather than
 * booleans. This converts the words true / false, in any ASCII letter case, to real booleans, for
 * age_over_<number> keys directly under `identity` and under each `documents[].identity`, and nothing
 * else: "yes", "1", "t", anything with whitespace, other keys (the portrait included) and other paths
 * are left as they are, so the firewall still refuses them. When nothing needs converting, the response
 * is returned unchanged.
 */
export function normalizeCredenceAgeFlags(raw: RawVerification): RawVerification {
  if (!raw || typeof raw.resDetails !== 'string') return raw;
  let details: any;
  try {
    details = JSON.parse(raw.resDetails);
  } catch {
    return raw; // not JSON (for example an error description): nothing to convert
  }
  if (!details || typeof details !== 'object') return raw;
  let changed = false;
  const convert = (identity: unknown) => {
    if (!identity || typeof identity !== 'object' || Array.isArray(identity)) return;
    const claims = identity as Record<string, unknown>;
    for (const [key, value] of Object.entries(claims)) {
      if (AGE_FLAG.test(key) && typeof value === 'string' && TRUE_OR_FALSE.test(value)) {
        claims[key] = value.toLowerCase() === 'true';
        changed = true;
      }
    }
  };
  convert(details.identity);
  if (Array.isArray(details.documents)) for (const doc of details.documents) if (doc && typeof doc === 'object') convert(doc.identity);
  return changed ? { ...raw, resDetails: JSON.stringify(details) } : raw;
}

export class CredenceVerifier implements IdentityVerifier {
  constructor(private client: CloudSdkClient) {}
  start() {
    return this.client.getDocRequest();
  }
  /** The Credence adapter boundary: age flags arrive as strings and are made booleans here, before the firewall. */
  async verify(sessionId: string, data: string) {
    return normalizeCredenceAgeFlags(await this.client.verifyDocRequest(sessionId, data));
  }
}

/**
 * Hybrid mode: every request is created through the real Cloud SDK, and a wallet answer
 * that starts with "mock:" is judged by the test double. Any other answer goes to the real SDK.
 * Used when no real wallet credential is available.
 */
export class HybridVerifier implements IdentityVerifier {
  private live = 0;
  private mock: MockVerifier;
  constructor(private client: Pick<CloudSdkClient, 'getDocRequest' | 'verifyDocRequest'>, ageClaimKey = 'age_over_21') {
    this.mock = new MockVerifier(ageClaimKey);
  }
  async start() {
    const started = await this.client.getDocRequest();
    this.live += 1;
    return started;
  }
  verify(sessionId: string, data: string) {
    return data.startsWith('mock:') ? this.mock.verify(sessionId, data) : this.client.verifyDocRequest(sessionId, data);
  }
  liveRequests() {
    return this.live;
  }
}

const authOk = {
  authenticationResult: 'SUCCESS',
  issuerRecognized: true,
  issuerSignedAuthenticated: true,
  deviceSignedAuthenticated: true,
  dataIntegrity: true,
};

/** Test double. The scenario name is sent as the wallet "data" string, e.g. "mock:pass". */
export class MockVerifier implements IdentityVerifier {
  constructor(private ageClaimKey = 'age_over_21') {}

  async start(): Promise<StartResult> {
    return { sessionId: randomUUID(), dcRequest: { mock: true } };
  }

  async verify(_sessionId: string, data: string): Promise<RawVerification> {
    const scenario = data.replace(/^mock:/, '');
    // Fake personal data on purpose, so tests can prove the firewall drops it.
    const identity: Record<string, unknown> = {
      given_name: 'Testperson',
      family_name: 'Examplesurname',
      birth_date: '1990-01-01',
      portrait: 'AAAA'.repeat(40),
      [this.ageClaimKey]: scenario !== 'under',
    };
    switch (scenario) {
      case 'pass':
      case 'under':
        return { res: true, resDetails: JSON.stringify({ identity, authentication: authOk }) };
      case 'cancel':
        return { res: false, resDetails: '{}', cancelled: true };
      case 'invalid':
        return { res: false, resDetails: '{}' };
      case 'noage': {
        delete identity[this.ageClaimKey];
        return { res: true, resDetails: JSON.stringify({ identity, authentication: authOk }) };
      }
      default:
        throw new Error(`Unknown mock scenario: ${scenario}`);
    }
  }
}
