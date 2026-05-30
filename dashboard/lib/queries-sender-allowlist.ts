import { sql } from 'kysely';
import { getKysely } from '@/lib/db';
import {
  type ClassifyOneDeps,
  classifyOne,
  type InboxRowForClassify,
} from './classification/classify-one';
import { isHeuristicSpamDrop, neverSpamSurface } from './classification/sender-allowlist';

// MBOX-370 — never-spam allowlist write path + "reclassify automatically" action.
//
// reclassifyBySender():
//   1. upserts the sender into mailbox.sender_never_spam (the future rule — the
//      classify-time guard in classification-normalize then surfaces, never
//      drops, this sender).
//   2. re-runs the REAL classifier (classifyOne — same chain as MailBOX-Classify)
//      on the sender's existing emails so they get their correct category and
//      leave the spam bucket. Because the sender is now allowlisted, any
//      spam_marketing verdict (model or noreply heuristic) is surfaced to
//      unknown→cloud here too — mirroring the live guard.
//
// Relabel only — NO drafts are generated for historical mail (operator decision
// 2026-05-30; auto-drafting weeks-old mail is what classify-backfill deliberately
// avoids). Future inbound from the sender drafts normally via the live pipeline.
//
// Each email gets a classification_log row (the audit record) AND an explicit
// inbox_messages denorm update ({classification,confidence,classified_at,model}).
// On the live appliance the migration-021 trigger ALSO syncs inbox_messages off
// the log insert, but we write it explicitly too — matching the MBOX-123
// precedent ("correct even if the trigger is ever disabled") and so it works in
// test/codegen fixtures that don't carry the trigger.

// Cap the synchronous re-classify fan-out: each email is one local LLM call
// (~1-3s on the Jetson). 50 newest keeps the request bounded; older mail past
// the cap is reported via `truncated` and stays as-is (still un-spammed for the
// future via the allowlist).
const RECLASSIFY_CAP = 50;

// Bare-address extraction in SQL, mirroring lib/classification/preclass.ts
// extractAddress(): angle-bracket address if present, else the trimmed whole,
// lowercased. Keeps the match aligned with the stored allowlist email.
const BARE_ADDR_SQL = sql<string>`lower(coalesce(substring(from_addr from '<([^>]+)>'), trim(from_addr)))`;

export interface ReclassifySenderResult {
  email: string;
  allowlisted: boolean;
  reclassified: number;
  // How many of the re-classified rows were spam verdicts surfaced to unknown
  // by the never-spam guard (vs. the model naturally returning a non-spam type).
  surfaced: number;
  truncated: boolean;
}

export async function reclassifyBySender(input: {
  email: string;
  reason: string | null;
  deps?: ClassifyOneDeps;
}): Promise<ReclassifySenderResult> {
  const { email, reason, deps } = input;
  const db = getKysely();

  // 1. Upsert the never-spam allowlist row (idempotent on the unique email).
  await db
    .insertInto('sender_never_spam')
    .values({ email, reason, created_by: 'operator' })
    .onConflict((oc) => oc.column('email').doUpdateSet({ reason, updated_at: sql<string>`NOW()` }))
    .execute();

  // 2. Pull the sender's existing emails (newest first, capped).
  const rows = await db
    .selectFrom('inbox_messages')
    .select(['id', 'from_addr', 'to_addr', 'subject', 'body', 'snippet'])
    .where(sql<boolean>`${BARE_ADDR_SQL} = ${email}`)
    .orderBy('id', 'desc')
    .limit(RECLASSIFY_CAP + 1)
    .execute();

  const truncated = rows.length > RECLASSIFY_CAP;
  const batch = truncated ? rows.slice(0, RECLASSIFY_CAP) : rows;

  let reclassified = 0;
  let surfaced = 0;

  // Re-run the classifier per email. NOT wrapped in a single transaction — each
  // email is a slow LLM call, and holding a txn open across all of them would
  // pin a connection for many seconds. Each log insert is atomic on its own and
  // the trigger keeps inbox_messages in sync.
  for (const row of batch) {
    const inboxRow: InboxRowForClassify = {
      id: row.id,
      from_addr: row.from_addr,
      to_addr: row.to_addr,
      subject: row.subject,
      body: row.body,
      snippet: row.snippet,
    };

    let category = '';
    let confidence = 0;
    let modelVersion = '';
    let latencyMs: number | null = null;
    let rawOutput = '';
    let jsonParseOk = false;
    let thinkStripped = false;
    try {
      const r = await classifyOne(inboxRow, deps);
      category = r.category;
      confidence = r.confidence;
      modelVersion = r.model_version;
      latencyMs = r.latency_ms;
      rawOutput = r.raw_output;
      jsonParseOk = r.json_parse_ok;
      thinkStripped = r.think_stripped;

      // Never-spam guard: sender is allowlisted by construction here, so a
      // heuristic spam drop is surfaced to unknown→cloud, mirroring the live
      // classification-normalize guard.
      if (isHeuristicSpamDrop(r.category, r.preclass_source)) {
        category = neverSpamSurface(r.confidence).category;
        surfaced += 1;
      }
    } catch (error) {
      // One email's LLM failure shouldn't abort the whole sender. Skip it —
      // it keeps its current (spam) label but the sender is already allowlisted
      // for the future. Logged for the operator.
      console.error(`[reclassify] classifyOne failed for inbox ${row.id} — skipping:`, error);
      continue;
    }

    await db
      .insertInto('classification_log')
      .values({
        inbox_message_id: row.id,
        category,
        confidence,
        model_version: modelVersion,
        latency_ms: latencyMs,
        raw_output: rawOutput,
        json_parse_ok: jsonParseOk,
        think_stripped: thinkStripped,
      })
      .execute();

    // Explicit denorm write (see header note) — keeps inbox_messages correct
    // independent of the migration-021 trigger.
    await db
      .updateTable('inbox_messages')
      .set({
        classification: category,
        confidence,
        classified_at: sql<string>`NOW()`,
        model: modelVersion,
      })
      .where('id', '=', row.id)
      .execute();
    reclassified += 1;
  }

  return { email, allowlisted: true, reclassified, surfaced, truncated };
}

export interface NeverSpamRow {
  id: number;
  email: string;
  reason: string | null;
  created_at: string;
  updated_at: string;
  created_by: string;
}

export async function listNeverSpamSenders(): Promise<NeverSpamRow[]> {
  const rows = await getKysely()
    .selectFrom('sender_never_spam')
    .select(['id', 'email', 'reason', 'created_at', 'updated_at', 'created_by'])
    .orderBy('updated_at', 'desc')
    .execute();
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}
