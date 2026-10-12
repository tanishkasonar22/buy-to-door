// The real-mode browser code in public/wallet.js, with the Digital Credentials API faked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REAL_MESSAGES, REAL_WALLET_TIMEOUT_MS, hasDigitalCredentials, realOutcomeMessage, requestWallet, walletError } from '../public/wallet.js';

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

  it('asks the wallet with org-iso-mdoc, the deviceRequest and mediation required', async () => {
    let seen: any;
    fakeBrowser(async (opts) => ((seen = opts), { data: 'wallet-answer' }));
    await expect(requestWallet({ mode: 'real', dcRequest, sessionId: 's' })).resolves.toBe('wallet-answer');
    expect(seen.digital).toEqual({ requests: [{ protocol: 'org-iso-mdoc', data: 'device-request' }] });
    expect(seen.mediation).toBe('required');
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
