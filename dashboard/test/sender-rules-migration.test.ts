// Spec 002 FR7 (Stage 2b-1) drift gate — runs WITHOUT a DB.
// Pins migration 049's target_bucket CHECK to the CATEGORIES tuple (the same
// 23-value union migration 048 widened the category CHECK to), so the Train
// table can never accept a bucket the classifier can't emit. Mirrors the
// migration-048 case in schema-invariants.test.ts.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CATEGORIES } from '../lib/classification/prompt';

describe('migration 049 sender_rules — CHECK lists stay in lockstep with CATEGORIES', () => {
  const migDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
  const migFile = readdirSync(migDir).find((f) => f.startsWith('049') && f.endsWith('.sql'));

  it('migration 049 (.sql) exists', () => {
    expect(migFile, 'migration 049 must exist').toBeTruthy();
  });

  const sql = migFile ? readFileSync(join(migDir, migFile), 'utf8') : '';
  // Drop comment lines so the ROLLBACK prose (which also names buckets) is not parsed.
  const live = sql
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n');

  it('target_bucket CHECK equals CATEGORIES exactly', () => {
    const m = live.match(
      /sender_rules_target_bucket_check CHECK \(target_bucket = ANY \(ARRAY\[([\s\S]*?)\]\)\)/,
    );
    expect(m, 'target_bucket CHECK must be present').toBeTruthy();
    const values = [...(m as RegExpMatchArray)[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    expect([...new Set(values)].sort()).toEqual([...CATEGORIES].sort());
  });

  it('kind CHECK is (email, domain) and mode CHECK is (force, bias)', () => {
    expect(live).toMatch(/sender_rules_kind_check CHECK \(kind IN \('email', 'domain'\)\)/);
    expect(live).toMatch(/sender_rules_mode_check CHECK \(mode IN \('force', 'bias'\)\)/);
  });

  it('is account-scoped (NOT NULL) and idempotent-unique on (account_id, match, kind)', () => {
    expect(live).toMatch(/account_id\s+INTEGER NOT NULL/);
    expect(live).toMatch(/sender_rules_account_match_kind_uidx[\s\S]*account_id, "match", kind/);
  });
});
