import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { CredenceVerifier, HybridVerifier, type RawVerification } from '../src/identity.js';
import { redactForLog } from '../src/inspect.js';
import { setup } from './helpers.js';

const PORTRAIT = 'UE9SVFJBSVQ' + 'x'.repeat(3000);
const PERSONAL = ['Testperson', 'Examplesurname', '1990-01-01', 'D1234567', PORTRAIT.slice(0, 20)];
const NS = 'org.iso.18013.5.1';
const authOk = { authenticationResult: 'SUCCESS', issuerRecognized: true, issuerSignedAuthenticated: true, deviceSignedAuthenticated: true, dataIntegrity: true, msoValidity: true, certValidationError: '', issuerAuthValid: true, deviceAuthValid: true };
const authBad = { ...authOk, authenticationResult: 'FAILED', issuerRecognized: false, issuerAuthValid: false, certValidationError: 'Issuer certificate not found in trust store' };
const identity = (age: unknown) => ({ age_over_21: age, given_name: 'Testperson', family_name: 'Examplesurname', birth_date: '1990-01-01', document_number: 'D1234567', portrait: PORTRAIT });
const ok = (details: unknown): RawVerification => ({ res: true, resDetails: JSON.stringify(details) });
// The [firewall] line for authBad: which checks failed, and Credence's certificate error text.
const AUTH_BAD_LINE = '[firewall] decision=deny reason=authentication_checks_failed res=true issuerRecognized=false issuerSignedAuthenticated=true deviceSignedAuthenticated=true dataIntegrity=true issuerAuthValid=false deviceAuthValid=true certValidationError="Issuer certificate not found in trust store"';

function realApp(answer: RawVerification, inspect = false) {
  const client = {
    async getDocRequest() { return { sessionId: `sdk-${Math.random()}`, dcRequest: { deviceRequest: 'x', encryptionInfo: 'y' } }; },
    async verifyDocRequest() { return answer; },
  };
  const logs: string[] = [];
  const { app } = setup({ verifier: new CredenceVerifier(client as any), mode: 'real', inspect, log: (...a) => logs.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')) });
  return { app, logs };
}

async function confirm(app: ReturnType<typeof realApp>['app'], quantity = 1) {
  const start = await request(app).post('/api/verify/start');
  return request(app).post('/api/verify/confirm').send({ sessionId: start.body.sessionId, data: 'wallet-answer', quantity });
}

const CASES: [string, RawVerification, 'allow' | 'deny', string][] = [
  ['adult', ok({ identity: identity(true), authentication: authOk }), 'allow', 'age_confirmed'],
  ['issuer not recognized (res true)', ok({ identity: identity(true), authentication: authBad }), 'deny', 'authentication_checks_failed'],
  ['res false', { res: false, resDetails: 'Device signature invalid' }, 'deny', 'verification_failed'],
  ['under age', ok({ identity: identity(false), authentication: authOk }), 'deny', 'under_age'],
  ['the string "true"', ok({ [NS]: identity('true'), authentication: authOk }), 'deny', 'unreadable_response'],
  ['no age claim', ok({ identity: { portrait: PORTRAIT }, authentication: authOk }), 'deny', 'age_claim_missing'],
  ['cancelled', { res: false, resDetails: '{}', cancelled: true }, 'deny', 'wallet_cancelled'],
];

describe('real mode: the verdict is always visible', () => {
  for (const [name, answer, decision, reason] of CASES) {
    it(`${name}: inspect line first, then [firewall] decision=${decision} reason=${reason}`, async () => {
      const { app, logs } = realApp(answer, true);
      expect((await confirm(app)).status).toBe(200);
      const inspectAt = logs.findIndex((l) => l.startsWith('[inspect] raw verifier response'));
      // A failed security check and an unusable age claim carry extra detail; every other line is exactly decision + reason.
      const DETAIL: Record<string, string> = {
        authentication_checks_failed: AUTH_BAD_LINE,
        unreadable_response: `[firewall] decision=deny reason=unreadable_response ageClaimType=string ageClaimPath=["${NS}"].age_over_21 ageClaimLength=4 ageClaimString=true-like`,
        age_claim_missing: '[firewall] decision=deny reason=age_claim_missing ageClaimType=missing ageClaimPath=(none)',
      };
      const expected = DETAIL[reason] ?? `[firewall] decision=${decision} reason=${reason}`;
      const decisionAt = logs.indexOf(expected);
      expect(inspectAt).toBeGreaterThanOrEqual(0);
      expect(decisionAt).toBeGreaterThan(inspectAt);
      expect(logs.filter((l) => l.startsWith('[firewall]'))).toHaveLength(1);
      for (const value of PERSONAL) expect(logs.join('\n')).not.toContain(value);
    });
  }

  it('prints the authentication flags in full, first, with personal values redacted but key names kept', async () => {
    const { app, logs } = realApp(ok({ identity: identity(true), authentication: authBad }), true);
    const res = await confirm(app);
    expect(res.body.reason).toBe('authentication_checks_failed');
    const line = logs.find((l) => l.startsWith('[inspect] raw verifier response'))!;
    const head = JSON.parse(line.slice(line.indexOf('{'), line.indexOf(' resDetails=')));
    expect(head).toEqual({ res: true, cancelled: false, authentication: authBad });
    expect(line).toContain('"age_over_21":true');
    expect(line).toContain('"given_name":"[redacted string, 10 chars]"');
    expect(line).toContain('"birth_date":"[redacted string, 10 chars]"');
    expect(line).toContain(`"portrait":"[portrait omitted, ${PORTRAIT.length} bytes]"`);
  });

  it('logs the [firewall] decision even when DEV_INSPECT is off, and nothing else about the answer', async () => {
    const { app, logs } = realApp(ok({ identity: identity(true), authentication: authBad }), false);
    await confirm(app);
    // [dc] and [origin] are the request/origin diagnostics from earlier; nothing else may describe the answer.
    expect(logs.filter((l) => !l.startsWith('[dc]') && !l.startsWith('[origin]'))).toEqual([AUTH_BAD_LINE]);
  });

  it('shows which security check failed, with no claim values, even without DEV_INSPECT', async () => {
    const auth = {
      ...authOk, deviceSignedAuthenticated: false, deviceAuthValid: 'yes', dataIntegrity: undefined,
      certValidationError: 'Chain   building\nfailed: ' + 'E'.repeat(400),
    };
    const { app, logs } = realApp(ok({ documents: [{ [NS]: identity(true), authentication: auth }] }), false);
    const res = await confirm(app);
    expect(res.body.reason).toBe('authentication_checks_failed');
    const line = logs.find((l) => l.startsWith('[firewall]'))!;
    expect(line).toBe(
      '[firewall] decision=deny reason=authentication_checks_failed res=true issuerRecognized=true issuerSignedAuthenticated=true ' +
      'deviceSignedAuthenticated=false dataIntegrity=missing issuerAuthValid=true deviceAuthValid=not-boolean ' +
      `certValidationError="Chain building failed: ${'E'.repeat(200 - 'Chain building failed: '.length)}"`,
    );
    for (const value of [...PERSONAL, 'yes', 'age_over_21', 'given_name']) expect(line).not.toContain(value);
  });

  it('adds no extra detail when the decision is allow or another deny reason', async () => {
    for (const [answer, expected] of [
      [ok({ identity: identity(true), authentication: authOk }), '[firewall] decision=allow reason=age_confirmed'],
      [ok({ identity: identity(false), authentication: authOk }), '[firewall] decision=deny reason=under_age'],
    ] as const) {
      const { app, logs } = realApp(answer, false);
      await confirm(app);
      expect(logs.filter((l) => l.startsWith('[firewall]'))).toEqual([expected]);
    }
  });

  it('describes an unusable age claim by type, key path and string category only', async () => {
    const line = async (answer: RawVerification) => {
      const { app, logs } = realApp(answer, false);
      await confirm(app);
      return logs.find((l) => l.startsWith('[firewall]'))!;
    };
    const base = '[firewall] decision=deny reason=';
    expect(await line(ok({ identity: { ...identity('Yes'), }, authentication: authOk })))
      .toBe(`${base}unreadable_response ageClaimType=string ageClaimPath=identity.age_over_21 ageClaimLength=3 ageClaimString=other`);
    expect(await line(ok({ identity: identity('FALSE'), authentication: authOk })))
      .toBe(`${base}unreadable_response ageClaimType=string ageClaimPath=identity.age_over_21 ageClaimLength=5 ageClaimString=false-like`);
    expect(await line(ok({ documents: [{ [NS]: identity(1), authentication: authOk }] })))
      .toBe(`${base}unreadable_response ageClaimType=number ageClaimPath=documents[0]["${NS}"].age_over_21`);
    expect(await line(ok({ identity: identity({ value: true }), authentication: authOk })))
      .toBe(`${base}unreadable_response ageClaimType=object ageClaimPath=identity.age_over_21`);
    expect(await line(ok({ identity: identity([true]), authentication: authOk })))
      .toBe(`${base}unreadable_response ageClaimType=array ageClaimPath=identity.age_over_21`);
    expect(await line(ok({ [NS]: [{ elementIdentifier: 'portrait', elementValue: PORTRAIT }, { elementIdentifier: 'age_over_21', elementValue: 'true' }] })))
      .toBe(`${base}unreadable_response ageClaimType=string ageClaimPath=["${NS}"][1].elementValue ageClaimLength=4 ageClaimString=true-like`);
    expect(await line(ok({ identity: identity(null), authentication: authOk })))
      .toBe(`${base}age_claim_missing ageClaimType=null ageClaimPath=identity.age_over_21`);
    expect(await line({ res: true, resDetails: 'not json' }))
      .toBe(`${base}unreadable_response resDetails=unparseable ageClaimType=missing ageClaimPath=(none)`);
  });

  it('reports the copy that caused the decision when there are several', async () => {
    const { app, logs } = realApp(ok({ identity: { age_over_21: true }, documents: [{ [NS]: { age_over_21: 'secret-looking-text' } }] }), false);
    await confirm(app);
    const line = logs.find((l) => l.startsWith('[firewall]'))!;
    expect(line).toBe(`[firewall] decision=deny reason=unreadable_response ageClaimType=string ageClaimPath=documents[0]["${NS}"].age_over_21 ageClaimLength=19 ageClaimString=other`);
    expect(line).not.toContain('secret-looking-text');
  });

  it('never prints claim values or other fields in the age diagnostics', async () => {
    const { app, logs } = realApp(ok({ identity: identity('Testperson'), authentication: authOk }), false);
    await confirm(app);
    const line = logs.find((l) => l.startsWith('[firewall]'))!;
    for (const value of [...PERSONAL, 'given_name', 'birth_date', 'portrait']) expect(line).not.toContain(value);
  });

  it('also covers guest claims', async () => {
    const { app, logs } = realApp(ok({ identity: identity(true), authentication: authOk }), true);
    const order = (await confirm(app, 2)).body.order;
    const token = new URL(order.claimLinks[0].path, 'http://x').searchParams.get('t')!;
    const start = await request(app).post(`/api/claims/${token}/start`);
    await request(app).post(`/api/claims/${token}/confirm`).send({ sessionId: start.body.sessionId, data: 'guest' }).expect(200);
    expect(logs.filter((l) => l === '[firewall] decision=allow reason=age_confirmed')).toHaveLength(2);
    expect(logs.filter((l) => l.startsWith('[inspect] raw verifier response'))).toHaveLength(2);
  });

  it('adds no [firewall] line in hybrid or mock mode', async () => {
    for (const mode of ['hybrid', 'mock'] as const) {
      const logs: string[] = [];
      const client = { async getDocRequest() { return { sessionId: 's', dcRequest: {} }; }, async verifyDocRequest() { return { res: false, resDetails: '' }; } };
      const { app } = setup({ mode, ...(mode === 'hybrid' ? { verifier: new HybridVerifier(client) } : {}), log: (...a) => logs.push(a.join(' ')) });
      const start = await request(app).post('/api/verify/start');
      await request(app).post('/api/verify/confirm').send({ sessionId: start.body.sessionId, data: 'mock:pass' }).expect(200);
      expect(logs.filter((l) => l.startsWith('[firewall]'))).toEqual([]);
    }
  });

  it('redacts numbers and nested personal strings, keeps true/false and null', () => {
    const line = redactForLog(ok({ documents: [{ [NS]: [{ elementIdentifier: 'age_over_21', elementValue: true }, { elementIdentifier: 'height', elementValue: 182 }, { elementIdentifier: 'given_name', elementValue: 'Testperson' }], extra: null }] }));
    expect(line).toContain('"elementValue":true');
    expect(line).toContain('"elementValue":"[redacted number]"');
    expect(line).toContain('"elementValue":"[redacted string, 10 chars]"');
    expect(line).toContain('"extra":null');
    expect(line).not.toContain('182');
    expect(line).not.toContain('Testperson');
  });
});
