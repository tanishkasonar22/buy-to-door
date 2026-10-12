import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = Database.Database;

/** The only verification data any table is allowed to hold. Receipts read this list. */
export const VERIFICATION_COLUMNS = ['age_verified', 'verified_at', 'verification_ref'] as const;

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');

  // Demo data only: an older phase 1 tickets table has no order_id, so rebuild it.
  const old = db.prepare('pragma table_info(tickets)').all() as { name: string }[];
  if (old.length > 0 && !old.some((c) => c.name === 'order_id')) db.exec('drop table tickets');

  db.exec(`
    create table if not exists orders (
      id text primary key,
      event_id text not null,
      quantity integer not null,
      created_at text not null
    );
    create table if not exists tickets (
      id text primary key,
      event_id text not null,
      order_id text,
      status text not null,
      age_verified integer not null default 0,
      verified_at text,
      verification_ref text,
      claim_token_hash text,
      claim_expires_at text,
      claimed_at text,
      created_at text not null,
      gate_check integer not null default 0
    );
    create index if not exists idx_tickets_claim on tickets(claim_token_hash);
    create table if not exists privacy_receipts (
      id text primary key,
      ticket_id text,
      verification_ref text not null,
      source text not null,
      outcome text not null,
      received_field_names text not null,
      stored_field_names text not null,
      discarded_field_names text not null,
      created_at text not null
    );
    create table if not exists checkout_events (
      id integer primary key autoincrement,
      session_id text,
      step text not null,
      reason text,
      ts text not null
    );
    create table if not exists scans (
      id integer primary key autoincrement,
      ticket_id text,
      gate_id text not null,
      method text not null,
      result text not null,
      reason text,
      duration_ms integer,
      simulated integer not null,
      staff_recorded integer not null,
      receipt_id text,
      ts text not null
    );
  `);

  // gate_check = 1: bought or claimed without a mobile ID, so the age is checked at the gate.
  const cols = db.prepare('pragma table_info(tickets)').all() as { name: string }[];
  if (!cols.some((c) => c.name === 'gate_check')) {
    db.exec('alter table tickets add column gate_check integer not null default 0');
  }
  return db;
}

export function allColumns(db: Db): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const tables = db
    .prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%'")
    .all() as { name: string }[];
  for (const { name } of tables) {
    out[name] = (db.prepare(`pragma table_info(${name})`).all() as { name: string }[]).map((c) => c.name);
  }
  return out;
}
