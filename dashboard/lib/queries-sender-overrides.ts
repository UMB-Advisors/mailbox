import { sql } from 'kysely';
import type { Category } from '@/lib/classification/prompt';
import { getKysely } from '@/lib/db';

// MBOX-368 — sender-level classification override write path + read helper.
//
// reclassifyBySender() does the whole "past + future" job in ONE transaction:
//   1. upsert the sticky rule (mailbox.sender_classification_overrides) — this
//      is what the classify-time preclass (lib/classification/sender-override.ts)
//      reads so FUTURE inbound from the address is forced to `category`.
//   2. relabel every PAST inbox_messages row from that sender (exact bare-address
//      match, mirroring extractAddress semantics in SQL).
//   3. relabel any existing drafts on those messages (drafts.classification_category).
//   4. append one classification_log audit row per message — the source-of-truth
//      record of the relabel (model_version='operator-sender-override',
//      confidence=1.0, raw_output=operator reason). The migration-021 trigger on
//      each insert re-syncs inbox_messages.{classification,confidence,...}, so
//      step 2's denorm write is belt-and-suspenders (matches MBOX-123).
//
// Relabel ONLY — no drafts are generated for historical dropped (spam) mail
// (operator decision 2026-05-29). Future inbound drafts normally per the forced
// category's route.

const SENDER_OVERRIDE_MODEL_VERSION = 'operator-sender-override';

// Bare-address extraction in SQL, mirroring lib/classification/preclass.ts
// extractAddress(): if the header has an angle-bracket address take what's
// inside, else the trimmed whole; lowercased. Keeps the bulk match aligned with
// the value the operator stored and the classifier looks up.
const BARE_ADDR_SQL = sql<string>`lower(coalesce(substring(from_addr from '<([^>]+)>'), trim(from_addr)))`;

export interface ReclassifySenderResult {
  email: string;
  category: Category;
  inbox_messages_relabelled: number;
  drafts_relabelled: number;
  log_rows_appended: number;
}

export async function reclassifyBySender(input: {
  email: string;
  category: Category;
  reason: string | null;
}): Promise<ReclassifySenderResult> {
  const { email, category, reason } = input;
  const db = getKysely();

  return db.transaction().execute(async (trx) => {
    // Attribution GUCs — mirror MBOX-123 / lib/transitions.ts. The migration-009
    // state_transitions trigger only fires on drafts.status changes (a relabel
    // doesn't touch status), so no state_transitions row is produced; we set
    // them for convention + correct attribution of any status-touching write.
    await sql`SELECT set_config('mailbox.actor', 'operator', true)`.execute(trx);
    await sql`SELECT set_config('mailbox.transition_reason', 'sender-override', true)`.execute(trx);

    // 1. Upsert the sticky rule (idempotent on the unique email index).
    await trx
      .insertInto('sender_classification_overrides')
      .values({ email, category, reason, created_by: 'operator' })
      .onConflict((oc) =>
        oc.column('email').doUpdateSet({
          category,
          reason,
          updated_at: sql<string>`NOW()`,
        }),
      )
      .execute();

    // 2. Find every past inbox message from this sender.
    const msgs = await trx
      .selectFrom('inbox_messages')
      .select('id')
      .where(sql<boolean>`${BARE_ADDR_SQL} = ${email}`)
      .execute();
    const ids = msgs.map((m) => m.id);

    if (ids.length === 0) {
      return {
        email,
        category,
        inbox_messages_relabelled: 0,
        drafts_relabelled: 0,
        log_rows_appended: 0,
      };
    }

    // 3. Denormalized relabel on inbox_messages.
    await trx
      .updateTable('inbox_messages')
      .set({ classification: category })
      .where('id', 'in', ids)
      .execute();

    // 4. Relabel existing drafts (spam rows have none — this is a no-op for them).
    const draftsUpdated = await trx
      .updateTable('drafts')
      .set({ classification_category: category, updated_at: sql<string>`NOW()` })
      .where('inbox_message_id', 'in', ids)
      .executeTakeFirst();

    // 5. Append one audit row per message (SoT for the relabel). Trigger-021
    //    re-syncs inbox_messages off each insert.
    await trx
      .insertInto('classification_log')
      .values(
        ids.map((id) => ({
          inbox_message_id: id,
          category,
          confidence: 1.0,
          model_version: SENDER_OVERRIDE_MODEL_VERSION,
          json_parse_ok: true,
          raw_output: reason,
        })),
      )
      .execute();

    return {
      email,
      category,
      inbox_messages_relabelled: ids.length,
      drafts_relabelled: Number(draftsUpdated?.numUpdatedRows ?? 0),
      log_rows_appended: ids.length,
    };
  });
}

export interface SenderOverrideRow {
  id: number;
  email: string;
  category: string;
  reason: string | null;
  created_at: string;
  updated_at: string;
  created_by: string;
}

export async function listSenderOverrides(): Promise<SenderOverrideRow[]> {
  const rows = await getKysely()
    .selectFrom('sender_classification_overrides')
    .select(['id', 'email', 'category', 'reason', 'created_at', 'updated_at', 'created_by'])
    .orderBy('updated_at', 'desc')
    .execute();
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}
