// Removes the top-level "readerAuthAll" entry from a base64url CBOR DeviceRequest,
// preserving every other byte exactly (itemsRequest bstrs stay untouched).
// Demo workaround for a reader-certificate name-encoding mismatch in the
// verifier's reader CA chain (wallet rejects the chain before reading the request).

export function itemEnd(b: Uint8Array, pos: number): number {
  const ib = b[pos]!;
  const major = ib >> 5;
  const ai = ib & 31;
  let p = pos + 1;
  let arg = 0;
  if (ai < 24) arg = ai;
  else if (ai === 24) { arg = b[p]!; p += 1; }
  else if (ai === 25) { arg = (b[p]! << 8) | b[p + 1]!; p += 2; }
  else if (ai === 26) { arg = ((b[p]! << 24) >>> 0) + ((b[p + 1]! << 16) | (b[p + 2]! << 8) | b[p + 3]!); p += 4; }
  else if (ai === 27) {
    const hi = ((b[p]! << 24) >>> 0) + ((b[p + 1]! << 16) | (b[p + 2]! << 8) | b[p + 3]!);
    const lo = ((b[p + 4]! << 24) >>> 0) + ((b[p + 5]! << 16) | (b[p + 6]! << 8) | b[p + 7]!);
    arg = hi * 2 ** 32 + lo; p += 8;
  } else if (ai === 31) throw new Error('indefinite-length CBOR not supported');
  else throw new Error('bad CBOR additional info');
  switch (major) {
    case 0: case 1: case 7: return p;
    case 2: case 3: return p + arg;
    case 4: { for (let i = 0; i < arg; i++) p = itemEnd(b, p); return p; }
    case 5: { for (let i = 0; i < arg * 2; i++) p = itemEnd(b, p); return p; }
    case 6: return itemEnd(b, p);
    default: throw new Error('bad CBOR major type');
  }
}

function readTextKey(b: Uint8Array, pos: number): string | null {
  const ib = b[pos]!;
  if (ib >> 5 !== 3) return null;
  const ai = ib & 31;
  if (ai >= 24) return null;
  return new TextDecoder().decode(b.slice(pos + 1, pos + 1 + ai));
}

export function stripReaderAuthAll(deviceRequestB64Url: string): { value: string; removed: boolean } {
  const b = new Uint8Array(Buffer.from(deviceRequestB64Url, 'base64url'));
  const head = b[0]!;
  if (head >> 5 !== 5 || (head & 31) >= 24) throw new Error('DeviceRequest is not a small CBOR map');
  const n = head & 31;
  let p = 1;
  const kept: Uint8Array[] = [];
  let removed = false;
  for (let i = 0; i < n; i++) {
    const keyStart = p;
    const keyEnd = itemEnd(b, keyStart);
    const valEnd = itemEnd(b, keyEnd);
    if (readTextKey(b, keyStart) === 'readerAuthAll') removed = true;
    else kept.push(b.slice(keyStart, valEnd));
    p = valEnd;
  }
  if (!removed) return { value: deviceRequestB64Url, removed: false };
  const out = Buffer.concat([Buffer.from([0xa0 | kept.length]), ...kept]);
  return { value: out.toString('base64url'), removed: true };
}
