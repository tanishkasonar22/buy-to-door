// The two real-mode DEMO workarounds: narrowing the mDL request to age_over_21, and the
// default-off issuer-trust override.
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildAuditRows } from '../src/audit.js';
import { applyFirewall } from '../src/firewall.js';
import { CredenceVerifier, HybridVerifier, type RawVerification } from '../src/identity.js';
import { narrowMdlToAgeOver21 } from '../src/narrowRequest.js';
import { setup } from './helpers.js';

// ---- A tiny CBOR encoder (independent of the code under test) ----
const head = (major: number, n: number): number[] => {
  if (n < 24) return [(major << 5) | n];
  if (n < 0x100) return [(major << 5) | 24, n];
  if (n < 0x10000) return [(major << 5) | 25, n >> 8, n & 0xff];
  return [(major << 5) | 26, (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
};
const text = (s: string) => [...head(3, Buffer.byteLength(s)), ...Buffer.from(s)];
const bytes = (b: number[]) => [...head(2, b.length), ...b];
const array = (...items: number[][]) => [...head(4, items.length), ...items.flat()];
const map = (...pairs: [string, number[]][]) => [...head(5, pairs.length), ...pairs.flatMap(([k, v]) => [...text(k), ...v])];
const tag24 = (inner: number[]) => [0xd8, 0x18, ...bytes(inner)];
const TRUE = [0xf5];
const FALSE = [0xf4];
const NULL = [0xf6];
const b64 = (b: number[]) => Buffer.from(b).toString('base64url');

// ---- A tiny CBOR decoder, to read results back in tests ----
function decode(b: Uint8Array, pos = 0): [unknown, number] {
  const ib = b[pos]!;
  const major = ib >> 5;
  const ai = ib & 31;
  let p = pos + 1;
  let n = ai;
  if (ai === 24) { n = b[p]!; p += 1; } else if (ai === 25) { n = (b[p]! << 8) | b[p + 1]!; p += 2; }
  if (major === 0) return [n, p];
  if (major === 2) return [{ bytes: Buffer.from(b.slice(p, p + n)).toString('hex') }, p + n];
  if (major === 3) return [Buffer.from(b.slice(p, p + n)).toString(), p + n];
  if (major === 4) { const out = []; for (let i = 0; i < n; i++) { const [v, q] = decode(b, p); out.push(v); p = q; } return [out, p]; }
  if (major === 5) { const out: Record<string, unknown> = {}; for (let i = 0; i < n; i++) { const [k, q] = decode(b, p); const [v, r] = decode(b, q); out[String(k)] = v; p = r; } return [out, p]; }
  if (major === 6) { const [v, q] = decode(b, p); return [{ tag: n, value: v }, q]; }
  return [ai === 20 ? false : ai === 21 ? true : null, p];
}
const decodeB64 = (s: string) => decode(new Uint8Array(Buffer.from(s, 'base64url')))[0] as any;
const decodeTag24 = (t: any) => decode(new Uint8Array(Buffer.from(t.value.bytes, 'hex')))[0] as any;

// ---- A DeviceRequest: an mDL docRequest asking for more, plus another document type ----
const NS = 'org.iso.18013.5.1';
const mdlItems = (nameSpaces: number[]) => map(
  ['docType', text('org.iso.18013.5.1.mDL')],
  ['nameSpaces', nameSpaces],
  ['requestInfo', map(['purpose', text('Age check for Harbor Nights ' + '.'.repeat(260))])], // long: 2-byte length header
);
const askingMore = map([NS, map(['portrait', FALSE], ['issuing_authority', TRUE], ['age_over_21', FALSE])]);
const ageOnly = map([NS, map(['age_over_21', FALSE])]);
const readerAuth = array(bytes([0xa1, 0x01, 0x26]), map(), NULL, bytes(new Array(64).fill(7)));
const mdlDoc = (nameSpaces: number[]) => map(['itemsRequest', tag24(mdlItems(nameSpaces))], ['readerAuth', readerAuth]);
const photoDoc = map(['itemsRequest', tag24(map(
  ['docType', text('org.iso.23220.photoid.1')],
  ['nameSpaces', map(['org.iso.23220.1', map(['portrait', FALSE], ['family_name', FALSE])])],
))]);
const deviceRequestInfo = tag24(map(['useCases', array(map(['mandatory', TRUE]))]));
const readerAuthAll = array(array(bytes(new Array(40).fill(9)), map(), NULL, bytes(new Array(300).fill(5))));
const deviceRequest = (mdlNameSpaces: number[], extra: [string, number[]][] = []) =>
  map(['version', text('1.1')], ['docRequests', array(mdlDoc(mdlNameSpaces), photoDoc)], ['deviceRequestInfo', deviceRequestInfo], ...extra);

describe('narrowMdlToAgeOver21 (demo workaround)', () => {
  it('changes only the mDL element list; every other byte is identical', () => {
    const { value, changed } = narrowMdlToAgeOver21(b64(deviceRequest(askingMore)));
    expect(changed).toBe(true);
    // Byte-exact: the same request built with the age-only nameSpaces.
    expect(value).toBe(b64(deviceRequest(ageOnly)));

    const out = decodeB64(value);
    const before = decodeB64(b64(deviceRequest(askingMore)));
    expect(out.version).toEqual(before.version);
    expect(out.deviceRequestInfo).toEqual(before.deviceRequestInfo);
    expect(out.docRequests[1]).toEqual(before.docRequests[1]); // the other document type
    expect(out.docRequests[0].readerAuth).toEqual(before.docRequests[0].readerAuth);
    const items = decodeTag24(out.docRequests[0].itemsRequest);
    const itemsBefore = decodeTag24(before.docRequests[0].itemsRequest);
    expect(items.docType).toBe('org.iso.18013.5.1.mDL');
    expect(items.requestInfo).toEqual(itemsBefore.requestInfo);
    expect(items.nameSpaces).toEqual({ [NS]: { age_over_21: false } });
    expect(Object.keys(items)).toEqual(['docType', 'nameSpaces', 'requestInfo']); // key order kept
  });

  it('returns a request without an mDL docRequest unchanged', () => {
    const original = b64(map(['version', text('1.1')], ['docRequests', array(photoDoc)]));
    expect(narrowMdlToAgeOver21(original)).toEqual({ value: original, changed: false });
    const noDocs = b64(map(['version', text('1.1')]));
    expect(narrowMdlToAgeOver21(noDocs)).toEqual({ value: noDocs, changed: false });
  });

  it('returns an mDL request that already asks only for age_over_21 unchanged', () => {
    const original = b64(deviceRequest(ageOnly));
    expect(narrowMdlToAgeOver21(original)).toEqual({ value: original, changed: false });
  });
});

describe('request narrowing at the start routes (real mode)', () => {
  const withReaderAuthAll = b64(deviceRequest(askingMore, [['readerAuthAll', readerAuthAll]]));
  const expected = b64(deviceRequest(ageOnly)); // readerAuthAll removed AND mDL narrowed

  function app(mode: 'real' | 'hybrid', options: { narrowRequest?: boolean } = {}) {
    const client = {
      async getDocRequest() { return { sessionId: `sdk-${Math.random()}`, dcRequest: { deviceRequest: withReaderAuthAll, encryptionInfo: 'enc-unchanged' } }; },
      async verifyDocRequest() { return { res: true, resDetails: JSON.stringify({ age_over_21: true }) }; },
    };
    const logs: string[] = [];
    const verifier = mode === 'real' ? new CredenceVerifier(client as any) : new HybridVerifier(client);
    return { logs, ...setup({ verifier, mode, ...options, log: (...a) => logs.push(a.join(' ')) }) };
  }

  it('is on by default: strips readerAuthAll, narrows the mDL request, keeps encryptionInfo', async () => {
    const { app: a, logs } = app('real');
    const res = await request(a).post('/api/verify/start').expect(200);
    expect(res.body.dcRequest).toEqual({ deviceRequest: expected, encryptionInfo: 'enc-unchanged' });
    expect(logs).toEqual([
      '[dc] removed readerAuthAll (verifier reader chain rejected by wallet)',
      '[dc] mDL request narrowed to age_over_21 (profile asks for more)',
    ]);
  });

  it('also applies to guest claims', async () => {
    const { app: a, logs } = app('real');
    const start = await request(a).post('/api/verify/start');
    const order = await request(a).post('/api/verify/confirm').send({ sessionId: start.body.sessionId, data: 'w', quantity: 2 });
    const token = new URL(order.body.order.claimLinks[0].path, 'http://x').searchParams.get('t')!;
    const claim = await request(a).post(`/api/claims/${token}/start`).expect(200);
    expect(claim.body.dcRequest.deviceRequest).toBe(expected);
    expect(logs.filter((l) => l.startsWith('[dc] mDL request narrowed'))).toHaveLength(2);
  });

  it('DC_KEEP_REQUESTED_ELEMENTS (narrowRequest: false) keeps the element list', async () => {
    const { app: a, logs } = app('real', { narrowRequest: false });
    const res = await request(a).post('/api/verify/start').expect(200);
    expect(res.body.dcRequest.deviceRequest).toBe(b64(deviceRequest(askingMore)));
    expect(logs).toEqual(['[dc] removed readerAuthAll (verifier reader chain rejected by wallet)']);
  });

  it('never touches hybrid mode', async () => {
    const { app: a, logs } = app('hybrid');
    const res = await request(a).post('/api/verify/start').expect(200);
    expect(res.body.dcRequest.deviceRequest).toBe(withReaderAuthAll);
    expect(logs).toEqual([]);
  });
});

// ---- B: the default-off issuer-trust override ----
const auth = (over: Record<string, unknown> = {}) => ({
  authenticationResult: 'FAILED', issuerRecognized: false, issuerSignedAuthenticated: true,
  deviceSignedAuthenticated: true, dataIntegrity: true, certValidationError: 'Issuer not in trust list', ...over,
});
const answer = (age: unknown, a: Record<string, unknown>): RawVerification => ({
  res: true, resDetails: JSON.stringify({ identity: { age_over_21: age, portrait: 'UE9SVFJBSVQ' }, authentication: a }),
});

describe('applyFirewall: demo issuer-trust override', () => {
  const on = { acceptUnlistedIssuer: true };

  it('off (default): an unlisted issuer is denied exactly as before', () => {
    const out = applyFirewall(answer(true, auth()), 'age_over_21');
    expect(out).toMatchObject({ outcome: 'failed', reason: 'authentication_checks_failed' });
    expect(out).not.toHaveProperty('issuerTrust');
    expect(applyFirewall(answer(true, auth()), 'age_over_21', { acceptUnlistedIssuer: false })).toEqual(out);
  });

  it('on, with issuerRecognized the only failing check: continues to the age check and marks it', () => {
    expect(applyFirewall(answer(true, auth()), 'age_over_21', on)).toMatchObject({ outcome: 'passed', reason: 'age_confirmed', issuerTrust: 'demo-unlisted' });
    expect(applyFirewall(answer(false, auth()), 'age_over_21', on)).toMatchObject({ outcome: 'failed', reason: 'under_age', issuerTrust: 'demo-unlisted' });
  });

  it('on, but another check failed or is missing: still denies', () => {
    for (const over of [{ deviceSignedAuthenticated: false }, { issuerSignedAuthenticated: false }, { dataIntegrity: false }, { issuerSignedAuthenticated: undefined }, { dataIntegrity: 'true' }]) {
      const out = applyFirewall(answer(true, auth(over)), 'age_over_21', on);
      expect(out).toMatchObject({ outcome: 'failed', reason: 'authentication_checks_failed' });
      expect(out).not.toHaveProperty('issuerTrust');
    }
  });

  it('on: res false and cancelled are untouched', () => {
    expect(applyFirewall({ res: false, resDetails: 'Issuer not trusted' }, 'age_over_21', on).reason).toBe('verification_failed');
    expect(applyFirewall({ res: false, resDetails: '{}', cancelled: true }, 'age_over_21', on).reason).toBe('wallet_cancelled');
  });

  it('on, with every check passing: nothing is marked', () => {
    expect(applyFirewall(answer(true, auth({ issuerRecognized: true })), 'age_over_21', on)).not.toHaveProperty('issuerTrust');
  });
});

describe('demo issuer-trust override through the app', () => {
  function app(mode: 'real' | 'hybrid', demoAcceptUnlistedIssuer: boolean, a = auth()) {
    const client = {
      async getDocRequest() { return { sessionId: `sdk-${Math.random()}`, dcRequest: { deviceRequest: 'x', encryptionInfo: 'y' } }; },
      async verifyDocRequest() { return answer(true, a); },
    };
    const logs: string[] = [];
    const verifier = mode === 'real' ? new CredenceVerifier(client as any) : new HybridVerifier(client);
    return { logs, ...setup({ verifier, mode, demoAcceptUnlistedIssuer, log: (...x) => logs.push(x.join(' ')) }) };
  }
  const buyReal = async (a: any) => {
    const start = await request(a).post('/api/verify/start');
    return request(a).post('/api/verify/confirm').send({ sessionId: start.body.sessionId, data: 'real-wallet-answer' });
  };

  it('on: issues the ticket, warns in the log, and marks the receipt, the database and the audit CSV', async () => {
    const { app: a, db, logs } = app('real', true);
    const res = await buyReal(a);
    expect(res.body).toMatchObject({ outcome: 'passed', reason: 'age_confirmed' });
    expect(res.body.receipt.issuerTrust).toBe('demo-unlisted');
    expect((await request(a).get(`/api/receipts/${res.body.receipt.id}`)).body.issuerTrust).toBe('demo-unlisted');
    expect(db.prepare('select issuer_trust from privacy_receipts').all()).toEqual([{ issuer_trust: 'demo-unlisted' }]);

    const warnAt = logs.indexOf('[firewall] WARNING demo override: issuer not on trust list');
    expect(warnAt).toBeGreaterThanOrEqual(0);
    expect(logs.indexOf('[firewall] decision=allow reason=age_confirmed')).toBeGreaterThan(warnAt);
    expect(logs.join('\n')).not.toContain('UE9SVFJBSVQ');

    const audit = buildAuditRows(db).filter((r) => r.event === 'issuer_trust');
    expect(audit).toEqual([expect.objectContaining({ ticket_id: res.body.ticket.id, order_id: res.body.order.id, reason: 'issuerTrust=demo-unlisted' })]);
    const csv = (await request(a).get('/api/export/audit.csv')).text;
    expect(csv).toContain(`,issuer_trust,${res.body.ticket.id},${res.body.order.id},,,,issuerTrust=demo-unlisted,`);
  });

  it('off (default): denies as before, with no marking anywhere', async () => {
    const { app: a, db, logs } = app('real', false);
    const res = await buyReal(a);
    expect(res.body).toMatchObject({ outcome: 'failed', reason: 'authentication_checks_failed', ticket: null });
    expect(res.body.receipt).not.toHaveProperty('issuerTrust');
    expect(db.prepare('select issuer_trust from privacy_receipts').all()).toEqual([{ issuer_trust: null }]);
    expect(buildAuditRows(db).some((r) => r.event === 'issuer_trust')).toBe(false);
    expect(logs.some((l) => l.includes('WARNING demo override'))).toBe(false);
  });

  it('on, but another check failed: still denies', async () => {
    const { app: a } = app('real', true, auth({ deviceSignedAuthenticated: false }));
    expect((await buyReal(a)).body).toMatchObject({ outcome: 'failed', reason: 'authentication_checks_failed' });
  });

  it('has no effect in hybrid mode', async () => {
    const { app: a, logs } = app('hybrid', true);
    const res = await buyReal(a);
    expect(res.body).toMatchObject({ outcome: 'failed', reason: 'authentication_checks_failed' });
    expect(logs.some((l) => l.includes('WARNING demo override'))).toBe(false);
  });
});

describe('privacy receipt UI line', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** Just enough DOM for render.js: elements with children, attributes and text. */
  function fakeDocument() {
    const make = (tag: string): any => ({
      tag, children: [] as any[], attrs: {} as Record<string, string>, className: '', textContent: '',
      setAttribute(k: string, v: string) { this.attrs[k] = v; },
      append(...c: any[]) { this.children.push(...c); },
      replaceChildren(...c: any[]) { this.children = c; },
    });
    return { createElement: make, createTextNode: (t: string) => ({ tag: '#text', textContent: t, children: [] }) };
  }
  const allText = (n: any): string[] => [n.textContent, ...(n.children ?? []).flatMap(allText)].filter(Boolean);
  const receipt = { id: 'R-1', createdAt: new Date().toISOString(), outcome: 'passed', source: 'checkout', receivedFieldNames: ['age_over_21'], storedFieldNames: [], discardedFieldNames: [] };

  it('shows "Issuer not on the trust list (demo setting)" only when the override was used', async () => {
    vi.stubGlobal('document', fakeDocument());
    const { renderReceipt } = await import('../public/render.js');
    const box: any = (document as any).createElement('div');
    renderReceipt(box, { ...receipt, issuerTrust: 'demo-unlisted' });
    expect(allText(box)).toContain('Issuer not on the trust list (demo setting)');
    renderReceipt(box, receipt);
    expect(allText(box)).not.toContain('Issuer not on the trust list (demo setting)');
  });
});
