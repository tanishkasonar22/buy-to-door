import { findClaim } from './firewall.js';
import type { RawVerification } from './identity.js';

/**
 * DEV_INSPECT only: the raw verifier response, made safe to print. The structure and every key name
 * are kept, so you can see where the age claim sits. Values are not: a portrait becomes
 * "[portrait omitted, N bytes]", and every other string or number becomes "[redacted string, N chars]"
 * or "[redacted number]". Only true/false and null are printed as they are, because a yes/no answer
 * is what the firewall decides on. The authentication block is printed separately, in full.
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
  if (typeof node === 'string') return `[redacted string, ${node.length} chars]`;
  if (typeof node === 'number' || typeof node === 'bigint') return '[redacted number]';
  if (!node || typeof node !== 'object') return node; // booleans, null, undefined
  const obj = node as Record<string, unknown>;
  const isPortraitPair = typeof obj.elementIdentifier === 'string' && isPortrait(obj.elementIdentifier) && 'elementValue' in obj;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = isPortrait(k) || (isPortraitPair && k === 'elementValue') ? omitted(v) : redact(v, depth + 1);
  }
  return out;
}

/** The authentication block(s): flags and short error strings, never personal data. */
function authenticationOf(details: unknown): unknown {
  const found = findClaim(details, 'authentication').map((f) => f.value).filter((v) => v && typeof v === 'object');
  if (found.length === 0) return null;
  return found.length === 1 ? found[0] : found;
}

/**
 * One log line: res, cancelled and the authentication block in full (for diagnosing for example
 * issuerRecognized: false or a certValidationError), then the rest of resDetails with every
 * portrait redacted and the length capped.
 */
export function redactForLog(raw: RawVerification): string {
  let details: unknown = raw.resDetails;
  let authentication: unknown = null;
  if (typeof raw.resDetails === 'string') {
    try {
      const parsed = JSON.parse(raw.resDetails);
      authentication = authenticationOf(parsed); // flags and short error strings: printed in full
      details = redact(parsed);
    } catch {
      // Not JSON (for example an error description). Never print an unbounded blob.
      details = raw.resDetails.length > 500 ? `[${Buffer.byteLength(raw.resDetails)} bytes of non-JSON text omitted]` : raw.resDetails;
    }
  } else {
    authentication = authenticationOf(details);
    details = redact(details);
  }
  const head = JSON.stringify({ res: raw.res, cancelled: raw.cancelled ?? false, authentication });
  const rest = JSON.stringify(details) ?? '';
  return `${head.length > MAX_TEXT ? `${head.slice(0, MAX_TEXT)}… [truncated]` : head} resDetails=${rest.length > MAX_TEXT ? `${rest.slice(0, MAX_TEXT)}… [truncated]` : rest}`;
}
