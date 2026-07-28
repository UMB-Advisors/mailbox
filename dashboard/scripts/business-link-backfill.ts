// dashboard/scripts/business-link-backfill.ts
//
// M5 Phase 5 (05-03) — MAP-04 / D-09 / D-10 / D-11: one-shot backfill that
// links every already-connected mailbox account to a CRM business.
//
// WHY A SCRIPT, NOT SQL INSIDE A MIGRATION: migration 057 (plan 05-01)
// deliberately left accounts.business_id untouched on every existing row.
// D-10's whole point is that this backfill calls the exact same
// linkAccountToBusiness() rule the runtime connect-time hook now uses
// (lib/crm/auto-link.ts, wired into lib/queries-accounts.ts by plan 05-03's
// first commit) rather than a hand-written mapping table that could
// silently drift from the real rule over time. Running this script is
// therefore also a live, real-world exercise of the hook logic — see D-10
// in .planning/phases/05-backend-data-model-auto-create/05-CONTEXT.md.
//
// Idempotent (D-11): only ever processes rows where business_id IS NULL, so
// a second run finds nothing to do — it never overwrites an operator's
// later re-mapping (Phase 6).
//
// Run:
//   npm run business:backfill                       # live run, POSTGRES_URL required
//   BACKFILL_DRY_RUN=1 npm run business:backfill     # read-only preview, writes nothing
//
// Exit codes: 0 on success (dry run always exits 0 — it never fails the
// gate since it makes no writes to fail with; a live run exits 0 only when
// every candidate account ends up linked). 1 if any account is left with
// business_id IS NULL after a live run, or on a connection-level failure —
// this is the machine-checkable gate plan 05-04's live deploy step relies
// on instead of requiring the operator to read prose output.

import process from 'node:process';
import {
  extractEmailDomain,
  findBusinessIdBySiblingDomain,
  isFreeMailDomain,
  linkAccountToBusiness,
  resolveBusinessName,
} from '../lib/crm/auto-link';
import { getPool } from '../lib/db';

// Mirrors lib/queries-accounts.ts's SENTINEL_DEFAULT_EMAIL (not exported
// from that module — the literal is duplicated here on purpose). An
// unclaimed sentinel row is not a real mailbox and must never produce a
// business named after the appliance host.
const SENTINEL_EMAIL = 'primary@appliance.local';

interface CandidateRow {
  id: number;
  email_address: string;
  display_label: string | null;
}

async function fetchCandidates(): Promise<CandidateRow[]> {
  const { rows } = await getPool().query<CandidateRow>(
    `SELECT id, email_address, display_label
       FROM mailbox.accounts
      WHERE business_id IS NULL
        AND email_address <> $1
      ORDER BY id`,
    [SENTINEL_EMAIL],
  );
  return rows;
}

async function countUnlinked(): Promise<number> {
  const { rows } = await getPool().query<{ count: string }>(
    `SELECT count(*)::text AS count FROM mailbox.accounts
      WHERE business_id IS NULL AND email_address <> $1`,
    [SENTINEL_EMAIL],
  );
  return Number(rows[0]?.count ?? 0);
}

async function countBusinesses(): Promise<number> {
  const { rows } = await getPool().query<{ count: string }>(
    'SELECT count(*)::text AS count FROM mailbox.businesses',
  );
  return Number(rows[0]?.count ?? 0);
}

async function findBusinessIdByName(name: string): Promise<number | null> {
  const { rows } = await getPool().query<{ id: number }>(
    'SELECT id FROM mailbox.businesses WHERE name = $1',
    [name],
  );
  return rows[0]?.id ?? null;
}

async function getBusinessName(id: number): Promise<string> {
  const { rows } = await getPool().query<{ name: string }>(
    'SELECT name FROM mailbox.businesses WHERE id = $1',
    [id],
  );
  return rows[0]?.name ?? '(unknown)';
}

// Dry-run resolution mirrors linkAccountToBusiness's D-16 fixed order
// exactly (sentinel already excluded by the candidate query; free-mail gate;
// sibling-domain attach; find-or-create by name) but calls only the
// read-only primitives — it never writes, and never calls
// linkAccountToBusiness or findOrCreateBusiness (both write).
async function resolveDryRun(row: CandidateRow): Promise<string> {
  const domain = extractEmailDomain(row.email_address);
  if (!isFreeMailDomain(domain)) {
    const siblingId = await findBusinessIdBySiblingDomain(domain);
    if (siblingId !== null) {
      const name = await getBusinessName(siblingId);
      return `attach to sibling business #${siblingId} (${name})`;
    }
  }
  const name = resolveBusinessName(row.email_address, row.display_label);
  const existingId = await findBusinessIdByName(name);
  return existingId !== null
    ? `reuse existing business #${existingId} (${name})`
    : `create new business "${name}"`;
}

async function runDryRun(candidates: CandidateRow[]): Promise<void> {
  for (const row of candidates) {
    const resolution = await resolveDryRun(row);
    console.log(`[business-link-backfill] DRY RUN ${row.email_address} -> ${resolution}`);
  }
  console.log(
    `[business-link-backfill] DRY RUN complete — ${candidates.length} account(s) previewed, no writes made`,
  );
}

// Serial, not parallel: findOrCreateBusiness / generateUniqueSlug both
// read-then-write, and this table holds single-digit row counts on a real
// appliance today — serial execution over a handful of rows removes any
// interleaving question entirely at zero real cost.
async function runLive(candidates: CandidateRow[]): Promise<void> {
  let businessesCreated = 0;
  let failed = 0;

  for (const row of candidates) {
    const beforeCount = await countBusinesses();
    await linkAccountToBusiness({
      accountId: row.id,
      email: row.email_address,
      displayLabel: row.display_label,
    });
    const afterCount = await countBusinesses();
    if (afterCount > beforeCount) businessesCreated += 1;

    const { rows } = await getPool().query<{ business_id: number | null }>(
      'SELECT business_id FROM mailbox.accounts WHERE id = $1',
      [row.id],
    );
    const businessId = rows[0]?.business_id ?? null;
    if (businessId === null) {
      failed += 1;
      console.error(
        `[business-link-backfill] FAILED to link ${row.email_address} (id=${row.id}) — see the [auto-link] log line above for the underlying error`,
      );
    } else {
      const name = await getBusinessName(businessId);
      console.log(
        `[business-link-backfill] linked ${row.email_address} (id=${row.id}) -> business #${businessId} (${name})`,
      );
    }
  }

  const stillUnlinked = await countUnlinked();
  console.log(
    `[business-link-backfill] complete — processed=${candidates.length} businesses_created=${businessesCreated} failed=${failed} still_unlinked=${stillUnlinked}`,
  );

  if (stillUnlinked > 0) {
    console.error(
      `[business-link-backfill] ${stillUnlinked} account(s) remain unlinked with business_id IS NULL — failing the gate`,
    );
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const url = process.env.POSTGRES_URL;
  if (!url) throw new Error('POSTGRES_URL not set');
  const dryRun = process.env.BACKFILL_DRY_RUN === '1';

  try {
    const candidates = await fetchCandidates();
    console.log(
      `[business-link-backfill] ${dryRun ? 'DRY RUN — ' : ''}${candidates.length} candidate account(s) with business_id IS NULL`,
    );

    if (dryRun) {
      await runDryRun(candidates);
    } else {
      await runLive(candidates);
    }
  } finally {
    await getPool().end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
