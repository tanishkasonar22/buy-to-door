import express, { type NextFunction, type Request, type Response } from 'express';
import QRCode from 'qrcode';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { type Db } from './db.js';
import { buildAuditCsv } from './audit.js';
import { applyFirewall } from './firewall.js';
import { redactForLog } from './inspect.js';
import type { IdentityVerifier } from './identity.js';
import { buildMetrics, privacySummary } from './metrics.js';
import { runReadiness, type ReadinessClient } from './readiness.js';
import { buildReceipt, loadReceipt, saveReceipt, type ReceiptSource } from './receipt.js';
import { SdkStats, instrumentVerifier, watchTokenCalls } from './sdkstats.js';
import { makeToken, newTicketId, readToken } from './tickets.js';

export const DEMO_EVENT = {
  id: 'evt-demo',
  name: 'Harbor Nights',
  venue: 'Pier 9 Hall',
  date: 'Saturday 21 November 2026',
  ticket: '21+ general admission',
  note: 'Demo event for a prototype. No payment is taken.',
};

export const MAX_QUANTITY = 6;
const SESSION_TTL_MS = 5 * 60_000;
const CLAIM_ATTEMPT_LIMIT = 10;
const CLAIM_ATTEMPT_WINDOW_MS = 10 * 60_000;

export const SIMULATED_SCENARIOS = ['pass', 'under', 'cancel', 'invalid', 'noage'] as const;
export const PHYSICAL_FAIL_REASONS = ['under_age', 'id_expired', 'id_not_authentic', 'id_unreadable'] as const;
export const OVERRIDE_REASONS = ['no_mobile_id', 'wallet_unsupported', 'device_problem', 'manager_approved'] as const;

type Purpose = 'checkout' | 'claim';

export interface AppDeps {
  verifier: IdentityVerifier;
  db: Db;
  mode: 'mock' | 'hybrid' | 'real';
  ticketSecret: string;
  ageClaimKey: string;
  inspect?: boolean;
  log?: (...args: unknown[]) => void;
  claimTtlHours?: number;
  readinessToken?: string;
  cloud?: { licenseKey: string; profileId: string; origin: string; baseUrl?: string; client?: ReadinessClient };
}

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

export function createApp(deps: AppDeps) {
  const { db, mode, ticketSecret, ageClaimKey } = deps;
  // SDK proof panel. In mock mode nothing is wrapped, so the counters can never claim a live call.
  const sdkStats = new SdkStats();
  const verifier = mode === 'mock' ? deps.verifier : instrumentVerifier(deps.verifier, sdkStats);
  if (mode !== 'mock') watchTokenCalls(deps.cloud?.client, sdkStats);
  const log = deps.log ?? (() => {});
  const claimTtlMs = (deps.claimTtlHours ?? 48) * 3_600_000;
  const sessions = new Map<string, { createdAt: number; purpose: Purpose; ticketId?: string }>();
  // Answers from the separate simulated wallet page, keyed by session. Never used in real mode.
  const walletReplies = new Map<string, { status: 'shared' | 'declined'; data?: string; at: number }>();
  const attempts = new Map<string, number[]>();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(express.json({ limit: '2mb' }));
  app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));

  const step = (sessionId: string | null, name: string, reason?: string) =>
    db
      .prepare('insert into checkout_events (session_id, step, reason, ts) values (?,?,?,?)')
      .run(sessionId, name, reason ?? null, new Date().toISOString());

  const takeSession = (sessionId: unknown, purpose: Purpose, ticketId?: string) => {
    if (typeof sessionId !== 'string') return null;
    const s = sessions.get(sessionId);
    if (!s) return null;
    sessions.delete(sessionId); // single use, even when it is rejected below
    if (Date.now() - s.createdAt > SESSION_TTL_MS) return null;
    if (s.purpose !== purpose || s.ticketId !== ticketId) return null;
    return s;
  };

  const liveSession = (sessionId: string) => {
    const s = sessions.get(sessionId);
    return s && Date.now() - s.createdAt <= SESSION_TTL_MS ? s : null;
  };

  const pruneWalletReplies = () => {
    const now = Date.now();
    for (const [id, r] of walletReplies) if (now - r.at > SESSION_TTL_MS) walletReplies.delete(id);
  };

  /** "wallet" means "use the answer the separate wallet page shared". Returns null if there is none yet. */
  const resolveWalletData = (sessionId: string, data: string): string | null => {
    if (mode === 'real' || data !== 'wallet') return data;
    const reply = walletReplies.get(sessionId);
    return reply?.status === 'shared' && reply.data ? reply.data : null;
  };

  const noWalletAnswer = (res: Response) =>
    res.status(400).json({ error: 'no_wallet_answer', message: 'The wallet has not shared an answer yet.' });

  const limited = (key: string) => {
    const now = Date.now();
    const recent = (attempts.get(key) ?? []).filter((t) => now - t < CLAIM_ATTEMPT_WINDOW_MS);
    recent.push(now);
    attempts.set(key, recent);
    return recent.length > CLAIM_ATTEMPT_LIMIT;
  };

  const newClaimToken = () => randomBytes(24).toString('base64url');
  const claimPath = (token: string) => `/claim.html?t=${token}`;
  const expiryFromNow = () => new Date(Date.now() + claimTtlMs).toISOString();

  /** Missing means 1. Anything else must be a whole number from 1 to MAX_QUANTITY. */
  const parseQuantity = (v: unknown): number | null => {
    const q = v === undefined ? 1 : Number(v);
    return Number.isInteger(q) && q >= 1 && q <= MAX_QUANTITY ? q : null;
  };

  type IdCheck = 'online' | 'gate';
  type IssuedTicket = { id: string; token: string; event: string; idCheck: IdCheck };
  type ClaimLink = { ticketId: string; path: string };
  const issued = (id: string, idCheck: IdCheck): IssuedTicket => ({ id, token: makeToken(id, ticketSecret), event: DEMO_EVENT.name, idCheck });

  /**
   * One order: the buyer's ticket plus quantity-1 unclaimed guest tickets with claim links.
   * The buyer was either verified online (verificationRef) or will be checked at the gate.
   */
  const createOrder = (quantity: number, buyer: { verificationRef: string } | 'gate') => {
    const orderId = 'O-' + randomBytes(5).toString('hex').toUpperCase();
    const now = new Date().toISOString();
    const buyerId = newTicketId();
    const claimLinks: ClaimLink[] = [];
    db.transaction(() => {
      db.prepare('insert into orders (id, event_id, quantity, created_at) values (?,?,?,?)').run(orderId, DEMO_EVENT.id, quantity, now);
      if (buyer === 'gate') {
        db.prepare(
          `insert into tickets (id, event_id, order_id, status, age_verified, gate_check, created_at)
           values (?,?,?,?,?,?,?)`,
        ).run(buyerId, DEMO_EVENT.id, orderId, 'issued', 0, 1, now);
      } else {
        db.prepare(
          `insert into tickets (id, event_id, order_id, status, age_verified, verified_at, verification_ref, created_at)
           values (?,?,?,?,?,?,?,?)`,
        ).run(buyerId, DEMO_EVENT.id, orderId, 'issued', 1, now, buyer.verificationRef, now);
      }
      for (let i = 1; i < quantity; i++) {
        const id = newTicketId();
        const token = newClaimToken();
        db.prepare(
          `insert into tickets (id, event_id, order_id, status, age_verified, claim_token_hash, claim_expires_at, created_at)
           values (?,?,?,?,?,?,?,?)`,
        ).run(id, DEMO_EVENT.id, orderId, 'unclaimed', 0, hashToken(token), expiryFromNow(), now);
        claimLinks.push({ ticketId: id, path: claimPath(token) });
      }
    })();
    return {
      ticket: issued(buyerId, buyer === 'gate' ? 'gate' : 'online'),
      order: { id: orderId, quantity, claimLinks },
    };
  };

  const ticketByClaimToken = (token: string) =>
    db.prepare('select * from tickets where claim_token_hash = ?').get(hashToken(token)) as any | undefined;
  const claimUsable = (row: any) => !!row && row.status === 'unclaimed' && row.claim_expires_at > new Date().toISOString();

  const recordScan = (s: {
    ticketId: string | null;
    gateId: string;
    method: string;
    result: 'pass' | 'fail';
    reason: string;
    durationMs: number | null;
    simulated: boolean;
    staffRecorded: boolean;
    receiptId?: string | null;
  }) =>
    db
      .prepare(
        `insert into scans (ticket_id, gate_id, method, result, reason, duration_ms, simulated, staff_recorded, receipt_id, ts)
         values (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        s.ticketId, s.gateId, s.method, s.result, s.reason, s.durationMs,
        s.simulated ? 1 : 0, s.staffRecorded ? 1 : 0, s.receiptId ?? null, new Date().toISOString(),
      );

  const markUsed = (ticketId: string) =>
    db.prepare("update tickets set status = 'used' where id = ? and status = 'issued'").run(ticketId).changes === 1;

  const cleanGate = (v: unknown) => (typeof v === 'string' && /^[a-z0-9-]{1,20}$/.test(v) ? v : 'gate-a');
  const cleanDuration = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 600_000 ? (v as number) : null);

  app.get('/api/health', (_req, res) => res.json({ ok: true, mode }));
  app.get('/api/config', (_req, res) => res.json({ mode, event: DEMO_EVENT, maxQuantity: MAX_QUANTITY }));

  app.get('/api/qr.svg', async (req, res) => {
    const text = typeof req.query.text === 'string' ? req.query.text : '';
    if (!text || text.length > 300) return res.status(400).json({ error: 'bad_request' });
    const svg = await QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    res.type('image/svg+xml').send(svg);
  });

  // ---- Checkout: the buyer verifies once and may order guest tickets -------------------------

  app.post('/api/verify/start', async (_req, res, next) => {
    try {
      const { sessionId, dcRequest } = await verifier.start();
      sessions.set(sessionId, { createdAt: Date.now(), purpose: 'checkout' });
      step(sessionId, 'wallet_prompted');
      res.json({ sessionId, dcRequest });
    } catch (e) {
      next(e);
    }
  });

  app.post('/api/verify/confirm', async (req, res, next) => {
    try {
      const { sessionId, data } = req.body ?? {};
      const quantity = parseQuantity(req.body?.quantity);
      if (typeof sessionId !== 'string' || typeof data !== 'string' || !data) {
        return res.status(400).json({ error: 'bad_request', message: 'sessionId and data are required.' });
      }
      if (quantity === null) {
        return res.status(400).json({ error: 'bad_quantity', message: `Order between 1 and ${MAX_QUANTITY} tickets.` });
      }
      const answer = resolveWalletData(sessionId, data);
      if (answer === null) return noWalletAnswer(res);
      if (!takeSession(sessionId, 'checkout')) {
        return res.status(400).json({ error: 'unknown_session', message: 'This verification expired. Start again.' });
      }
      walletReplies.delete(sessionId);

      const raw = await verifier.verify(sessionId, answer);
      if (deps.inspect) log('[inspect] raw verifier response (portrait redacted):', redactForLog(raw));
      const fw = applyFirewall(raw, ageClaimKey); // the only code that reads the raw response
      if (deps.inspect) log('[inspect] field names returned by the verifier:', fw.receivedFieldNames);
      step(sessionId, fw.outcome === 'passed' ? 'verified' : 'not_verified', fw.reason);

      const verificationRef = randomUUID();
      const created = fw.outcome === 'passed' ? createOrder(quantity, { verificationRef }) : null;
      const ticket = created?.ticket ?? null;

      const receipt = buildReceipt({ ticketId: ticket?.id ?? null, verificationRef, fw, source: 'checkout', kept: !!ticket });
      saveReceipt(db, receipt);
      res.json({ outcome: fw.outcome, reason: fw.reason, ticket, order: created?.order ?? null, receipt });
    } catch (e) {
      next(e);
    }
  });

  // ---- No mobile ID: buy now, age checked at the gate. No ID data is collected online. ------

  app.post('/api/orders/no-wallet', (req, res) => {
    if (limited(`no-wallet:${req.ip}`)) {
      return res.status(429).json({ error: 'too_many_attempts', message: 'Too many attempts. Wait a few minutes.' });
    }
    const quantity = parseQuantity(req.body?.quantity);
    if (quantity === null) {
      return res.status(400).json({ error: 'bad_quantity', message: `Order between 1 and ${MAX_QUANTITY} tickets.` });
    }
    const { ticket, order } = createOrder(quantity, 'gate');
    step(null, 'no_wallet_chosen');
    // No privacy receipt: nothing about the buyer was received, so there is nothing to account for.
    res.json({ outcome: 'deferred', reason: 'id_check_at_gate', ticket, order, receipt: null });
  });

  // ---- Order view for the buyer ---------------------------------------------------------------

  app.get('/api/orders/:orderId', (req, res) => {
    const order = db.prepare('select * from orders where id = ?').get(req.params.orderId) as any;
    if (!order) return res.status(404).json({ error: 'not_found' });
    const now = new Date().toISOString();
    const rows = db.prepare('select id, status, claim_expires_at, gate_check from tickets where order_id = ? order by rowid').all(order.id) as any[];
    // Only a status is shown. Never why a guest's claim failed.
    const tickets = rows.map((t, i) => ({
      id: t.id,
      label: i === 0 ? 'Your ticket' : `Guest ticket ${i}`,
      status: t.status === 'unclaimed' && t.claim_expires_at < now ? 'expired' : t.status,
      idCheck: t.status === 'unclaimed' ? null : t.gate_check ? 'gate' : 'online',
    }));
    res.json({ id: order.id, quantity: order.quantity, event: DEMO_EVENT.name, tickets });
  });

  app.post('/api/orders/:orderId/tickets/:ticketId/link', (req, res) => {
    const row = db
      .prepare('select id, status from tickets where id = ? and order_id = ?')
      .get(req.params.ticketId, req.params.orderId) as any;
    if (!row) return res.status(404).json({ error: 'not_found' });
    if (row.status !== 'unclaimed') {
      return res.status(409).json({ error: 'not_claimable', message: 'This ticket is already claimed.' });
    }
    const token = newClaimToken();
    db.prepare('update tickets set claim_token_hash = ?, claim_expires_at = ? where id = ? and status = ?').run(
      hashToken(token), expiryFromNow(), row.id, 'unclaimed',
    );
    step(null, 'link_regenerated');
    res.json({ ticketId: row.id, path: claimPath(token) });
  });

  // ---- Guest claim ----------------------------------------------------------------------------

  app.get('/api/claims/:token', (req, res) => {
    const row = ticketByClaimToken(req.params.token);
    if (!claimUsable(row)) {
      return res.status(404).json({ error: 'invalid_link', message: 'This link is not valid, has expired, or was already used.' });
    }
    res.json({ ok: true, event: DEMO_EVENT });
  });

  app.post('/api/claims/:token/start', async (req, res, next) => {
    try {
      if (limited(`${req.ip}:${hashToken(req.params.token).slice(0, 12)}`)) {
        return res.status(429).json({ error: 'too_many_attempts', message: 'Too many attempts. Wait a few minutes.' });
      }
      const row = ticketByClaimToken(req.params.token);
      if (!claimUsable(row)) {
        return res.status(404).json({ error: 'invalid_link', message: 'This link is not valid, has expired, or was already used.' });
      }
      const { sessionId, dcRequest } = await verifier.start();
      sessions.set(sessionId, { createdAt: Date.now(), purpose: 'claim', ticketId: row.id });
      step(sessionId, 'claim_started');
      res.json({ sessionId, dcRequest });
    } catch (e) {
      next(e);
    }
  });

  app.post('/api/claims/:token/confirm', async (req, res, next) => {
    try {
      const { sessionId, data } = req.body ?? {};
      if (typeof sessionId !== 'string' || typeof data !== 'string' || !data) {
        return res.status(400).json({ error: 'bad_request', message: 'sessionId and data are required.' });
      }
      const row = ticketByClaimToken(req.params.token);
      if (!claimUsable(row)) {
        sessions.delete(sessionId);
        return res.status(404).json({ error: 'invalid_link', message: 'This link is not valid, has expired, or was already used.' });
      }
      const answer = resolveWalletData(sessionId, data);
      if (answer === null) return noWalletAnswer(res);
      if (!takeSession(sessionId, 'claim', row.id)) {
        return res.status(400).json({ error: 'unknown_session', message: 'This verification expired. Start again.' });
      }
      walletReplies.delete(sessionId);

      const raw = await verifier.verify(sessionId, answer);
      if (deps.inspect) log('[inspect] raw verifier response (portrait redacted):', redactForLog(raw));
      const fw = applyFirewall(raw, ageClaimKey);
      if (deps.inspect) log('[inspect] field names returned by the verifier:', fw.receivedFieldNames);
      const verificationRef = randomUUID();

      if (fw.outcome !== 'passed') {
        step(sessionId, 'claim_failed', fw.reason);
        const receipt = buildReceipt({ ticketId: null, verificationRef, fw, source: 'claim', kept: false });
        saveReceipt(db, receipt);
        return res.json({ outcome: fw.outcome, reason: fw.reason, ticket: null, receipt });
      }

      // The conditional update is the single point that decides the winner of a race.
      const now = new Date().toISOString();
      const won =
        db
          .prepare(
            `update tickets set status = 'issued', age_verified = 1, verified_at = ?, verification_ref = ?,
               claimed_at = ?, claim_token_hash = null, claim_expires_at = null
             where id = ? and status = 'unclaimed' and claim_token_hash = ?`,
          )
          .run(now, verificationRef, now, row.id, hashToken(req.params.token)).changes === 1;

      if (!won) {
        step(sessionId, 'claim_failed', 'already_claimed');
        const receipt = buildReceipt({ ticketId: null, verificationRef, fw, source: 'claim', kept: false });
        saveReceipt(db, receipt);
        return res.status(409).json({ error: 'already_claimed', message: 'This ticket was already claimed.', receipt });
      }

      step(sessionId, 'claim_verified', fw.reason);
      const receipt = buildReceipt({ ticketId: row.id, verificationRef, fw, source: 'claim', kept: true });
      saveReceipt(db, receipt);
      res.json({
        outcome: 'passed',
        reason: fw.reason,
        ticket: issued(row.id, 'online'),
        receipt,
      });
    } catch (e) {
      next(e);
    }
  });

  // A guest without a mobile ID claims now and shows a physical ID at the gate.
  app.post('/api/claims/:token/no-wallet', (req, res) => {
    if (limited(`${req.ip}:${hashToken(req.params.token).slice(0, 12)}`)) {
      return res.status(429).json({ error: 'too_many_attempts', message: 'Too many attempts. Wait a few minutes.' });
    }
    const row = ticketByClaimToken(req.params.token);
    if (!claimUsable(row)) {
      return res.status(404).json({ error: 'invalid_link', message: 'This link is not valid, has expired, or was already used.' });
    }
    // Same race rule as the wallet claim: this one conditional update decides the winner.
    const now = new Date().toISOString();
    const won =
      db
        .prepare(
          `update tickets set status = 'issued', age_verified = 0, gate_check = 1, claimed_at = ?,
             claim_token_hash = null, claim_expires_at = null
           where id = ? and status = 'unclaimed' and claim_token_hash = ?`,
        )
        .run(now, row.id, hashToken(req.params.token)).changes === 1;
    if (!won) return res.status(409).json({ error: 'already_claimed', message: 'This ticket was already claimed.' });
    step(null, 'no_wallet_chosen');
    res.json({ outcome: 'deferred', reason: 'id_check_at_gate', ticket: issued(row.id, 'gate'), receipt: null });
  });

  // ---- Separate simulated wallet (mock and hybrid only) ----------------------------------------
  // The shop page shows a QR code for /wallet.html. That page answers here, and the shop page polls.

  const walletOnly = (_req: Request, res: Response, next: NextFunction) => {
    if (mode === 'real') return res.status(404).json({ error: 'not_available' });
    next();
  };

  app.get('/api/wallet/request/:sessionId', walletOnly, (req, res) => {
    const id = req.params.sessionId;
    const s = liveSession(id);
    if (!s) return res.status(404).json({ error: 'unknown_session' });
    res.json({ event: DEMO_EVENT.name, question: 'Are you 21 or older?', purpose: s.purpose, answered: walletReplies.has(id) });
  });

  app.post('/api/wallet/respond/:sessionId', walletOnly, (req, res) => {
    const id = req.params.sessionId;
    if (!liveSession(id)) return res.status(404).json({ error: 'unknown_session' });
    if (walletReplies.has(id)) return res.status(409).json({ error: 'already_answered', message: 'This request was already answered.' });
    const action = req.body?.action;
    const scenario = req.body?.scenario ?? 'pass';
    if ((action !== 'share' && action !== 'decline') || !SIMULATED_SCENARIOS.includes(scenario)) {
      return res.status(400).json({ error: 'bad_request', message: 'action must be share or decline, with a valid scenario.' });
    }
    pruneWalletReplies();
    walletReplies.set(
      id,
      action === 'share' ? { status: 'shared', data: `mock:${scenario}`, at: Date.now() } : { status: 'declined', at: Date.now() },
    );
    res.json({ ok: true });
  });

  // Status only. The answer itself never leaves the server through this endpoint.
  app.get('/api/verify/status/:sessionId', walletOnly, (req, res) => {
    const id = req.params.sessionId;
    const reply = walletReplies.get(id);
    const status = reply ? reply.status : liveSession(id) ? 'pending' : 'unknown';
    res.json({ status });
  });

  // ---- Gate ------------------------------------------------------------------------------------

  app.post('/api/gate/validate', (req, res) => {
    const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
    if (!code || code.length > 200) return res.status(400).json({ error: 'bad_request', message: 'A ticket code is required.' });
    const parsed = readToken(code, ticketSecret);
    if (!parsed.ok) return res.json({ ok: false, reason: 'signature_invalid' });
    const t = db.prepare('select id, status, gate_check from tickets where id = ?').get(parsed.id) as any;
    if (!t) return res.json({ ok: false, reason: 'ticket_unknown' });
    if (t.status === 'unclaimed') return res.json({ ok: false, reason: 'ticket_unclaimed', ticketId: t.id });
    if (t.status === 'used') return res.json({ ok: false, reason: 'ticket_used', ticketId: t.id });
    if (t.status !== 'issued') return res.json({ ok: false, reason: 'ticket_revoked', ticketId: t.id });
    res.json({ ok: true, ticket: { id: t.id, event: DEMO_EVENT.name, idCheck: t.gate_check ? 'gate' : 'online' } });
  });

  // Simulated mobile ID check at the gate. Only available while the verifier is the mock.
  app.post('/api/gate/verify', async (req, res, next) => {
    try {
      if (mode === 'real') {
        return res.status(400).json({ error: 'not_available', message: 'The simulated gate check is not available in real mode.' });
      }
      const { ticketId } = req.body ?? {};
      const scenario = req.body?.scenario ?? 'pass';
      if (typeof ticketId !== 'string' || !SIMULATED_SCENARIOS.includes(scenario)) {
        return res.status(400).json({ error: 'bad_request', message: 'ticketId and a valid scenario are required.' });
      }
      const gateId = cleanGate(req.body?.gateId);
      const durationMs = cleanDuration(req.body?.durationMs);
      const t = db.prepare('select status from tickets where id = ?').get(ticketId) as any;
      if (!t || t.status !== 'issued') return res.status(409).json({ error: 'not_enterable', message: 'This ticket cannot enter.' });

      const { sessionId } = await verifier.start();
      const raw = await verifier.verify(sessionId, `mock:${scenario}`);
      const fw = applyFirewall(raw, ageClaimKey);
      const verificationRef = randomUUID();
      const passed = fw.outcome === 'passed';
      const entered = passed && markUsed(ticketId);
      const receipt = buildReceipt({ ticketId, verificationRef, fw, source: 'gate', kept: false });
      saveReceipt(db, receipt);
      const reason = passed && !entered ? 'ticket_used' : fw.reason;
      recordScan({
        ticketId, gateId, method: 'mobile_id_simulated', result: entered ? 'pass' : 'fail', reason,
        durationMs, simulated: true, staffRecorded: false, receiptId: receipt.id,
      });
      res.json({ result: entered ? 'pass' : 'fail', reason, receipt });
    } catch (e) {
      next(e);
    }
  });

  // Result recorded by gate staff, for example after using the Tap2iD Mobile app on a physical ID.
  app.post('/api/gate/scan', (req, res) => {
    const { ticketId, method, result } = req.body ?? {};
    const reason = req.body?.reason;
    if (typeof ticketId !== 'string' || !['physical_id_staff_recorded', 'override'].includes(method) || !['pass', 'fail'].includes(result)) {
      return res.status(400).json({ error: 'bad_request', message: 'ticketId, method and result are required.' });
    }
    const gateId = cleanGate(req.body?.gateId);
    const durationMs = cleanDuration(req.body?.durationMs);

    let finalReason: string;
    if (method === 'override') {
      if (result !== 'pass' || !OVERRIDE_REASONS.includes(reason)) {
        return res.status(400).json({ error: 'bad_reason', message: 'An override needs a listed reason.' });
      }
      finalReason = reason;
    } else if (result === 'pass') {
      finalReason = 'age_confirmed';
    } else {
      if (!PHYSICAL_FAIL_REASONS.includes(reason)) {
        return res.status(400).json({ error: 'bad_reason', message: 'A refusal needs a listed reason.' });
      }
      finalReason = reason;
    }

    const t = db.prepare('select status, gate_check from tickets where id = ?').get(ticketId) as any;
    if (!t) return res.status(404).json({ error: 'not_found' });
    // Nobody has checked this person's age yet, so a manager override would let them in unchecked.
    if (method === 'override' && t.gate_check === 1) {
      return res.status(400).json({
        error: 'id_check_required',
        message: 'This ticket has not been age-checked online. Check a physical ID or a mobile ID.',
      });
    }
    const staffRecorded = method === 'physical_id_staff_recorded';

    if (result === 'fail') {
      recordScan({ ticketId, gateId, method, result, reason: finalReason, durationMs, simulated: false, staffRecorded });
      return res.json({ result: 'fail', reason: finalReason });
    }
    if (!markUsed(ticketId)) {
      recordScan({ ticketId, gateId, method, result: 'fail', reason: 'ticket_used', durationMs, simulated: false, staffRecorded });
      return res.status(409).json({ error: 'not_enterable', message: 'This ticket cannot enter.', reason: 'ticket_used' });
    }
    recordScan({ ticketId, gateId, method, result: 'pass', reason: finalReason, durationMs, simulated: false, staffRecorded });
    res.json({ result: 'pass', reason: finalReason });
  });

  // ---- Receipts, metrics, readiness ------------------------------------------------------------

  app.get('/api/receipts/:id', (req, res) => {
    const receipt = loadReceipt(db, req.params.id);
    if (!receipt) return res.status(404).json({ error: 'not_found' });
    res.json(receipt);
  });

  app.get('/api/export/audit.csv', (_req, res) => {
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="buy-to-door-audit.csv"',
      'Cache-Control': 'no-store',
    });
    res.send(buildAuditCsv(db));
  });

  app.get('/api/privacy/summary', (_req, res) => res.json(privacySummary(db)));
  app.get('/api/metrics', (_req, res) =>
    res.json({ ...buildMetrics(db), sdk: sdkStats.snapshot(mode, deps.cloud?.baseUrl) }));

  app.get('/api/readiness', async (req, res, next) => {
    try {
      if (mode !== 'mock') {
        if (!deps.readinessToken) {
          return res.status(403).json({ error: 'readiness_disabled', message: 'Set READINESS_TOKEN in .env to run the real checks.' });
        }
        if (req.get('x-readiness-token') !== deps.readinessToken) {
          return res.status(403).json({ error: 'bad_token', message: 'The readiness token is missing or wrong.' });
        }
      }
      const checks = await runReadiness({
        mode,
        ticketSecret,
        licenseKey: deps.cloud?.licenseKey ?? '',
        profileId: deps.cloud?.profileId ?? '',
        origin: deps.cloud?.origin ?? '',
        baseUrl: deps.cloud?.baseUrl,
        client: deps.cloud?.client,
      });
      res.json({ mode, checks });
    } catch (e) {
      next(e);
    }
  });

  app.post('/api/dev/reset', (_req, res) => {
    if (process.env.NODE_ENV === 'production') return res.status(404).end();
    db.exec('delete from scans; delete from privacy_receipts; delete from tickets; delete from orders; delete from checkout_events;');
    sessions.clear();
    walletReplies.clear();
    attempts.clear();
    res.json({ ok: true });
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    log('[error]', err.name, err.message); // message only, never request bodies
    res.status(502).json({
      error: 'verifier_unavailable',
      message: 'The identity service could not complete the request. Try again.',
    });
  });

  return app;
}
