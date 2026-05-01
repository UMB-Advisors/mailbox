import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CATEGORIES } from '../lib/classification/prompt';

// Highest-leverage test for STAQPRO-133. Asserts that the live Postgres
// CHECK constraints match (or are compatible with) the TS-side constants.
// Catches drift between code and DB enums — the kind of drift that bit
// the 2026-05-01 docs sync (status state machine + draft_source values).
//
// Requires a Postgres reachable via TEST_POSTGRES_URL or POSTGRES_URL.
// Locally: SSH-tunnel to Bob with `ssh -L 5432:localhost:5432 jetson-tailscale -N`,
// then `TEST_POSTGRES_URL=postgresql://mailbox:<pw>@localhost:5432/mailbox npm test`.
// In CI: provided by the workflow (STAQPRO-134).
//
// If no DB is reachable, all DB-touching cases are skipped (not failed) so
// `npm test` still runs green for non-DB suites.

const DB_URL = process.env.TEST_POSTGRES_URL ?? process.env.POSTGRES_URL;

interface CheckRow {
  def: string;
}

async function getCheckValues(
  pool: Pool,
  table: string,
  constraintName: string,
): Promise<readonly string[]> {
  const { rows } = await pool.query<CheckRow>(
    `
    SELECT pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'mailbox'
      AND t.relname = $1
      AND c.conname = $2
    `,
    [table, constraintName],
  );
  if (rows.length === 0) {
    throw new Error(`CHECK constraint not found: mailbox.${table} / ${constraintName}`);
  }
  // pg_get_constraintdef returns:
  //   CHECK ((status = ANY (ARRAY['pending'::text, 'awaiting_cloud'::text, ...])))
  const def = rows[0].def;
  const matches = [...def.matchAll(/'([^']+)'::text/g)];
  return matches.map((m) => m[1]);
}

describe('mailbox schema invariants (drafts CHECK constraints ↔ TS constants)', () => {
  let pool: Pool | undefined;

  beforeAll(async () => {
    if (!DB_URL) {
      console.warn(
        '[schema-invariants] no TEST_POSTGRES_URL or POSTGRES_URL — skipping DB-backed cases.\n' +
          '  Tunnel: ssh -L 5432:localhost:5432 jetson-tailscale -N\n' +
          '  Run:    TEST_POSTGRES_URL=postgresql://mailbox:<pw>@localhost:5432/mailbox npm test',
      );
      return;
    }
    pool = new Pool({ connectionString: DB_URL, max: 2 });
  });

  afterAll(async () => {
    await pool?.end();
  });

  it.skipIf(!DB_URL)(
    'drafts.status CHECK matches the live state machine (pending → awaiting_cloud → approved/rejected/edited → sent/failed)',
    async () => {
      const allowed = await getCheckValues(pool!, 'drafts', 'drafts_status_check');
      const expected = [
        'pending',
        'awaiting_cloud',
        'approved',
        'rejected',
        'edited',
        'sent',
        'failed',
      ];
      expect([...allowed].sort()).toEqual([...expected].sort());
    },
  );

  it.skipIf(!DB_URL)(
    'drafts.draft_source CHECK accepts every route currently written by the live drafting path',
    async () => {
      const allowed = await getCheckValues(pool!, 'drafts', 'drafts_draft_source_check');
      // Live writes today: 'local' | 'cloud'. Constraint also keeps the legacy
      // 'local_qwen3' | 'cloud_haiku' values from migration 002→003 era for
      // backward compatibility. All four must be accepted; if a migration
      // narrows this set, this test catches it.
      for (const v of ['local', 'cloud', 'local_qwen3', 'cloud_haiku']) {
        expect(allowed).toContain(v);
      }
    },
  );

  it.skipIf(!DB_URL)(
    'drafts.classification_category CHECK matches CATEGORIES from lib/classification/prompt.ts',
    async () => {
      const allowed = await getCheckValues(pool!, 'drafts', 'drafts_classification_category_check');
      const expected = [...CATEGORIES];
      expect([...allowed].sort()).toEqual([...expected].sort());
    },
  );

  // Pure code-level invariant — does not need DB.
  it('CATEGORIES from prompt.ts has no duplicates and is non-empty', () => {
    expect(CATEGORIES.length).toBeGreaterThan(0);
    expect(new Set(CATEGORIES).size).toBe(CATEGORIES.length);
  });

  // Pure code-level invariant — confidence floor is in (0, 1) range.
  it('LOCAL_CONFIDENCE_FLOOR is a sane probability', async () => {
    const { LOCAL_CONFIDENCE_FLOOR } = await import('../lib/classification/prompt');
    expect(LOCAL_CONFIDENCE_FLOOR).toBeGreaterThan(0);
    expect(LOCAL_CONFIDENCE_FLOOR).toBeLessThan(1);
  });
});
