// DEMO WORKAROUND (real mode only). Narrows the mDL docRequest in a base64url CBOR DeviceRequest so
// it asks for ONLY age_over_21 (namespace org.iso.18013.5.1, intentToRetain false). The locked
// Credence profile asks for more (for example portrait), which the shop never uses.
//
// Only the containers on the path to that mDL request's nameSpaces are rebuilt: the top-level map,
// the docRequests array, the mDL docRequest map, its tag-24 itemsRequest and the map inside it.
// Every other byte (version, deviceRequestInfo, other docRequests, readerAuth, docType,
// requestInfo, ...) is copied as is. Note: a reader signature over the original itemsRequest no
// longer matches after this change.

import { itemEnd } from './stripReaderAuth.js';

export const MDL_DOCTYPE = 'org.iso.18013.5.1.mDL';
const MDL_NAMESPACE = 'org.iso.18013.5.1';
const AGE_ELEMENT = 'age_over_21';

interface Head { major: number; arg: number; end: number }

/** Reads a CBOR head (definite lengths only), returning where its content starts. */
function readHead(b: Uint8Array, pos: number): Head {
  const ib = b[pos];
  if (ib === undefined) throw new Error('CBOR ended early');
  const major = ib >> 5;
  const ai = ib & 31;
  let p = pos + 1;
  let arg: number;
  if (ai < 24) arg = ai;
  else if (ai === 24) { arg = b[p]!; p += 1; }
  else if (ai === 25) { arg = (b[p]! << 8) | b[p + 1]!; p += 2; }
  else if (ai === 26) { arg = ((b[p]! << 24) >>> 0) + ((b[p + 1]! << 16) | (b[p + 2]! << 8) | b[p + 3]!); p += 4; }
  else throw new Error('unsupported CBOR length');
  return { major, arg, end: p };
}

/** Minimal CBOR head for a major type and length. */
function encodeHead(major: number, n: number): Uint8Array {
  const m = major << 5;
  if (n < 24) return Uint8Array.of(m | n);
  if (n < 0x100) return Uint8Array.of(m | 24, n);
  if (n < 0x10000) return Uint8Array.of(m | 25, n >> 8, n & 0xff);
  return Uint8Array.of(m | 26, (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
}

const concat = (parts: Uint8Array[]) => Uint8Array.from(Buffer.concat(parts));
const text = (s: string) => concat([encodeHead(3, Buffer.byteLength(s)), Buffer.from(s)]);
const sameBytes = (a: Uint8Array, b: Uint8Array) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

function readText(b: Uint8Array, pos: number): string | null {
  const h = readHead(b, pos);
  return h.major === 3 ? new TextDecoder().decode(b.slice(h.end, h.end + h.arg)) : null;
}

interface Entry { key: string | null; keyBytes: Uint8Array; valStart: number; valEnd: number }

/** The entries of a CBOR map at `pos`, with the original head bytes. */
function mapAt(b: Uint8Array, pos: number): { head: Uint8Array; entries: Entry[] } {
  const h = readHead(b, pos);
  if (h.major !== 5) throw new Error('expected a CBOR map');
  const entries: Entry[] = [];
  let p = h.end;
  for (let i = 0; i < h.arg; i++) {
    const keyEnd = itemEnd(b, p);
    const valEnd = itemEnd(b, keyEnd);
    entries.push({ key: readText(b, p), keyBytes: b.slice(p, keyEnd), valStart: keyEnd, valEnd });
    p = valEnd;
  }
  return { head: b.slice(pos, h.end), entries };
}

/** { "org.iso.18013.5.1": { "age_over_21": false } } */
const AGE_ONLY_NAMESPACES = concat([encodeHead(5, 1), text(MDL_NAMESPACE), encodeHead(5, 1), text(AGE_ELEMENT), Uint8Array.of(0xf4)]);

/** The narrowed itemsRequest map bytes, or null when this is not an mDL request. */
function narrowItemsRequestMap(m: Uint8Array): Uint8Array | null {
  const { head, entries } = mapAt(m, 0);
  const docType = entries.find((e) => e.key === 'docType');
  if (!docType || readText(m, docType.valStart) !== MDL_DOCTYPE) return null;
  const parts: Uint8Array[] = [];
  let hasNameSpaces = false;
  for (const e of entries) {
    parts.push(e.keyBytes);
    if (e.key === 'nameSpaces') {
      hasNameSpaces = true;
      parts.push(AGE_ONLY_NAMESPACES);
    } else {
      parts.push(m.slice(e.valStart, e.valEnd));
    }
  }
  if (!hasNameSpaces) parts.push(text('nameSpaces'), AGE_ONLY_NAMESPACES);
  return concat([hasNameSpaces ? head : encodeHead(5, entries.length + 1), ...parts]);
}

/** A docRequest with its mDL itemsRequest narrowed, or null when nothing changes. */
function narrowDocRequest(b: Uint8Array, pos: number): Uint8Array | null {
  const { head, entries } = mapAt(b, pos);
  const items = entries.find((e) => e.key === 'itemsRequest');
  if (!items) return null;
  const tag = readHead(b, items.valStart);
  if (tag.major !== 6 || tag.arg !== 24) return null;
  const bstr = readHead(b, tag.end);
  if (bstr.major !== 2) return null;
  const inner = b.slice(bstr.end, bstr.end + bstr.arg);
  const narrowed = narrowItemsRequestMap(inner);
  if (!narrowed || sameBytes(narrowed, inner)) return null;
  const newItems = concat([b.slice(items.valStart, tag.end), encodeHead(2, narrowed.length), narrowed]);
  return concat([head, ...entries.flatMap((e) => [e.keyBytes, e === items ? newItems : b.slice(e.valStart, e.valEnd)])]);
}

export function narrowMdlToAgeOver21(deviceRequestB64Url: string): { value: string; changed: boolean } {
  const b = new Uint8Array(Buffer.from(deviceRequestB64Url, 'base64url'));
  const top = mapAt(b, 0);
  const docs = top.entries.find((e) => e.key === 'docRequests');
  if (!docs) return { value: deviceRequestB64Url, changed: false };
  const arr = readHead(b, docs.valStart);
  if (arr.major !== 4) throw new Error('docRequests is not an array');

  const elements: Uint8Array[] = [];
  let changed = false;
  let p = arr.end;
  for (let i = 0; i < arr.arg; i++) {
    const end = itemEnd(b, p);
    const narrowed = narrowDocRequest(b, p);
    if (narrowed) changed = true;
    elements.push(narrowed ?? b.slice(p, end));
    p = end;
  }
  if (!changed) return { value: deviceRequestB64Url, changed: false };

  const newDocs = concat([b.slice(docs.valStart, arr.end), ...elements]);
  const out = concat([top.head, ...top.entries.flatMap((e) => [e.keyBytes, e === docs ? newDocs : b.slice(e.valStart, e.valEnd)])]);
  return { value: Buffer.from(out).toString('base64url'), changed: true };
}
