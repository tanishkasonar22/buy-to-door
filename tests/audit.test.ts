import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { AUDIT_COLUMNS, csvCell } from '../src/audit.js';
import { buy, claim, setup, type TestApp } from './helpers.js';

const tokenOf = (path: string) => new URL(path, 'http://x').searchParams.get('t')!;

function getCsv(app: TestApp) {
  return request(app)
    .get('/api/export/audit.csv')
    .buffer(true)
    .parse((res, cb) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (text += chunk));
      res.on('end', () => cb(null, text));
    });
}

/** Simple parser for this file's own output: no cell here holds a comma, quote or newline. */
const rowsOf = (csv: string) => {
  const [header, ...lines] = csv.replace(/\r\n$/, '').split('\r\n');
  const cols = header.split(',');
  return lines.map((l) => Object.fromEntries(l.split(',').map((v, i) => [cols[i], v])));
};

describe('audit CSV export', () => {
  it('downloads as a CSV attachment with the fixed header and CRLF endings', async () => {
    const { app } = setup();
    const res = await getCsv(app).expect(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe('attachment; filename="buy-to-door-audit.csv"');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toBe(AUDIT_COLUMNS.join(',') + '\r\n');
    expect(AUDIT_COLUMNS).toEqual([
      'time', 'event', 'ticket_id', 'order_id', 'id_check', 'method', 'result', 'reason',
      'gate', 'duration_ms', 'simulated', 'staff_recorded',
    ]);
  });

  it('lists checkout events, orders, tickets, claims, scans and the no-mobile-ID path in time order', async () => {
    const { app } = setup();
    const group = (await buy(app, 'pass', 3)).body;
    await buy(app, 'under');
    await claim(app, group.order.claimLinks[0].path, 'pass');
    await request(app).post(`/api/claims/${tokenOf(group.order.claimLinks[1].path)}/no-wallet`).expect(200);
    const gate = (await request(app).post('/api/orders/no-wallet').send({}).expect(200)).body;
    await request(app).post('/api/gate/scan').send({ ticketId: gate.ticket.id, method: 'physical_id_staff_recorded', result: 'pass', gateId: 'gate-b', durationMs: 4200 });

    const csv = (await getCsv(app).expect(200)).body as string;
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(csv.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    const rows = rowsOf(csv);

    const times = rows.map((r) => r.time);
    expect([...times].sort()).toEqual(times);

    const events = new Set(rows.map((r) => r.event));
    for (const e of ['checkout:wallet_prompted', 'checkout:verified', 'checkout:not_verified', 'checkout:claim_started',
      'checkout:claim_verified', 'checkout:no_wallet_chosen', 'order_created', 'ticket_created', 'ticket_claimed', 'gate_scan']) {
      expect(events).toContain(e);
    }
    expect(rows.find((r) => r.event === 'checkout:not_verified')!.reason).toBe('under_age');
    expect(rows.filter((r) => r.event === 'order_created').map((r) => r.order_id)).toEqual([group.order.id, gate.order.id]);
    expect(rows.find((r) => r.event === 'ticket_created' && r.ticket_id === group.ticket.id)).toMatchObject({ order_id: group.order.id, id_check: 'online' });
    expect(rows.find((r) => r.event === 'ticket_created' && r.ticket_id === gate.ticket.id)!.id_check).toBe('gate');

    const claims = rows.filter((r) => r.event === 'ticket_claimed');
    expect(claims.map((r) => [r.ticket_id, r.id_check])).toEqual([
      [group.order.claimLinks[0].ticketId, 'online'],
      [group.order.claimLinks[1].ticketId, 'gate'],
    ]);

    expect(rows.find((r) => r.event === 'gate_scan')).toEqual({
      time: expect.any(String), event: 'gate_scan', ticket_id: gate.ticket.id, order_id: gate.order.id, id_check: '',
      method: 'physical_id_staff_recorded', result: 'pass', reason: 'age_confirmed', gate: 'gate-b',
      duration_ms: '4200', simulated: '0', staff_recorded: '1',
    });
  });

  it('holds no personal data, tokens, claim links or session IDs', async () => {
    const { app } = setup();
    const group = (await buy(app, 'pass', 2)).body;
    await claim(app, group.order.claimLinks[0].path, 'pass');
    await request(app).post('/api/gate/verify').send({ ticketId: group.ticket.id, scenario: 'pass' });
    const csv = (await getCsv(app).expect(200)).body as string;
    for (const bad of ['Testperson', 'Examplesurname', '1990-01-01', 'AAAA', group.ticket.token, 'claim.html', 'session', 'mock:']) {
      expect(csv).not.toContain(bad);
    }
  });
});

describe('csvCell', () => {
  it('neutralises spreadsheet formulas', () => {
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-1')).toBe("'-1");
    expect(csvCell('@cmd')).toBe("'@cmd");
    expect(csvCell('\tx')).toBe("'\tx");
    expect(csvCell('\rx')).toBe('"\'\rx"');
  });

  it('quotes cells with commas, quotes or line breaks', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('a\nb')).toBe('"a\nb"');
    expect(csvCell('=a,"b"')).toBe('"\'=a,""b"""');
  });

  it('writes empty cells for null and undefined, and plain numbers as is', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(0)).toBe('0');
    expect(csvCell(4200)).toBe('4200');
    expect(csvCell('gate-a')).toBe('gate-a');
  });
});
