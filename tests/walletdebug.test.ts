// The real-mode wallet debug panel (?debug=1) and the "Wallet error: <name>" messages, in
// public/wallet.js, public/wallet-debug.js and public/api.js, with the browser faked.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../public/api.js';
import { requestWallet, walletError } from '../public/wallet.js';
import { PHASES, buildDetails, debugEnabled, describeCredential, formatDetails, markConfirm, newTrace, reportRealFailure } from '../public/wallet-debug.js';

const DEVICE_REQUEST = 'SECRET-DEVICE-REQUEST-CONTENTS';
const dcRequest = { deviceRequest: DEVICE_REQUEST, encryptionInfo: 'SECRET-ENCRYPTION-INFO' };

/** reportRealFailure with its options typed (TypeScript infers them too narrowly from the JS default). */
const report = reportRealFailure as unknown as (
  err: unknown, trace: unknown, opts: { statusEl?: unknown; search?: string; result?: unknown; log?: Console },
) => boolean;

/** A console stand-in that records error() calls. Typed as Console for the JS default parameter. */
const fakeConsole = () => {
  const error = vi.fn();
  return { error, log: { error } as unknown as Console };
};

/** Fakes the Digital Credentials API with the given navigator.credentials.get. */
function fakeBrowser(get: ((opts: any) => Promise<unknown>) | null) {
  vi.stubGlobal('navigator', get ? { credentials: { get } } : {});
  vi.stubGlobal('DigitalCredential', get ? class DigitalCredential {} : undefined);
}

/** Just enough DOM for reportRealFailure: a status line whose document can create and find a <pre>. */
function fakeStatus() {
  const byId = new Map<string, any>();
  const doc = {
    getElementById: (id: string) => byId.get(id) ?? null,
    createElement: (tag: string) => ({ tag, id: '', className: '', textContent: '' }),
  };
  const inserted: any[] = [];
  const statusEl = {
    ownerDocument: doc,
    insertAdjacentElement(where: string, node: any) {
      inserted.push({ where, node });
      byId.set(node.id, node);
    },
  };
  return { statusEl, inserted, panel: () => byId.get('wallet-debug') };
}

/** Runs the real wallet with a trace and returns the error it threw plus the trace. */
async function failRealWallet(get: ((opts: any) => Promise<unknown>) | null, request: unknown = dcRequest) {
  fakeBrowser(get);
  const trace = newTrace();
  try {
    await requestWallet({ mode: 'real', dcRequest: request, sessionId: 's', trace: trace as any });
  } catch (err) {
    return { err: err as any, trace };
  }
  throw new Error('expected the wallet to fail');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('real mode: "Wallet error: <name>" instead of "Something went wrong"', () => {
  it('names an unknown browser error, never the generic message', () => {
    expect(walletError(new DOMException('', 'DataError'), 'real')).toBe('Wallet error: DataError');
    expect(walletError(new DOMException('Some long browser text', 'InvalidStateError'), 'real')).toBe('Wallet error: InvalidStateError');
    expect(walletError(new TypeError('Failed to fetch'), 'real')).toBe('Wallet error: TypeError');
    expect(walletError(Object.assign(new Error(''), { name: '' }), 'real')).toBe('Wallet error: Error');
    expect(walletError(undefined, 'real')).toBe('Wallet error: Error');
  });

  it('keeps the server message for an HTTP error, and names the status when there is none', () => {
    const withMessage = Object.assign(new Error('The identity service could not complete the request. Try again.'), {
      status: 502, body: { error: 'verifier_unavailable', message: 'The identity service could not complete the request. Try again.' },
    });
    expect(walletError(withMessage, 'real')).toBe('The identity service could not complete the request. Try again.');
    const noMessage = Object.assign(new Error('Something went wrong. Try again.'), { status: 502, body: {} });
    expect(walletError(noMessage, 'real')).toBe('Wallet error: HTTP 502');
    expect(walletError(noMessage, 'real')).not.toContain('Something went wrong');
  });

  it('keeps the specific messages for known real-wallet problems', async () => {
    const { err } = await failRealWallet(async () => { throw new DOMException('User cancelled', 'NotAllowedError'); });
    expect(walletError(err, 'real')).toMatch(/^The wallet was closed before anything was shared/);
  });

  it('leaves mock and hybrid wording exactly as before', () => {
    expect(walletError(new DOMException('', 'DataError'))).toBe('Something went wrong. Try again.');
    expect(walletError(new DOMException('', 'DataError'), 'hybrid')).toBe('Something went wrong. Try again.');
    expect(walletError(new DOMException('x', 'NotAllowedError'), 'mock')).toBe('The wallet prompt was cancelled or blocked. Try again.');
  });

  it('names an error thrown by the browser during the wallet call', async () => {
    const { err } = await failRealWallet(async () => { throw new DOMException('', 'DataError'); });
    expect(walletError(err, 'real')).toBe('Wallet error: DataError');
  });
});

describe('the debug panel appears only with ?debug=1', () => {
  it('reads the flag from the page address', () => {
    expect(debugEnabled('?debug=1')).toBe(true);
    expect(debugEnabled('?x=2&debug=1')).toBe(true);
    for (const search of ['', '?debug=0', '?debug=true', '?debug', '?dcdata=deviceRequest']) expect(debugEnabled(search)).toBe(false);
    vi.stubGlobal('location', { search: '?debug=1' });
    expect(debugEnabled()).toBe(true);
    vi.stubGlobal('location', undefined);
    expect(debugEnabled()).toBe(false);
  });

  it('without the flag: no panel and no console output', () => {
    const { statusEl, inserted } = fakeStatus();
    const { error: logError, log } = fakeConsole();
    expect(report(new DOMException('', 'DataError'), newTrace(), { statusEl, search: '', log })).toBe(false);
    expect(report(new DOMException('', 'DataError'), newTrace(), { statusEl, search: '?debug=0', log })).toBe(false);
    expect(inserted).toEqual([]);
    expect(logError).not.toHaveBeenCalled();
  });

  it('with ?debug=1: a <pre> right after the status line, and the same details in console.error', () => {
    const { statusEl, inserted, panel } = fakeStatus();
    const { error: logError, log } = fakeConsole();
    const trace = newTrace();
    trace.phase = PHASES.during;
    const err = new DOMException('Wallet failed', 'DataError');
    expect(report(err, trace, { statusEl, search: '?debug=1', log })).toBe(true);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].where).toBe('afterend');
    expect(inserted[0].node).toMatchObject({ tag: 'pre', id: 'wallet-debug', className: 'wallet-debug' });
    expect(panel().textContent).toContain('Shown only on this device; nothing here was sent to the server.');
    expect(panel().textContent).toContain('error: DataError: Wallet failed');
    expect(panel().textContent).toContain(`phase: ${PHASES.during}`);
    expect(logError).toHaveBeenCalledWith('[wallet debug]', buildDetails(err, trace));
  });

  it('reuses one panel across failures', () => {
    const { statusEl, inserted, panel } = fakeStatus();
    const { error: logError, log } = fakeConsole();
    report(new DOMException('first', 'DataError'), newTrace(), { statusEl, search: '?debug=1', log });
    report(new DOMException('second', 'InvalidStateError'), newTrace(), { statusEl, search: '?debug=1', log });
    expect(inserted).toHaveLength(1);
    expect(panel().textContent).toContain('InvalidStateError: second');
    expect(panel().textContent).not.toContain('first');
  });

  it('shows a failed outcome (no exception) with the confirm response', () => {
    const { statusEl, panel } = fakeStatus();
    const trace = newTrace();
    const confirm = markConfirm(trace)!;
    confirm.status = 200;
    confirm.text = '{"outcome":"failed","reason":"authentication_checks_failed"}';
    report(null, trace, { statusEl, search: '?debug=1', result: { outcome: 'failed', reason: 'authentication_checks_failed' }, log: fakeConsole().log });
    expect(panel().textContent).toContain('outcome: failed (authentication_checks_failed)');
    expect(panel().textContent).toContain('confirm: HTTP 200, response: {"outcome":"failed"');
    expect(panel().textContent).not.toContain('error:');
  });
});

describe('every failure is labelled with the phase it happened in', () => {
  it('before navigator.credentials.get: no Digital Credentials API', async () => {
    const { err, trace } = await failRealWallet(null);
    expect(trace.phase).toBe(PHASES.before);
    expect(formatDetails(buildDetails(err, trace))).toContain('phase: before navigator.credentials.get');
  });

  it('before navigator.credentials.get: no deviceRequest from the Cloud SDK', async () => {
    const get = vi.fn();
    const { trace } = await failRealWallet(get, { encryptionInfo: 'x' });
    expect(trace.phase).toBe(PHASES.before);
    expect(get).not.toHaveBeenCalled();
  });

  it('during navigator.credentials.get: the browser or wallet throws', async () => {
    const { err, trace } = await failRealWallet(async () => { throw new DOMException('Error retrieving a token.', 'NetworkError'); });
    expect(trace.phase).toBe(PHASES.during);
    const text = formatDetails(buildDetails(err, trace));
    expect(text).toContain('phase: during navigator.credentials.get');
    expect(text).toContain('browser error: NetworkError: Error retrieving a token.'); // the original, under the friendly message
    expect(text).toContain('credential: (the wallet did not return one)');
  });

  it('after navigator.credentials.get: the answer cannot be turned into text', async () => {
    const { err, trace } = await failRealWallet(async () => ({ data: { response: 10n } }));
    expect(trace.phase).toBe(PHASES.after);
    expect(err).toBeInstanceOf(TypeError);
    expect(walletError(err, 'real')).toBe('Wallet error: TypeError');
    const text = formatDetails(buildDetails(err, trace));
    expect(text).toContain('phase: after navigator.credentials.get');
    expect(text).toContain('credential.data: typeof object, constructor Object, length 1, keys [response]');
  });

  it('during the confirm fetch: an HTTP error, with status and the first 300 characters', async () => {
    const body = JSON.stringify({ error: 'x', padding: 'p'.repeat(400) });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 502 })));
    const trace = newTrace();
    const err = await api('/api/verify/confirm', { sessionId: 's', data: 'd' }, {}, markConfirm(trace)).catch((e: unknown) => e);
    expect(trace.phase).toBe(PHASES.confirm);
    expect(trace.confirm).toEqual({ status: 502, text: body.slice(0, 300) });
    expect(walletError(err, 'real')).toBe('Wallet error: HTTP 502');
    const text = formatDetails(buildDetails(err, trace));
    expect(text).toContain('phase: during the confirm fetch');
    expect(text).toContain(`confirm: HTTP 502, response: ${body.slice(0, 300)}`);
    expect(text).not.toContain('p'.repeat(301));
  });

  it('during the confirm fetch: no HTTP response at all', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const trace = newTrace();
    const err = await api('/api/verify/confirm', { sessionId: 's', data: 'd' }, {}, markConfirm(trace)).catch((e: unknown) => e);
    expect(trace.phase).toBe(PHASES.confirm);
    expect(walletError(err, 'real')).toBe('Wallet error: TypeError');
    expect(formatDetails(buildDetails(err, trace))).toContain('confirm: (not called, or no HTTP response)');
  });

  it('markConfirm does nothing outside real mode (no trace)', () => {
    expect(markConfirm(undefined)).toBeUndefined();
  });
});

describe('the panel never shows request contents or credential values', () => {
  it('reports types, lengths and key names only', async () => {
    const credentialData = { protocol: 'org-iso-mdoc', data: { response: 'SECRET-WALLET-RESPONSE' } };
    // The confirm call fails after the wallet answered, so the trace holds the credential description.
    fakeBrowser(async () => ({ data: credentialData }));
    const trace = newTrace();
    const data = await requestWallet({ mode: 'real', dcRequest, sessionId: 's', trace: trace as any });
    expect(JSON.parse(data)).toEqual(credentialData);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })));
    const err = await api('/api/verify/confirm', { sessionId: 's', data }, {}, markConfirm(trace)).catch((e: unknown) => e);
    const { statusEl, panel } = fakeStatus();
    const { error: logError, log } = fakeConsole();
    report(err, trace, { statusEl, search: '?debug=1', log });
    const shown = panel().textContent + JSON.stringify(logError.mock.calls);
    for (const secret of [DEVICE_REQUEST, 'SECRET-ENCRYPTION-INFO', 'SECRET-WALLET-RESPONSE', 'org-iso-mdoc']) expect(shown).not.toContain(secret);
    expect(panel().textContent).toContain('credential.data: typeof object, constructor Object, length 2, keys [protocol, data]');
    expect(panel().textContent).toContain('confirm: HTTP 500, response: (empty)');
  });

  it('describeCredential handles every shape without copying values', () => {
    expect(describeCredential(null)).toEqual({ typeofCredential: 'object', credentialConstructor: null });
    expect(describeCredential({ data: 'abcdef' })).toMatchObject({ typeofData: 'string', dataLength: 6 });
    expect(describeCredential({ data: new ArrayBuffer(12) })).toMatchObject({ typeofData: 'object', dataConstructor: 'ArrayBuffer', dataLength: 12 });
    expect(describeCredential({ data: new Uint8Array(5) })).toMatchObject({ dataConstructor: 'Uint8Array', dataLength: 5 });
    expect(describeCredential({ data: null })).toMatchObject({ typeofData: 'null' });
    const described = describeCredential({ data: { response: 'VALUE-NOT-COPIED' } });
    expect(described).toMatchObject({ dataKeys: ['response'], dataLength: 1 });
    expect(JSON.stringify(described)).not.toContain('VALUE-NOT-COPIED');
  });

  it('api() without a trace behaves exactly as before', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"message":"Nope"}', { status: 400 })));
    const err: any = await api('/x', {}).catch((e: unknown) => e);
    expect(err).toMatchObject({ message: 'Nope', status: 400, body: { message: 'Nope' } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 500 })));
    const err2: any = await api('/x', {}).catch((e: unknown) => e);
    expect(err2.message).toBe('Something went wrong. Try again.');
  });
});
