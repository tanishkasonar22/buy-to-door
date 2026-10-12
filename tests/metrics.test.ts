import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { percentile } from '../src/metrics.js';
import { buy, claim, setup } from './helpers.js';

describe('percentile', () => {
  it('uses nearest rank', () => {
    const v = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(v, 50)).toBe(50);
    expect(percentile(v, 95)).toBe(100);
    expect(percentile(v, 0)).toBe(10);
  });
  it('handles empty and single values and unsorted input', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([3, 1, 2], 50)).toBe(2);
  });
});

describe('metrics endpoint', () => {
  it('starts at zero', async () => {
    const { app } = setup();
    const m = (await request(app).get('/api/metrics').expect(200)).body;
    expect(m.funnel).toMatchObject({ walletPrompted: 0, verified: 0, ordersPlaced: 0, entered: 0 });
    expect(m.recent).toEqual([]);
  });

  it('counts the funnel, failures, methods and scan times from what actually happened', async () => {
    const { app } = setup();
    const group = await buy(app, 'pass', 3);
    await buy(app, 'under');
    await buy(app, 'cancel');
    await claim(app, group.body.order.claimLinks[0].path, 'under');
    await claim(app, group.body.order.claimLinks[1].path, 'pass');
    await request(app).post('/api/gate/verify').send({ ticketId: group.body.ticket.id, scenario: 'pass', durationMs: 100 });
    await request(app).post('/api/gate/scan').send({ ticketId: group.body.ticket.id, method: 'physical_id_staff_recorded', result: 'fail', reason: 'id_unreadable', durationMs: 300 });

    const m = (await request(app).get('/api/metrics').expect(200)).body;
    expect(m.funnel).toMatchObject({
      walletPrompted: 3, verified: 1, notVerified: 2, ordersPlaced: 1,
      claimsStarted: 2, claimsFailed: 1, claimed: 1, unclaimed: 1, entered: 1,
    });
    expect(m.failures).toMatchObject({ under_age: 2, wallet_cancelled: 1, id_unreadable: 1 });
    expect(m.methods.mobile_id_simulated).toMatchObject({ pass: 1, fail: 0, simulated: true });
    expect(m.methods.physical_id_staff_recorded).toMatchObject({ pass: 0, fail: 1, staffRecorded: true });
    expect(m.scanTimes.mobile_id_simulated).toEqual({ n: 1, p50: 100, p95: 100 });
    expect(m.recent).toHaveLength(2);
    expect(m.privacy.personalDataShapedColumns).toEqual([]);
  });

  it('clears everything on reset', async () => {
    const { app } = setup();
    await buy(app, 'pass', 2);
    await request(app).post('/api/dev/reset').expect(200);
    const m = (await request(app).get('/api/metrics')).body;
    expect(m.funnel.ticketsTotal).toBe(0);
    expect(m.funnel.walletPrompted).toBe(0);
  });
});
