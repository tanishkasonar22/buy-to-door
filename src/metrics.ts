import { allColumns, type Db } from './db.js';
import { personalDataShapedColumns } from './privacy.js';

/** Nearest-rank percentile. Returns null for an empty list. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

export function privacySummary(db: Db) {
  const columns = allColumns(db);
  const outcomes = db
    .prepare('select outcome, count(*) as n from privacy_receipts group by outcome')
    .all() as { outcome: string; n: number }[];
  const discarded = new Set<string>();
  for (const r of db.prepare('select discarded_field_names from privacy_receipts').all() as any[]) {
    for (const n of JSON.parse(r.discarded_field_names)) discarded.add(n);
  }
  return {
    verifications: Object.fromEntries(outcomes.map((o) => [o.outcome, o.n])),
    discardedFieldNames: [...discarded].sort(),
    columns,
    personalDataShapedColumns: personalDataShapedColumns(columns),
  };
}

export function buildMetrics(db: Db) {
  const n = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;
  const step = (name: string) => n('select count(*) as n from checkout_events where step = ?', name);

  const funnel = {
    walletPrompted: step('wallet_prompted'),
    verified: step('verified'),
    notVerified: step('not_verified'),
    ordersPlaced: n('select count(*) as n from orders'),
    ticketsTotal: n('select count(*) as n from tickets'),
    unclaimed: n("select count(*) as n from tickets where status = 'unclaimed'"),
    claimed: n('select count(*) as n from tickets where claimed_at is not null'),
    claimsStarted: step('claim_started'),
    claimsFailed: step('claim_failed'),
    entered: n("select count(*) as n from tickets where status = 'used'"),
    noWallet: step('no_wallet_chosen'),
    gateCheckTickets: n('select count(*) as n from tickets where gate_check = 1'),
    gateCheckEntered: n("select count(*) as n from tickets where gate_check = 1 and status = 'used'"),
  };

  const failures: Record<string, number> = {};
  const add = (reason: string | null, count: number) => {
    const key = reason ?? 'unknown';
    failures[key] = (failures[key] ?? 0) + count;
  };
  for (const r of db
    .prepare("select reason, count(*) as n from checkout_events where step in ('not_verified','claim_failed') group by reason")
    .all() as { reason: string | null; n: number }[]) add(r.reason, r.n);
  for (const r of db
    .prepare("select reason, count(*) as n from scans where result = 'fail' group by reason")
    .all() as { reason: string | null; n: number }[]) add(r.reason, r.n);

  const methods: Record<string, { pass: number; fail: number; simulated: boolean; staffRecorded: boolean }> = {};
  for (const r of db
    .prepare('select method, result, simulated, staff_recorded, count(*) as n from scans group by method, result, simulated, staff_recorded')
    .all() as any[]) {
    const m = (methods[r.method] ??= { pass: 0, fail: 0, simulated: !!r.simulated, staffRecorded: !!r.staff_recorded });
    if (r.result === 'pass') m.pass += r.n;
    else m.fail += r.n;
  }

  const durations: Record<string, number[]> = {};
  for (const r of db.prepare('select method, duration_ms from scans where duration_ms is not null').all() as any[]) {
    (durations[r.method] ??= []).push(r.duration_ms);
  }
  const scanTimes = Object.fromEntries(
    Object.entries(durations).map(([method, v]) => [method, { n: v.length, p50: percentile(v, 50), p95: percentile(v, 95) }]),
  );

  const recent = db
    .prepare('select ticket_id as ticketId, gate_id as gateId, method, result, reason, duration_ms as durationMs, simulated, staff_recorded as staffRecorded, ts from scans order by id desc limit 10')
    .all();

  return { funnel, failures, methods, scanTimes, recent, privacy: privacySummary(db) };
}
