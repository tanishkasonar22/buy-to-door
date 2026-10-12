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
}

export const DEFAULT_AGE_CLAIM_KEY = 'age_over_21';
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
export function applyFirewall(raw: RawVerification, ageClaimKey: string): FirewallOutput {
  const key = ageClaimKey?.trim() || DEFAULT_AGE_CLAIM_KEY;
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
  if (checks.some((k) => auth[k] === false)) {
    return { ...out, outcome: 'failed', reason: 'authentication_checks_failed' };
  }

  const values = found.map((f) => f.value).filter((v) => v !== undefined && v !== null);
  if (values.length === 0) return { ...out, outcome: 'indeterminate', reason: 'age_claim_missing' };
  if (values.some((v) => typeof v !== 'boolean')) return { ...out, outcome: 'failed', reason: 'unreadable_response' };
  if (values.every((v) => v === true)) return { ...out, outcome: 'passed', reason: 'age_confirmed' };
  return { ...out, outcome: 'failed', reason: 'under_age' };
}
