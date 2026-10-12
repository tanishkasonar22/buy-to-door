// Flags column names that look like they hold personal data.
// Matches whole underscore-separated words, so "received_field_names" is fine
// but "given_name" or "birth_date" is flagged.
const PII_WORDS = new Set([
  'name', 'first', 'last', 'given', 'family', 'surname', 'birth', 'birthdate', 'dob',
  'address', 'portrait', 'photo', 'license', 'licence', 'document', 'signature', 'ssn',
]);

export function personalDataShapedColumns(columns: Record<string, string[]>): string[] {
  return Object.entries(columns).flatMap(([table, cols]) =>
    cols.filter((c) => c.toLowerCase().split('_').some((w) => PII_WORDS.has(w))).map((c) => `${table}.${c}`),
  );
}
