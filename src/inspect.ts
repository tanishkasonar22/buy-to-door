import type { RawVerification } from './identity.js';

/**
 * DEV_INSPECT only: the raw verifier response, made safe to print. Every portrait is replaced with
 * "[portrait omitted, N bytes]", whether it is a `portrait` key at any depth or an
 * elementIdentifier/elementValue pair. Other values are printed as received.
 */
const MAX_DEPTH = 12;
const MAX_TEXT = 4000;

const sizeOf = (v: unknown): number => {
  if (typeof v === 'string') return Buffer.byteLength(v);
  if (Array.isArray(v) || ArrayBuffer.isView(v)) return (v as { length: number }).length;
  try { return Buffer.byteLength(JSON.stringify(v) ?? ''); } catch { return 0; }
};
const omitted = (v: unknown) => `[portrait omitted, ${sizeOf(v)} bytes]`;
const isPortrait = (k: string) => k.toLowerCase() === 'portrait';

function redact(node: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[nested too deep]';
  if (Array.isArray(node)) return node.map((x) => redact(x, depth + 1));
  if (!node || typeof node !== 'object') return node;
  const obj = node as Record<string, unknown>;
  const isPortraitPair = typeof obj.elementIdentifier === 'string' && isPortrait(obj.elementIdentifier) && 'elementValue' in obj;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = isPortrait(k) || (isPortraitPair && k === 'elementValue') ? omitted(v) : redact(v, depth + 1);
  }
  return out;
}

export function redactForLog(raw: RawVerification): string {
  let details: unknown = raw.resDetails;
  if (typeof raw.resDetails === 'string') {
    try {
      details = redact(JSON.parse(raw.resDetails));
    } catch {
      // Not JSON (for example an error description). Never print an unbounded blob.
      details = raw.resDetails.length > 500 ? `[${Buffer.byteLength(raw.resDetails)} bytes of non-JSON text omitted]` : raw.resDetails;
    }
  } else {
    details = redact(details);
  }
  const text = JSON.stringify({ res: raw.res, cancelled: raw.cancelled, resDetails: details });
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}… [truncated]` : text;
}
