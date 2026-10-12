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

export class CredenceVerifier implements IdentityVerifier {
  constructor(private client: CloudSdkClient) {}
  start() {
    return this.client.getDocRequest();
  }
  verify(sessionId: string, data: string) {
    return this.client.verifyDocRequest(sessionId, data);
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
