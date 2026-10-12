import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { CredenceVerifier, HybridVerifier } from '../src/identity.js';
import { stripReaderAuthAll } from '../src/stripReaderAuth.js';
import { buy, setup } from './helpers.js';

// ---- A tiny CBOR encoder, just enough to hand-build DeviceRequest-shaped maps ----
const head = (major: number, n: number): number[] => {
  if (n < 24) return [(major << 5) | n];
  if (n < 0x100) return [(major << 5) | 24, n];
  if (n < 0x10000) return [(major << 5) | 25, n >> 8, n & 0xff];
  return [(major << 5) | 26, (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
};
const text = (s: string) => [...head(3, Buffer.byteLength(s)), ...Buffer.from(s)];
const bytes = (b: number[]) => [...head(2, b.length), ...b];
const array = (...items: number[][]) => [...head(4, items.length), ...items.flat()];
const map = (...pairs: [number[], number[]][]) => [...head(5, pairs.length), ...pairs.flatMap(([k, v]) => [...k, ...v])];
const tag = (t: number, item: number[]) => [...head(6, t), ...item];
const b64 = (b: number[]) => Buffer.from(b).toString('base64url');

// itemsRequest is a tag-24 byte string (encoded CBOR); readerAuth is a COSE_Sign1-shaped array.
const itemsRequest = tag(24, bytes(map(
  [text('docType'), text('org.iso.18013.5.1.mDL')],
  [text('nameSpaces'), map([text('org.iso.18013.5.1'), map([text('age_over_21'), [0xf5]], [text('portrait'), [0xf4]])])],
)));
const docRequest = map([text('itemsRequest'), itemsRequest], [text('readerAuth'), array(bytes([1, 2, 3]), map(), [0xf6], bytes(new Array(300).fill(7)))]);
const versionEntry: [number[], number[]] = [text('version'), text('1.1')];
const docRequestsEntry: [number[], number[]] = [text('docRequests'), array(docRequest)];
// A reader chain long enough to need 1- and 2-byte length headers.
const readerAuthAllEntry: [number[], number[]] = [text('readerAuthAll'), array(array(bytes(new Array(40).fill(9)), map(), [0xf6], bytes(new Array(1200).fill(5))))];

describe('stripReaderAuthAll', () => {
  it('removes only readerAuthAll and keeps every other entry byte-identical, in order', () => {
    const input = map(versionEntry, readerAuthAllEntry, docRequestsEntry);
    const { value, removed } = stripReaderAuthAll(b64(input));
    expect(removed).toBe(true);
    const out = [...Buffer.from(value, 'base64url')];
    // A map of 2 entries (0xa2), then the untouched version and docRequests entries.
    expect(out).toEqual([0xa2, ...versionEntry.flat(), ...docRequestsEntry.flat()]);
    // The itemsRequest bytes in particular survive exactly.
    expect(Buffer.from(out).includes(Buffer.from(itemsRequest))).toBe(true);
  });

  it('works when readerAuthAll is the last entry', () => {
    const { value, removed } = stripReaderAuthAll(b64(map(versionEntry, docRequestsEntry, readerAuthAllEntry)));
    expect(removed).toBe(true);
    expect([...Buffer.from(value, 'base64url')]).toEqual([0xa2, ...versionEntry.flat(), ...docRequestsEntry.flat()]);
  });

  it('returns a request without readerAuthAll exactly as it was given', () => {
    const original = b64(map(versionEntry, docRequestsEntry));
    expect(stripReaderAuthAll(original)).toEqual({ value: original, removed: false });
  });

  it('does not touch a per-document readerAuth (only the top-level readerAuthAll)', () => {
    const original = b64(map(versionEntry, docRequestsEntry));
    expect(stripReaderAuthAll(original).value).toBe(original);
  });

  it('rejects something that is not a small CBOR map', () => {
    expect(() => stripReaderAuthAll(b64(array(text('x'))))).toThrow('not a small CBOR map');
  });
});

describe('/api/verify/start and /api/claims/:token/start in real mode', () => {
  const withReaderAuth = b64(map(versionEntry, docRequestsEntry, readerAuthAllEntry));
  const stripped = b64(map(versionEntry, docRequestsEntry));

  function app(mode: 'real' | 'hybrid', options: { stripReaderAuth?: boolean } = {}) {
    const client = {
      async getDocRequest() {
        return { sessionId: `sdk-${Math.random()}`, dcRequest: { deviceRequest: withReaderAuth, encryptionInfo: 'enc-info-unchanged' } };
      },
      async verifyDocRequest() {
        return { res: true, resDetails: JSON.stringify({ age_over_21: true }) };
      },
    };
    const logs: string[] = [];
    const verifier = mode === 'real' ? new CredenceVerifier(client as any) : new HybridVerifier(client);
    // These tests are about the readerAuthAll step only, so the (separately tested) narrowing is off here.
    return { logs, ...setup({ verifier, mode, narrowRequest: false, ...options, log: (...a) => logs.push(a.join(' ')) }) };
  }

  it('returns a stripped deviceRequest, leaves encryptionInfo alone, and logs one line without contents', async () => {
    const { app: a, logs } = app('real');
    const res = await request(a).post('/api/verify/start').expect(200);
    expect(res.body.dcRequest).toEqual({ deviceRequest: stripped, encryptionInfo: 'enc-info-unchanged' });
    expect(logs).toEqual(['[dc] removed readerAuthAll (verifier reader chain rejected by wallet)']);
  });

  it('strips it for guest claims too', async () => {
    const { app: a, logs } = app('real');
    const start = await request(a).post('/api/verify/start');
    const order = await request(a).post('/api/verify/confirm').send({ sessionId: start.body.sessionId, data: 'wallet', quantity: 2 });
    const token = new URL(order.body.order.claimLinks[0].path, 'http://x').searchParams.get('t')!;
    const claim = await request(a).post(`/api/claims/${token}/start`).expect(200);
    expect(claim.body.dcRequest).toEqual({ deviceRequest: stripped, encryptionInfo: 'enc-info-unchanged' });
    expect(logs.filter((l) => l.startsWith('[dc] removed readerAuthAll'))).toHaveLength(2);
  });

  it('sends the request unchanged when switched off (DC_KEEP_READER_AUTH)', async () => {
    const { app: a, logs } = app('real', { stripReaderAuth: false });
    const res = await request(a).post('/api/verify/start').expect(200);
    expect(res.body.dcRequest.deviceRequest).toBe(withReaderAuth);
    expect(logs).toEqual([]);
  });

  it('never touches hybrid mode', async () => {
    const { app: a, logs } = app('hybrid');
    const res = await request(a).post('/api/verify/start').expect(200);
    expect(res.body.dcRequest.deviceRequest).toBe(withReaderAuth);
    expect(logs).toEqual([]);
  });

  it('never touches mock mode', async () => {
    const { app: a } = setup();
    const res = await request(a).post('/api/verify/start').expect(200);
    expect(res.body.dcRequest).toEqual({ mock: true });
    expect((await buy(a, 'pass')).body.outcome).toBe('passed');
  });

  it('sends an unparseable deviceRequest unchanged instead of failing the purchase', async () => {
    const client = {
      async getDocRequest() { return { sessionId: 's1', dcRequest: { deviceRequest: 'not-cbor', encryptionInfo: 'e' } }; },
      async verifyDocRequest() { return { res: false, resDetails: '' }; },
    };
    const logs: string[] = [];
    const { app: a } = setup({ verifier: new CredenceVerifier(client as any), mode: 'real', log: (...x) => logs.push(x.join(' ')) });
    const res = await request(a).post('/api/verify/start').expect(200);
    expect(res.body.dcRequest.deviceRequest).toBe('not-cbor');
    expect(logs).toEqual(['[dc] deviceRequest could not be parsed as CBOR; sent unchanged']);
  });
});
