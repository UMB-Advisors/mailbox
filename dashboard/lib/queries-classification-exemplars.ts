// Spec 002 FR7b (Stage 2b-2) — classifier few-shot exemplars write/read path.
//
// Mirrors lib/queries-sender-rules.ts (the upsert/list/disable shape, idempotent
// on a unique index, account-scoped via getDefaultAccountId). The classify-time
// READ path is lib/classification/exemplars.ts:retrieveClassificationExemplars
// (fail-closed, ranked + capped); these are the operator/seed/Train WRITE helpers
// plus the raw list the retrieval layer ranks. This is what the Spec 003 Train UI
// writes to when the operator corrects a message (the corrected message → an exemplar).

import { sql } from 'kysely';
import { getKysely } from '@/lib/db';
import type { Category } from './classification/prompt';
import { getDefaultAccountId } from './queries-accounts';

export interface UpsertClassificationExemplarInput {
  snippet: string;
  bucket: Category;
  // The corrected message id this exemplar is minted from. Present for Train
  // corrections (the idempotency key); null/omitted for hand-authored exemplars
  // (which may repeat — the unique index is partial on source_msg_id).
  source_msg_id?: string | null;
  company?: string | null;
  reason?: string | null;
  created_by?: string | null;
  // Defaults to getDefaultAccountId() — the single-operator default inbox.
  account_id?: number;
}

export interface ClassificationExemplarRow {
  id: number;
  snippet: string;
  bucket: Category;
  company: string | null;
  source_msg_id: string | null;
  enabled: boolean;
  reason: string | null;
  created_by: string | null;
  created_at: string;
}

/**
 * Upsert one classifier exemplar. When source_msg_id is present the write is
 * idempotent on (account_id, source_msg_id) — re-correcting the same message
 * updates its snippet/bucket and re-enables it rather than duplicating. With no
 * source_msg_id (hand-authored) it is a plain insert (the unique index is
 * partial). Returns the row id.
 */
export async function upsertClassificationExemplar(
  input: UpsertClassificationExemplarInput,
): Promise<number> {
  const accountId = input.account_id ?? (await getDefaultAccountId());
  const snippet = input.snippet.trim();
  const sourceMsgId = input.source_msg_id ?? null;

  let q = getKysely()
    .insertInto('classification_exemplars')
    .values({
      account_id: accountId,
      snippet,
      bucket: input.bucket,
      company: input.company ?? null,
      source_msg_id: sourceMsgId,
      reason: input.reason ?? null,
      created_by: input.created_by ?? 'operator',
      enabled: true,
    });

  if (sourceMsgId !== null) {
    // Conflict target is the PARTIAL unique index (account_id, source_msg_id)
    // WHERE source_msg_id IS NOT NULL — so re-training the same message updates
    // in place. Hand-authored (null) rows skip this branch → plain insert.
    q = q.onConflict((oc) =>
      oc
        .columns(['account_id', 'source_msg_id'])
        .where('source_msg_id', 'is not', null)
        .doUpdateSet({
          snippet,
          bucket: input.bucket,
          company: input.company ?? null,
          reason: input.reason ?? null,
          enabled: true,
        }),
    );
  }

  const row = await q.returning('id').executeTakeFirstOrThrow();
  return row.id;
}

/**
 * List exemplars for an account (default account if omitted). Enabled-only by
 * default, most-recent first. `preferBucket` floats rows of that bucket to the
 * top WITHOUT excluding others (the retrieval layer re-ranks cross-bucket).
 * `limit` caps the fetched window (the retrieval layer over-fetches, then the
 * pure selectExemplars applies the real ctx cap).
 */
export async function listClassificationExemplars(opts?: {
  account_id?: number;
  bucket?: Category;
  preferBucket?: Category;
  limit?: number;
  includeDisabled?: boolean;
}): Promise<ClassificationExemplarRow[]> {
  const accountId = opts?.account_id ?? (await getDefaultAccountId());

  let q = getKysely()
    .selectFrom('classification_exemplars')
    .select([
      'id',
      'snippet',
      'bucket',
      'company',
      'source_msg_id',
      'enabled',
      'reason',
      'created_by',
      'created_at',
    ])
    .where('account_id', '=', accountId);

  if (!opts?.includeDisabled) q = q.where('enabled', '=', true);
  if (opts?.bucket) q = q.where('bucket', '=', opts.bucket);
  if (opts?.preferBucket) {
    // Boolean expression: prefer-bucket rows (TRUE) sort before others (FALSE).
    q = q.orderBy(sql`(bucket = ${opts.preferBucket})`, 'desc');
  }
  q = q.orderBy('created_at', 'desc');
  if (opts?.limit != null) q = q.limit(opts.limit);

  const rows = await q.execute();
  return rows.map((r) => ({
    id: r.id,
    snippet: r.snippet,
    bucket: r.bucket as Category,
    company: r.company,
    source_msg_id: r.source_msg_id,
    enabled: r.enabled,
    reason: r.reason,
    created_by: r.created_by,
    created_at: r.created_at,
  }));
}

/**
 * Disable (soft-delete) one exemplar by id — the reversible escape hatch. Keeps
 * the audit row; the retrieval path ignores disabled rows.
 */
export async function disableClassificationExemplar(input: {
  id: number;
  account_id?: number;
}): Promise<void> {
  const accountId = input.account_id ?? (await getDefaultAccountId());
  await getKysely()
    .updateTable('classification_exemplars')
    .set({ enabled: false })
    .where('id', '=', input.id)
    .where('account_id', '=', accountId)
    .execute();
}
