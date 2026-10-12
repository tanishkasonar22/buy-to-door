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

/**
 * The data firewall. This is the only code that reads a raw verifier response.
 * It reduces the response to a decision and a list of dropped field names.
 */
export function applyFirewall(raw: RawVerification, ageClaimKey: string): FirewallOutput {
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

  const receivedFieldNames = Object.keys(identity).sort();
  const discardedFieldNames = receivedFieldNames.filter((k) => k !== ageClaimKey);
  const names = { receivedFieldNames, discardedFieldNames };

  const checks = ['issuerRecognized', 'issuerSignedAuthenticated', 'deviceSignedAuthenticated', 'dataIntegrity'];
  if (checks.some((k) => auth[k] === false)) {
    return { ...names, outcome: 'failed', reason: 'authentication_checks_failed' };
  }

  const age = identity[ageClaimKey];
  if (age === true) return { ...names, outcome: 'passed', reason: 'age_confirmed' };
  if (age === false) return { ...names, outcome: 'failed', reason: 'under_age' };
  return { ...names, outcome: 'indeterminate', reason: 'age_claim_missing' };
}
