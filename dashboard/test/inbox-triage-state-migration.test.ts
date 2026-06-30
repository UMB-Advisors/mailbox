// Spec 003 FR2/FR3 (Stage 3a) drift gate — runs WITHOUT a DB.
// Pins migration 051's triage_state CHECK to the closed 5-state lifecycle enum
// (needs_action · accepted · denied · done · snoozed) so the DB and the sidecar
// triage-state write path (features/_triage_state_logic.py TRIAGE_STATES) can
// never drift apart. Mirrors the migration-049 case in sender-rules-migration.test.ts.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const TRIAGE_STATES = ['needs_action', 'accepted', 'denied', 'done', 'snoozed'];

describe('migration 051 inbox_messages.triage_state — closed 5-state lifecycle enum', () => {
  const migDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
  const migFile = readdirSync(migDir).find((f) => f.startsWith('051') && f.endsWith('.sql'));

  it('migration 051 (.sql) exists', () => {
    expect(migFile, 'migration 051 must exist').toBeTruthy();
  });

  const sql = migFile ? readFileSync(join(migDir, migFile), 'utf8') : '';
  // Drop comment lines so the ROLLBACK / WHAT prose (which also names states) is
  // not parsed as the live CHECK.
  const live = sql
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n');

  it('triage_state CHECK equals the 5-state enum exactly', () => {
    const m = live.match(
      /inbox_messages_triage_state_check\s*\n?\s*CHECK \(triage_state IN \(([\s\S]*?)\)\)/,
    );
    expect(m, 'triage_state CHECK must be present').toBeTruthy();
    const values = [...(m as RegExpMatchArray)[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    expect([...new Set(values)].sort()).toEqual([...TRIAGE_STATES].sort());
  });

  it('triage_state is NOT NULL with DEFAULT needs_action', () => {
    expect(live).toMatch(
      /triage_state\s+TEXT NOT NULL DEFAULT 'needs_action'/,
    );
  });

  it('reuses snooze_until (adds no second snooze column)', () => {
    expect(live).not.toMatch(/ADD COLUMN[^\n]*snooze/i);
  });

  it('is account-scoped via a composite index on (account_id, triage_state)', () => {
    expect(live).toMatch(
      /inbox_messages_account_triage_state_idx[\s\S]*\(account_id, triage_state\)/,
    );
  });

  it('adds the light-audit columns the sidecar write path stamps', () => {
    expect(live).toMatch(/triage_state_updated_at\s+TIMESTAMPTZ/);
    expect(live).toMatch(/triage_state_updated_by\s+TEXT/);
  });
});
