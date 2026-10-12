// The real-mode browser code in public/wallet.js, with the Digital Credentials API faked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REAL_MESSAGES, REAL_WALLET_TIMEOUT_MS, hasDigitalCredentials, realOutcomeMessage, requestWallet, walletError, walletRequestData } from '../public/wallet.js';

const dcRequest = { deviceRequest: 'device-request', encryptionInfo: 'enc' };

function fakeBrowser(get: ((opts: any) => Promise<unknown>) | null, { dcApi = true } = {}) {
  vi.stubGlobal('navigator', get ? { credentials: { get: vi.fn(get) } } : {});
  vi.stubGlobal('DigitalCredential', dcApi ? class DigitalCredential {} : undefined);
}

async function messageFor(promise: Promise<unknown>) {
  try {
    await promise;
    return 'resolved';
  } catch (err) {
    return walletError(err);
  }
}

describe('real wallet in the browser', () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => vi.unstubAllGlobals());

  it('passes the WHOLE dcRequest as data by default, as in the Credence sample', async () => {
    let seen: any;
    fakeBrowser(async (opts) => ((seen = opts), { data: 'wallet-answer' }));
    await expect(requestWallet({ mode: 'real', dcRequest, sessionId: 's' })).resolves.toBe('wallet-answer');
    expect(seen.digital).toEqual({ requests: [{ protocol: 'org-iso-mdoc', data: { deviceRequest: 'device-request', encryptionInfo: 'enc' } }] });
    expect(seen.mediation).toBe('required');
  });

  it('passes only deviceRequest when the page address has ?dcdata=deviceRequest', async () => {
    let seen: any;
    fakeBrowser(async (opts) => ((seen = opts), { data: 'wallet-answer' }));
    vi.stubGlobal('location', { search: '?dcdata=deviceRequest' });
    await requestWallet({ mode: 'real', dcRequest, sessionId: 's' });
    expect(seen.digital.requests[0].data).toBe('device-request');
    vi.stubGlobal('location', { search: '?dcdata=something-else' });
    await requestWallet({ mode: 'real', dcRequest, sessionId: 's' });
    expect(seen.digital.requests[0].data).toEqual(dcRequest);
    expect(walletRequestData(dcRequest, '')).toBe(dcRequest);
    expect(walletRequestData(dcRequest, '?dcdata=deviceRequest')).toBe('device-request');
  });

  it('sends credential.data as is when it is a string, and as JSON text when it is an object', async () => {
    fakeBrowser(async () => ({ data: 'already-a-string' }));
    await expect(requestWallet({ mode: 'real', dcRequest, sessionId: 's' })).resolves.toBe('already-a-string');
    const object = { protocol: 'org-iso-mdoc', data: { response: 'b64-response' } };
    fakeBrowser(async () => ({ data: object }));
    const sent = await requestWallet({ mode: 'real', dcRequest, sessionId: 's' });
    expect(sent).toBe(JSON.stringify(object));
    expect(JSON.parse(sent)).toEqual(object);
  });

  it('maps browser errors to specific messages', async () => {
    const cases: [DOMException, string][] = [
      [new DOMException('The request requires transient activation (a user gesture).', 'NotAllowedError'), REAL_MESSAGES.blocked],
      [new DOMException('User cancelled', 'NotAllowedError'), REAL_MESSAGES.cancelled],
      [new DOMException('Aborted by the browser', 'AbortError'), REAL_MESSAGES.timeout],
      [new DOMException('Offline', 'NetworkError'), REAL_MESSAGES.network],
    ];
    for (const [error, message] of cases) {
      fakeBrowser(async () => { throw error; });
      expect(await messageFor(requestWallet({ mode: 'real', dcRequest, sessionId: 's' }))).toBe(message);
    }
    expect(REAL_MESSAGES.blocked).toBe('The browser blocked the wallet prompt. Tap Verify again.');
  });

  it('says which phone to use when the Digital Credentials API is missing, without calling anything', async () => {
    fakeBrowser(async () => ({ data: 'x' }), { dcApi: false }); // passkey-only browser: credentials.get exists
    expect(hasDigitalCredentials()).toBe(false);
    expect(await messageFor(requestWallet({ mode: 'real', dcRequest, sessionId: 's' }))).toBe(REAL_MESSAGES.unsupported);
    expect(REAL_MESSAGES.unsupported).toBe('Open this page in a browser on the phone that holds your wallet.');
    fakeBrowser(null, { dcApi: false });
    expect(await messageFor(requestWallet({ mode: 'real', dcRequest, sessionId: 's' }))).toBe(REAL_MESSAGES.unsupported);
  });

  it('treats a browser that rejects the digital request as unsupported', async () => {
    fakeBrowser(async () => { throw new TypeError('digital is not a recognised member'); });
    expect(await messageFor(requestWallet({ mode: 'real', dcRequest, sessionId: 's' }))).toBe(REAL_MESSAGES.unsupported);
  });

  it('handles a cancelled wallet prompt calmly', async () => {
    fakeBrowser(async () => { throw new DOMException('User cancelled', 'NotAllowedError'); });
    expect(await messageFor(requestWallet({ mode: 'real', dcRequest, sessionId: 's' }))).toBe(REAL_MESSAGES.cancelled);
  });

  it('stops waiting after the timeout', async () => {
    vi.useFakeTimers();
    fakeBrowser((opts) => new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))));
    const pending = messageFor(requestWallet({ mode: 'real', dcRequest, sessionId: 's' }));
    await vi.advanceTimersByTimeAsync(REAL_WALLET_TIMEOUT_MS);
    expect(await pending).toBe(REAL_MESSAGES.timeout);
  });

  it('reports a wallet that returns nothing', async () => {
    fakeBrowser(async () => null);
    expect(await messageFor(requestWallet({ mode: 'real', dcRequest, sessionId: 's' }))).toBe(REAL_MESSAGES.empty);
  });

  it('has specific messages for failed verifications', () => {
    expect(realOutcomeMessage('under_age')).toMatch(/not 21 or older/);
    expect(realOutcomeMessage('age_claim_missing')).toMatch(/did not share an age answer/);
    expect(realOutcomeMessage('verification_failed')).toMatch(/could not be verified/);
    expect(realOutcomeMessage('something_new')).toBeNull();
  });

  it('keeps the existing messages for mock and hybrid errors', () => {
    expect(walletError(new DOMException('Declined', 'NotAllowedError'))).toBe('The wallet prompt was cancelled or blocked. Try again.');
    expect(walletError(new DOMException('Timed out', 'AbortError'))).toBe('The wallet request timed out. Try again.');
    expect(walletError(new Error('This verification expired. Start again.'))).toBe('This verification expired. Start again.');
  });
});
