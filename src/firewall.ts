import type { RawVerification } from './identity.js';

export type Outcome = 'passed' | 'failed' | 'cancelled' | 'indeterminate';

/**
 * The only shape the rest of the server may see.
 * No field values are ever carried here, only field NAMES.
 */
export interface FirewallOutput {
  outcome: Outcome;
  reason: string;
  receivedFieldNames: string[];
  discardedFieldNames: string[];
  /** Set only when the DEMO override accepted an issuer that is not on the trust list. */
  issuerTrust?: 'demo-unlisted';
}

export interface FirewallOptions {
  /**
   * DEMO ONLY (real mode, default off): when the ONLY failing check is issuerRecognized === false
   * (res true; issuerSignedAuthenticated, deviceSignedAuthenticated and dataIntegrity all true),
   * continue to the age check instead of denying. While on, any correctly self-signed credential
   * passes, so the age check can be forged.
   */
  acceptUnlistedIssuer?: boolean;
}

export const DEFAULT_AGE_CLAIM_KEY = 'age_over_21';
const resolveAgeKey = (ageClaimKey: string) => ageClaimKey?.trim() || DEFAULT_AGE_CLAIM_KEY;
const MAX_DEPTH = 12;

type Node = unknown;
interface Found { value: unknown; siblings: string[] }

/** An ISO 18013-5 style list of { elementIdentifier, elementValue } items, or null. */
function elementPairs(list: Node[]): { name: string; value: unknown }[] | null {
  const pairs = list.filter(
    (x): x is Record<string, unknown> => !!x && typeof x === 'object' && typeof (x as any).elementIdentifier === 'string' && 'elementValue' in (x as any),
  );
  return pairs.length ? pairs.map((p) => ({ name: p.elementIdentifier as string, value: p.elementValue })) : null;
}

/**
 * Every place a claim appears anywhere in the response: as an object key at any depth, or as an
 * elementIdentifier/elementValue pair inside an array. Also returns the names next to it.
 */
export function findClaim(node: Node, key: string, depth = 0, out: Found[] = []): Found[] {
  if (depth > MAX_DEPTH || node === null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    const pairs = elementPairs(node);
    if (pairs) for (const p of pairs) if (p.name === key) out.push({ value: p.value, siblings: pairs.map((x) => x.name) });
    for (const item of node) findClaim(item, key, depth + 1, out);
    return out;
  }
  const obj = node as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(obj, key)) out.push({ value: obj[key], siblings: Object.keys(obj) });
  for (const value of Object.values(obj)) findClaim(value, key, depth + 1, out);
  return out;
}

/**
 * The data firewall. This is the only code that reads a raw verifier response.
 * It reduces the response to a decision and a list of dropped field names.
 *
 * The age claim is searched for wherever the verifier put it (top level, under `identity`, under a
 * namespace such as org.iso.18013.5.1, or in an elementIdentifier/elementValue list). Only a real
 * boolean counts: true passes, false is under age, missing is indeterminate. Anything else (the
 * string "true", 1, an object) fails as unreadable, so a malformed answer can never let someone in.
 */
export function applyFirewall(raw: RawVerification, ageClaimKey: string, options: FirewallOptions = {}): FirewallOutput {
  const key = resolveAgeKey(ageClaimKey);
  const base = { receivedFieldNames: [] as string[], discardedFieldNames: [] as string[] };

  if (raw.cancelled) return { ...base, outcome: 'cancelled', reason: 'wallet_cancelled' };
  if (!raw.res) return { ...base, outcome: 'failed', reason: 'verification_failed' };

  let details: any;
  try {
    details = JSON.parse(raw.resDetails);
  } catch {
    return { ...base, outcome: 'failed', reason: 'unreadable_response' };
  }

  const doc = details?.documents?.[0] ?? details;
  const identity: Record<string, unknown> =
    doc && typeof doc.identity === 'object' && doc.identity ? doc.identity : {};
  const auth: Record<string, unknown> =
    doc && typeof doc.authentication === 'object' && doc.authentication ? doc.authentication : {};

  const found = findClaim(details, key);
  // Field NAMES only: the identity block, whatever sits next to the age claim, and the portrait
  // if the verifier sent one anywhere. Values are never copied out of this function.
  const names = new Set(Object.keys(identity));
  for (const f of found) for (const n of f.siblings) names.add(n);
  if (findClaim(details, 'portrait').length) names.add('portrait');
  const receivedFieldNames = [...names].sort();
  const discardedFieldNames = receivedFieldNames.filter((k) => k !== key);
  const out = { receivedFieldNames, discardedFieldNames };

  const checks = ['issuerRecognized', 'issuerSignedAuthenticated', 'deviceSignedAuthenticated', 'dataIntegrity'];
  let marked: FirewallOutput['issuerTrust'];
  if (checks.some((k) => auth[k] === false)) {
    const onlyIssuerUnlisted =
      options.acceptUnlistedIssuer === true && raw.res === true && auth.issuerRecognized === false &&
      auth.issuerSignedAuthenticated === true && auth.deviceSignedAuthenticated === true && auth.dataIntegrity === true;
    if (!onlyIssuerUnlisted) return { ...out, outcome: 'failed', reason: 'authentication_checks_failed' };
    marked = 'demo-unlisted'; // DEMO ONLY: carry on to the age check, and say so everywhere
  }
  const res = marked ? { ...out, issuerTrust: marked } : out;

  const values = found.map((f) => f.value).filter((v) => v !== undefined && v !== null);
  if (values.length === 0) return { ...res, outcome: 'indeterminate', reason: 'age_claim_missing' };
  if (values.some((v) => typeof v !== 'boolean')) return { ...res, outcome: 'failed', reason: 'unreadable_response' };
  if (values.every((v) => v === true)) return { ...res, outcome: 'passed', reason: 'age_confirmed' };
  return { ...res, outcome: 'failed', reason: 'under_age' };
}

const AUTH_FLAGS = [
  'issuerRecognized', 'issuerSignedAuthenticated', 'deviceSignedAuthenticated', 'dataIntegrity', 'issuerAuthValid', 'deviceAuthValid',
] as const;
const CERT_ERROR_MAX = 200;

/**
 * For the server log when the authentication checks fail: the top-level `res`, the six
 * authentication flags, and certValidationError. Flags print only as true/false (otherwise
 * "missing" or "not-boolean", never the value). certValidationError is a certificate error text:
 * whitespace flattened, cut to 200 characters, JSON-quoted. No claim value is ever read here.
 */
export function authDiagnostics(raw: RawVerification): string {
  let auth: Record<string, unknown> = {};
  try {
    const details = JSON.parse(raw.resDetails);
    const doc = details?.documents?.[0] ?? details;
    if (doc && typeof doc.authentication === 'object' && doc.authentication) auth = doc.authentication;
  } catch {
    // Not JSON: every flag reports as missing.
  }
  const flag = (v: unknown) => (typeof v === 'boolean' ? String(v) : v === undefined || v === null ? 'missing' : 'not-boolean');
  const cert = auth.certValidationError;
  const certText =
    cert === undefined || cert === null ? 'missing'
      : typeof cert !== 'string' ? 'not-string'
        : JSON.stringify(cert.replace(/\s+/g, ' ').trim().slice(0, CERT_ERROR_MAX));
  return [`res=${flag(raw.res)}`, ...AUTH_FLAGS.map((k) => `${k}=${flag(auth[k])}`), `certValidationError=${certText}`].join(' ');
}

/** Key path segment: plain keys as .key, keys with dots or spaces as ["key"], array items as [i]. */
const segment = (path: string, key: string) =>
  /^[A-Za-z_$][\w$]*$/.test(key) ? (path ? `${path}.${key}` : key) : `${path}[${JSON.stringify(key)}]`;

/** Like findClaim, in the same order, but records the key path of each copy instead of its neighbours. */
function locateClaim(node: unknown, key: string, path = '', depth = 0, out: { value: unknown; path: string }[] = []) {
  if (depth > MAX_DEPTH || node === null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    node.forEach((item, i) => {
      const pair = item as Record<string, unknown> | null;
      if (pair && typeof pair === 'object' && pair.elementIdentifier === key && 'elementValue' in pair) {
        out.push({ value: pair.elementValue, path: `${path}[${i}].elementValue` });
      }
    });
    node.forEach((item, i) => locateClaim(item, key, `${path}[${i}]`, depth + 1, out));
    return out;
  }
  const obj = node as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(obj, key)) out.push({ value: obj[key], path: segment(path, key) });
  for (const [k, v] of Object.entries(obj)) locateClaim(v, key, segment(path, k), depth + 1, out);
  return out;
}

const typeOf = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'bigint' ? 'number' : typeof v);

/**
 * For the server log when the age claim could not be used (unreadable_response or
 * age_claim_missing): the claim's TYPE and key PATH, and for a string only its length and whether
 * it reads as "true"/"false" (case-insensitive). Never a value. The copy reported is the first one
 * that is not a usable boolean, so it is the one that caused the decision.
 */
export function ageClaimDiagnostics(raw: RawVerification, ageClaimKey: string): string {
  let details: unknown;
  try {
    details = JSON.parse(raw.resDetails);
  } catch {
    return 'resDetails=unparseable ageClaimType=missing ageClaimPath=(none)';
  }
  const found = locateClaim(details, resolveAgeKey(ageClaimKey));
  const pick = found.find((f) => typeof f.value !== 'boolean' && f.value !== null && f.value !== undefined) ?? found[0];
  if (!pick) return 'ageClaimType=missing ageClaimPath=(none)';
  const parts = [`ageClaimType=${typeOf(pick.value)}`, `ageClaimPath=${pick.path}`];
  if (typeof pick.value === 'string') {
    const lower = pick.value.toLowerCase();
    parts.push(`ageClaimLength=${pick.value.length}`, `ageClaimString=${lower === 'true' ? 'true-like' : lower === 'false' ? 'false-like' : 'other'}`);
  }
  return parts.join(' ');
}
