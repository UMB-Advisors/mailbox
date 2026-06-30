// Spec 002 FR7b (Stage 2b-2) drift gate — runs WITHOUT a DB.
// Pins migration 050's bucket CHECK to the CATEGORIES tuple (the same 23-value
// union migrations 048/049 use), so the few-shot exemplar table can never store
// a bucket the classifier can't emit. Mirrors the migration-049 case in
// test/sender-rules-migration.test.ts.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CATEGORIES } from '../lib/classification/prompt';

describe('migration 050 classification_exemplars — CHECK stays in lockstep with CATEGORIES', () => {
  const migDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
  const migFile = readdirSync(migDir).find((f) => f.startsWith('050') && f.endsWith('.sql'));

  it('migration 050 (.sql) exists', () => {
    expect(migFile, 'migration 050 must exist').toBeTruthy();
  });

  const sql = migFile ? readFileSync(join(migDir, migFile), 'utf8') : '';
  // Drop comment lines so the ROLLBACK prose (which also names buckets) is not parsed.
  const live = sql
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n');

  it('bucket CHECK equals CATEGORIES exactly', () => {
    const m = live.match(
      /classification_exemplars_bucket_check CHECK \(bucket = ANY \(ARRAY\[([\s\S]*?)\]\)\)/,
    );
    expect(m, 'bucket CHECK must be present').toBeTruthy();
    const values = [...(m as RegExpMatchArray)[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    expect([...new Set(values)].sort()).toEqual([...CATEGORIES].sort());
  });

  it('is account-scoped (NOT NULL) and idempotent-unique on (account_id, source_msg_id)', () => {
    expect(live).toMatch(/account_id\s+INTEGER NOT NULL/);
    expect(live).toMatch(
      /classification_exemplars_account_source_uidx[\s\S]*account_id, source_msg_id/,
    );
  });

  it('the fixtures schema snapshot carries the same table (codegen source)', () => {
    const fixture = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'schema.sql'),
      'utf8',
    );
    expect(fixture).toMatch(/CREATE TABLE IF NOT EXISTS mailbox\.classification_exemplars/);
  });
});
