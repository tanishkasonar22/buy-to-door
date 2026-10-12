import { describe, expect, it } from 'vitest';
import { applyFirewall } from '../src/firewall.js';
import { MockVerifier } from '../src/identity.js';

const mock = new MockVerifier('age_over_21');
const run = async (scenario: string) => applyFirewall(await mock.verify('s', `mock:${scenario}`), 'age_over_21');

describe('data firewall', () => {
  it('passes a verified adult', async () => {
    const out = await run('pass');
    expect(out.outcome).toBe('passed');
    expect(out.reason).toBe('age_confirmed');
  });

  it('fails an under-age result', async () => {
    expect((await run('under')).reason).toBe('under_age');
  });

  it('reports a cancelled wallet', async () => {
    expect((await run('cancel')).outcome).toBe('cancelled');
  });

  it('fails when the verifier says the checks failed', async () => {
    expect((await run('invalid')).outcome).toBe('failed');
  });

  it('is indeterminate when the age field is missing', async () => {
    const out = await run('noage');
    expect(out.outcome).toBe('indeterminate');
    expect(out.reason).toBe('age_claim_missing');
  });

  it('fails when a signature check is false even if res is true', () => {
    const resDetails = JSON.stringify({
      identity: { age_over_21: true },
      authentication: { deviceSignedAuthenticated: false },
    });
    expect(applyFirewall({ res: true, resDetails }, 'age_over_21').outcome).toBe('failed');
  });

  it('fails on unreadable JSON', () => {
    expect(applyFirewall({ res: true, resDetails: '{nope' }, 'age_over_21').reason).toBe('unreadable_response');
  });

  it('lists dropped field NAMES and carries no values', async () => {
    const out = await run('pass');
    expect(out.discardedFieldNames).toEqual(['birth_date', 'family_name', 'given_name', 'portrait']);
    const text = JSON.stringify(out);
    for (const value of ['Testperson', 'Examplesurname', '1990-01-01', 'AAAA']) {
      expect(text).not.toContain(value);
    }
  });
});
