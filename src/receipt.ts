import { randomUUID } from 'node:crypto';
import { VERIFICATION_COLUMNS, type Db } from './db.js';
import type { FirewallOutput } from './firewall.js';

export type ReceiptSource = 'checkout' | 'claim' | 'gate';

export interface Receipt {
  id: string;
  ticketId: string | null;
  verificationRef: string;
  source: ReceiptSource;
  outcome: string;
  receivedFieldNames: string[];
  storedFieldNames: string[];
  discardedFieldNames: string[];
  createdAt: string;
  /** Only present when the DEMO override accepted an issuer that is not on the trust list. */
  issuerTrust?: 'demo-unlisted';
}

/**
 * Built from the firewall's real output and the real column list. Names only, never values.
 * `kept` says whether the server actually stored a verification result for this attempt.
 */
export function buildReceipt(args: {
  ticketId: string | null;
  verificationRef: string;
  fw: FirewallOutput;
  source: ReceiptSource;
  kept: boolean;
}): Receipt {
  return {
    id: 'R-' + randomUUID().slice(0, 8).toUpperCase(),
    ticketId: args.ticketId,
    verificationRef: args.verificationRef,
    source: args.source,
    outcome: args.fw.outcome,
    receivedFieldNames: args.fw.receivedFieldNames,
    storedFieldNames: args.kept ? [...VERIFICATION_COLUMNS] : [],
    discardedFieldNames: args.fw.discardedFieldNames,
    createdAt: new Date().toISOString(),
    ...(args.fw.issuerTrust ? { issuerTrust: args.fw.issuerTrust } : {}),
  };
}

export function saveReceipt(db: Db, r: Receipt): void {
  db.prepare(
    `insert into privacy_receipts
     (id, ticket_id, verification_ref, source, outcome, received_field_names, stored_field_names, discarded_field_names, created_at, issuer_trust)
     values (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    r.id,
    r.ticketId,
    r.verificationRef,
    r.source,
    r.outcome,
    JSON.stringify(r.receivedFieldNames),
    JSON.stringify(r.storedFieldNames),
    JSON.stringify(r.discardedFieldNames),
    r.createdAt,
    r.issuerTrust ?? null,
  );
}

export function loadReceipt(db: Db, id: string): Receipt | null {
  const row = db.prepare('select * from privacy_receipts where id = ?').get(id) as any;
  if (!row) return null;
  return {
    id: row.id,
    ticketId: row.ticket_id,
    verificationRef: row.verification_ref,
    source: row.source,
    outcome: row.outcome,
    receivedFieldNames: JSON.parse(row.received_field_names),
    storedFieldNames: JSON.parse(row.stored_field_names),
    discardedFieldNames: JSON.parse(row.discarded_field_names),
    createdAt: row.created_at,
    ...(row.issuer_trust ? { issuerTrust: row.issuer_trust } : {}),
  };
}
