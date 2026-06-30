// Spec 002 FR7 (Stage 2b-1) — Train sender-rules write path.
//
// Mirrors lib/queries-sender-allowlist.ts (the upsert/list shape) and
// lib/queries-vip.ts (account-scoped, lowercased match, idempotent on the
// (account_id, match, kind) unique index). The classify-time READ path is
// lib/classification/sender-rules.ts:senderRule (the fail-open / kill-switch
// lookup); these are the operator/seed WRITE helpers.

import { getKysely } from '@/lib/db';
import type { Category } from './classification/prompt';
import type { SenderRuleKind, SenderRuleMode } from './classification/sender-rules';
import { getDefaultAccountId } from './queries-accounts';

export interface UpsertSenderRuleInput {
  match: string;
  kind: SenderRuleKind;
  target_bucket: Category;
  mode: SenderRuleMode;
  reason?: string | null;
  created_by?: string | null;
  // Defaults to getDefaultAccountId() — the single-operator default inbox.
  account_id?: number;
}

export interface SenderRuleRow {
  id: number;
  match: string;
  kind: SenderRuleKind;
  target_bucket: Category;
  mode: SenderRuleMode;
  enabled: boolean;
  reason: string | null;
  created_by: string | null;
  created_at: string;
}

/**
 * Upsert one Train rule. Idempotent on (account_id, match, kind): re-seeding the
 * same sender updates its bucket/mode/reason and re-enables it rather than
 * duplicating. `match` is lowercased to align with the classify-time lookup.
 */
export async function upsertSenderRule(input: UpsertSenderRuleInput): Promise<void> {
  const accountId = input.account_id ?? (await getDefaultAccountId());
  const match = input.match.trim().toLowerCase();

  await getKysely()
    .insertInto('sender_rules')
    .values({
      account_id: accountId,
      match,
      kind: input.kind,
      target_bucket: input.target_bucket,
      mode: input.mode,
      reason: input.reason ?? null,
      created_by: input.created_by ?? 'operator',
      enabled: true,
    })
    .onConflict((oc) =>
      oc.columns(['account_id', 'match', 'kind']).doUpdateSet({
        target_bucket: input.target_bucket,
        mode: input.mode,
        reason: input.reason ?? null,
        enabled: true,
      }),
    )
    .execute();
}

/** List Train rules for an account (default account if omitted). Enabled-only by default. */
export async function listSenderRules(opts?: {
  account_id?: number;
  includeDisabled?: boolean;
}): Promise<SenderRuleRow[]> {
  const accountId = opts?.account_id ?? (await getDefaultAccountId());

  let q = getKysely()
    .selectFrom('sender_rules')
    .select([
      'id',
      'match',
      'kind',
      'target_bucket',
      'mode',
      'enabled',
      'reason',
      'created_by',
      'created_at',
    ])
    .where('account_id', '=', accountId);

  if (!opts?.includeDisabled) q = q.where('enabled', '=', true);

  const rows = await q.orderBy('match').execute();
  return rows.map((r) => ({
    id: r.id,
    match: r.match,
    kind: r.kind as SenderRuleKind,
    target_bucket: r.target_bucket as Category,
    mode: r.mode as SenderRuleMode,
    enabled: r.enabled,
    reason: r.reason,
    created_by: r.created_by,
    created_at: r.created_at,
  }));
}

/**
 * Disable (soft-delete) a Train rule — the reversible per-sender escape hatch.
 * Keeps the audit row; the classify-time lookup ignores disabled rows.
 */
export async function disableSenderRule(input: {
  match: string;
  kind: SenderRuleKind;
  account_id?: number;
}): Promise<void> {
  const accountId = input.account_id ?? (await getDefaultAccountId());
  const match = input.match.trim().toLowerCase();

  await getKysely()
    .updateTable('sender_rules')
    .set({ enabled: false })
    .where('account_id', '=', accountId)
    .where('match', '=', match)
    .where('kind', '=', input.kind)
    .execute();
}
