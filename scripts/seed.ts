// Fills a running mock-mode server with believable demo data so the dashboard has something to show.
// Usage: start the server (npm run dev), then run: npm run seed
const base = process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;

async function call(path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 409) throw new Error(`${path} -> ${res.status} ${json.error ?? ''}`);
  return json;
}

async function buy(quantity: number, scenario = 'pass') {
  const { sessionId } = await call('/api/verify/start', {});
  return call('/api/verify/confirm', { sessionId, data: `mock:${scenario}`, quantity });
}

async function claim(path: string, scenario: string) {
  const token = new URL(path, base).searchParams.get('t')!;
  const { sessionId } = await call(`/api/claims/${token}/start`, {});
  return call(`/api/claims/${token}/confirm`, { sessionId, data: `mock:${scenario}` });
}

async function main() {
  const config = await call('/api/config');
  if (config.mode !== 'mock') throw new Error('Seeding only works against a server running in mock mode.');
  await call('/api/dev/reset', {});

  const group = await buy(3);
  const solo = await buy(1);
  await buy(1, 'under');
  await buy(1, 'invalid');
  const guestA = await claim(group.order.claimLinks[0].path, 'pass');
  await claim(group.order.claimLinks[1].path, 'under'); // fails; ticket stays unclaimed

  // No mobile ID: buyer and guest both get gate-check tickets. No ID data is collected online.
  const noId = await call('/api/orders/no-wallet', { quantity: 2 });
  await call(`/api/claims/${new URL(noId.order.claimLinks[0].path, base).searchParams.get('t')}/no-wallet`, {});

  const scan = (ticket: any, body: object) =>
    call('/api/gate/scan', { ticketId: ticket.id, gateId: 'gate-a', durationMs: 2500, ...body });
  await call('/api/gate/verify', { ticketId: group.ticket.id, scenario: 'pass', durationMs: 2100 });
  await call('/api/gate/verify', { ticketId: guestA.ticket.id, scenario: 'under', durationMs: 3300 });
  await scan(solo.ticket, { method: 'physical_id_staff_recorded', result: 'pass', durationMs: 7400 });
  await scan(noId.ticket, { method: 'physical_id_staff_recorded', result: 'pass', durationMs: 6800 });

  const m = await call('/api/metrics');
  console.log('Seeded.', JSON.stringify(m.funnel));
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
