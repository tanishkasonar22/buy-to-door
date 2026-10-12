import type { Db } from './db.js';

/**
 * Audit export: one row per thing that happened, oldest first.
 * Built from an explicit column list so nothing else can leak in: no claim token hashes,
 * ticket tokens, session IDs, verification references or wallet data.
 */
export const AUDIT_COLUMNS = [
  'time', 'event', 'ticket_id', 'order_id', 'id_check', 'method', 'result', 'reason',
  'gate', 'duration_ms', 'simulated', 'staff_recorded',
] as const;

export type AuditRow = Partial<Record<(typeof AUDIT_COLUMNS)[number], string | number | null>> & { time: string; event: string };

/** One CSV cell. Defends against spreadsheet formulas and quotes only when needed. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const idCheckOf = (t: { gate_check: number; age_verified: number }) => (t.gate_check ? 'gate' : t.age_verified ? 'online' : null);

export function buildAuditRows(db: Db): AuditRow[] {
  const rows: AuditRow[] = [];

  for (const e of db.prepare('select step, reason, ts from checkout_events').all() as any[]) {
    rows.push({ time: e.ts, event: `checkout:${e.step}`, reason: e.reason });
  }

  for (const o of db.prepare('select id, created_at from orders').all() as any[]) {
    rows.push({ time: o.created_at, event: 'order_created', order_id: o.id });
  }

  for (const t of db.prepare('select id, order_id, age_verified, gate_check, created_at, claimed_at from tickets').all() as any[]) {
    const base = { ticket_id: t.id, order_id: t.order_id, id_check: idCheckOf(t) };
    rows.push({ time: t.created_at, event: 'ticket_created', ...base });
    if (t.claimed_at) rows.push({ time: t.claimed_at, event: 'ticket_claimed', ...base });
  }

  // DEMO override: every verification accepted from an issuer that is not on the trust list.
  const overridden = db
    .prepare(
      `select r.created_at, r.ticket_id, t.order_id, r.issuer_trust
       from privacy_receipts r left join tickets t on t.id = r.ticket_id where r.issuer_trust is not null`,
    )
    .all() as any[];
  for (const r of overridden) {
    rows.push({ time: r.created_at, event: 'issuer_trust', ticket_id: r.ticket_id, order_id: r.order_id, reason: `issuerTrust=${r.issuer_trust}` });
  }

  const scans = db
    .prepare(
      `select s.ticket_id, t.order_id, s.gate_id, s.method, s.result, s.reason, s.duration_ms, s.simulated, s.staff_recorded, s.ts
       from scans s left join tickets t on t.id = s.ticket_id`,
    )
    .all() as any[];
  for (const s of scans) {
    rows.push({
      time: s.ts, event: 'gate_scan', ticket_id: s.ticket_id, order_id: s.order_id, method: s.method,
      result: s.result, reason: s.reason, gate: s.gate_id, duration_ms: s.duration_ms,
      simulated: s.simulated, staff_recorded: s.staff_recorded,
    });
  }

  // Stable sort, so rows with the same timestamp keep the order they were collected in.
  return rows.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
}

export function buildAuditCsv(db: Db): string {
  const lines = [AUDIT_COLUMNS.join(',')];
  for (const r of buildAuditRows(db)) lines.push(AUDIT_COLUMNS.map((c) => csvCell(r[c])).join(','));
  return lines.join('\r\n') + '\r\n';
}
