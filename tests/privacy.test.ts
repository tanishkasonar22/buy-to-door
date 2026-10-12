import { describe, expect, it } from 'vitest';
import { personalDataShapedColumns } from '../src/privacy.js';

describe('personal-data column check', () => {
  it('flags columns that look like personal data', () => {
    const flagged = personalDataShapedColumns({
      people: ['id', 'given_name', 'birth_date', 'home_address', 'portrait'],
    });
    expect(flagged).toEqual(['people.given_name', 'people.birth_date', 'people.home_address', 'people.portrait']);
  });

  it('does not flag columns that hold field names or timestamps', () => {
    expect(
      personalDataShapedColumns({
        privacy_receipts: ['received_field_names', 'discarded_field_names', 'verified_at', 'verification_ref'],
      }),
    ).toEqual([]);
  });
});
