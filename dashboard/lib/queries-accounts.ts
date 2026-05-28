import { sql } from 'kysely';
import { getKysely } from '@/lib/db';

// MBOX-348 (MBOX-162 V1) — account resolution for multi-account ingestion.
//
// Every account-scoped table carries `account_id` (migration 033) with a column
// DEFAULT pointing at the seeded default account, so a writer that omits it
// still lands in the default inbox (the single-account path, un-changed). The
// ingestion fan-out instead passes the target account explicitly — by stable
// `account_email` (portable across appliances; ids differ per box) or by
// `account_id` — and these helpers turn that into the concrete id.

export interface AccountRow {
  id: number;
  email_address: string;
  display_label: string | null;
  is_default: boolean;
}

export async function listAccounts(): Promise<AccountRow[]> {
  const db = getKysely();
  return db
    .selectFrom('accounts')
    .select(['id', 'email_address', 'display_label', 'is_default'])
    .orderBy('id')
    .execute();
}

// The backfill target / single-operator default. Post-migration there is always
// exactly one row with is_default = true (enforced by the accounts_one_default
// partial unique index).
export async function getDefaultAccountId(): Promise<number> {
  const db = getKysely();
  const row = await db
    .selectFrom('accounts')
    .select('id')
    .where('is_default', '=', true)
    .executeTakeFirst();
  if (!row) throw new Error('no default account — migration 033 seed missing');
  return row.id;
}

export type ResolveAccountResult = { ok: true; account_id: number } | { ok: false; reason: string };

// Resolution order: explicit account_id wins; else resolve a stable
// account_email (case-insensitive — accounts.email_address is stored as the
// operator typed it); else fall back to the default account (the legacy
// single-account ingest path that sends neither). An account_email that does
// not match a connected account is a fan-out misconfiguration and is rejected
// rather than silently dumped into the default inbox — landing one identity's
// mail under another's voice/history is the exact failure multi-account exists
// to prevent.
export async function resolveIngestAccountId(input: {
  account_id?: number;
  account_email?: string;
}): Promise<ResolveAccountResult> {
  const db = getKysely();

  if (input.account_id !== undefined) {
    const row = await db
      .selectFrom('accounts')
      .select('id')
      .where('id', '=', input.account_id)
      .executeTakeFirst();
    if (!row) return { ok: false, reason: `unknown account_id ${input.account_id}` };
    return { ok: true, account_id: row.id };
  }

  if (input.account_email) {
    const email = input.account_email.trim().toLowerCase();
    const row = await db
      .selectFrom('accounts')
      .select('id')
      .where(sql<boolean>`lower(email_address) = ${email}`)
      .executeTakeFirst();
    if (!row) return { ok: false, reason: `unknown account_email ${input.account_email}` };
    return { ok: true, account_id: row.id };
  }

  return { ok: true, account_id: await getDefaultAccountId() };
}
