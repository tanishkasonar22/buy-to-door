// Credence sends age flags as strings ("true", "True", ...). The Credence adapter converts the words
// true / false in any ASCII letter case for identity.age_over_<n>; the firewall itself stays strict.
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { applyFirewall } from '../src/firewall.js';
import { CredenceVerifier, HybridVerifier, normalizeCredenceAgeFlags, type RawVerification } from '../src/identity.js';
import { buy, setup } from './helpers.js';

const PORTRAIT = 'UE9SVFJBSVQ' + 'x'.repeat(2000);
const NS = 'org.iso.18013.5.1';
const authOk = { authenticationResult: 'SUCCESS', issuerRecognized: true, issuerSignedAuthenticated: true, deviceSignedAuthenticated: true, dataIntegrity: true };
const authUnlisted = { ...authOk, authenticationResult: 'FAILED', issuerRecognized: false };
const credence = (age: unknown, authentication: object = authOk): RawVerification => ({
  res: true, resDetails: JSON.stringify({ identity: { age_over_21: age, portrait: PORTRAIT }, authentication }),
});
const parsed = (raw: RawVerification) => JSON.parse(raw.resDetails);

describe('normalizeCredenceAgeFlags', () => {
  it('converts "true" and "false" in any ASCII letter case for identity.age_over_<n>', () => {
    for (const v of ['true', 'True', 'TRUE', 'tRuE']) expect(parsed(normalizeCredenceAgeFlags(credence(v))).identity.age_over_21).toBe(true);
    for (const v of ['false', 'False', 'FALSE', 'fAlSe']) expect(parsed(normalizeCredenceAgeFlags(credence(v))).identity.age_over_21).toBe(false);
    const many = normalizeCredenceAgeFlags({ res: true, resDetails: JSON.stringify({ identity: { age_over_18: 'true', age_over_65: 'false' } }) });
    expect(parsed(many).identity).toEqual({ age_over_18: true, age_over_65: false });
  });

  it('converts under each documents[].identity too', () => {
    const raw: RawVerification = { res: true, resDetails: JSON.stringify({ documents: [{ identity: { age_over_21: 'true' } }, { identity: { age_over_21: 'false' } }] }) };
    expect(parsed(normalizeCredenceAgeFlags(raw)).documents.map((d: any) => d.identity.age_over_21)).toEqual([true, false]);
  });

  it('leaves every other spelling and type alone', () => {
    // Not the words true/false: other words, digits, single letters, whitespace, non-ASCII look-alikes
    // ("falſe" uses the long s U+017F, "truе" a Cyrillic е U+0435), and non-strings.
    for (const v of ['yes', 'Yes', '1', '0', 't', 'f', 'T', 'true ', ' true', 'True\t', 'false\n', '', 'tru', 'truee', 'falſe', 'truе', 1, 0, null, true, false, ['true'], { value: 'true' }]) {
      const raw = credence(v);
      const out = normalizeCredenceAgeFlags(raw);
      expect(out).toBe(raw); // unchanged: the very same object and string
    }
  });

  it('never touches other claims, other keys or other paths', () => {
    const details = {
      identity: { age_over_21: 'true', given_name: 'true', age_in_years: 'true', age_over_21x: 'true', age_over_: 'true', portrait: PORTRAIT, height: 1.5 },
      [NS]: { age_over_21: 'true' },
      authentication: { ...authOk, note: 'true' },
      documents: [{ [NS]: { age_over_21: 'false' }, identity: 'not-an-object' }],
    };
    const out = parsed(normalizeCredenceAgeFlags({ res: true, resDetails: JSON.stringify(details) }));
    expect(out).toEqual({ ...details, identity: { ...details.identity, age_over_21: true } });
    expect(out.identity.portrait).toBe(PORTRAIT); // byte-identical portrait
  });

  it('passes through cancelled answers, res false and non-JSON resDetails unchanged', () => {
    for (const raw of [
      { res: false, resDetails: 'Issuer certificate not trusted' },
      { res: false, resDetails: '{}', cancelled: true },
      { res: true, resDetails: 'not json' },
      { res: true, resDetails: '"just a string"' },
    ] as RawVerification[]) {
      expect(normalizeCredenceAgeFlags(raw)).toBe(raw);
    }
  });

  it('keeps every other field of the verifier answer', () => {
    const raw = { ...credence('true'), message: 'kept' } as RawVerification & { message: string };
    expect(normalizeCredenceAgeFlags(raw)).toMatchObject({ res: true, message: 'kept' });
  });
});

describe('the firewall itself is unchanged', () => {
  it('still refuses the string "true" arriving directly', () => {
    expect(applyFirewall(credence('true'), 'age_over_21')).toMatchObject({ outcome: 'failed', reason: 'unreadable_response' });
    expect(applyFirewall(credence('false'), 'age_over_21')).toMatchObject({ outcome: 'failed', reason: 'unreadable_response' });
  });
});

describe('real mode through the Credence adapter', () => {
  function realApp(answer: RawVerification, options: { demoAcceptUnlistedIssuer?: boolean; inspect?: boolean } = {}) {
    const client = {
      async getDocRequest() { return { sessionId: `sdk-${Math.random()}`, dcRequest: { deviceRequest: 'x', encryptionInfo: 'y' } }; },
      async verifyDocRequest() { return answer; },
    };
    const logs: string[] = [];
    const { app } = setup({ verifier: new CredenceVerifier(client as any), mode: 'real', ...options, log: (...a) => logs.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')) });
    return { app, logs };
  }
  const confirm = async (app: ReturnType<typeof realApp>['app']) => {
    const start = await request(app).post('/api/verify/start');
    return request(app).post('/api/verify/confirm').send({ sessionId: start.body.sessionId, data: 'wallet-answer' });
  };

  it('"true" with a recognised issuer: allowed', async () => {
    const { app, logs } = realApp(credence('true'), { inspect: true });
    const res = await confirm(app);
    expect(res.body).toMatchObject({ outcome: 'passed', reason: 'age_confirmed' });
    // Converted before logging: the inspect line and the decision see the boolean.
    expect(logs.find((l) => l.startsWith('[inspect] raw verifier response'))).toContain('"age_over_21":true');
    expect(logs).toContain('[firewall] decision=allow reason=age_confirmed');
    expect(logs.join('\n')).not.toContain(PORTRAIT.slice(0, 20));
  });

  it('"true" with an unlisted issuer and the demo override: allowed and marked', async () => {
    const { app, logs } = realApp(credence('true', authUnlisted), { demoAcceptUnlistedIssuer: true });
    const res = await confirm(app);
    expect(res.body).toMatchObject({ outcome: 'passed', reason: 'age_confirmed' });
    expect(res.body.receipt.issuerTrust).toBe('demo-unlisted');
    expect(logs).toContain('[firewall] WARNING demo override: issuer not on trust list');
  });

  it('"false": under age', async () => {
    const { app, logs } = realApp(credence('false'));
    expect((await confirm(app)).body).toMatchObject({ outcome: 'failed', reason: 'under_age', ticket: null });
    expect(logs).toContain('[firewall] decision=deny reason=under_age');
  });

  it('"True" and "FALSE" are converted like the lowercase words', async () => {
    const allowed = realApp(credence('True'));
    expect((await confirm(allowed.app)).body).toMatchObject({ outcome: 'passed', reason: 'age_confirmed' });
    const refused = realApp(credence('FALSE'));
    expect((await confirm(refused.app)).body).toMatchObject({ outcome: 'failed', reason: 'under_age', ticket: null });
  });

  it('"yes", 1 and "true " are still refused as unreadable', async () => {
    for (const v of ['yes', 1, 'true ']) {
      const { app } = realApp(credence(v));
      expect((await confirm(app)).body).toMatchObject({ outcome: 'failed', reason: 'unreadable_response', ticket: null });
    }
  });

  it('a real boolean true is unchanged and allowed', async () => {
    const raw = credence(true);
    expect(normalizeCredenceAgeFlags(raw)).toBe(raw);
    const { app } = realApp(raw);
    expect((await confirm(app)).body).toMatchObject({ outcome: 'passed', reason: 'age_confirmed' });
  });

  it('the portrait is still discarded and named on the receipt', async () => {
    const { app } = realApp(credence('true'));
    const res = await confirm(app);
    expect(res.body.receipt.discardedFieldNames).toEqual(['portrait']);
    expect(res.text).not.toContain(PORTRAIT.slice(0, 20));
  });
});

describe('hybrid and mock are unaffected', () => {
  it('hybrid does not convert: a real-wallet answer with "true" is still refused', async () => {
    const client = {
      async getDocRequest() { return { sessionId: 's1', dcRequest: {} }; },
      async verifyDocRequest() { return credence('true'); },
    };
    const { app } = setup({ verifier: new HybridVerifier(client), mode: 'hybrid' });
    const start = await request(app).post('/api/verify/start');
    // Hybrid sends a non-"mock:" answer to the SDK verify call.
    const res = await request(app).post('/api/verify/confirm').send({ sessionId: start.body.sessionId, data: 'real-wallet-answer' });
    expect(res.body).toMatchObject({ outcome: 'failed', reason: 'unreadable_response' });
  });

  it('mock still works as before', async () => {
    const { app } = setup();
    expect((await buy(app, 'pass')).body.outcome).toBe('passed');
    expect((await buy(app, 'under')).body.reason).toBe('under_age');
  });
});
