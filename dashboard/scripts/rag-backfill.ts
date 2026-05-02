// dashboard/scripts/rag-backfill.ts
//
// STAQPRO-190 — one-shot backfill of the Qdrant `email_messages` collection
// from the existing `mailbox.inbox_messages` and `mailbox.sent_history`
// rows. Idempotent on `message_id` (deterministic point IDs via
// pointIdFromMessageId — re-running upserts the same points).
//
// Scope decision (vs the full issue's "Gmail Sent backfill"): the appliance
// today has 57 inbound + 1 sent in Postgres. Backfilling from those local
// rows is the smallest correct change — it gets the corpus to "first useful
// state" without depending on Gmail OAuth scopes for historical fetch. The
// Gmail-API backfill of pre-appliance history (90 days / 1000 messages) is
// a separate, larger job; defer until retrieval quality (STAQPRO-191/192)
// shows the local-row corpus is too thin to be useful. Eric should weigh in
// before we make Gmail History API calls under his account at scale.
//
// Run from the dashboard container:
//   docker compose run --rm mailbox-dashboard \
//     sh -c 'POSTGRES_URL=$POSTGRES_URL OLLAMA_BASE_URL=http://ollama:11434 \
//            QDRANT_URL=http://qdrant:6333 npx tsx scripts/rag-backfill.ts'
//
// Failure mode: per-row try/catch logs and continues. Final summary lists
// counts. Non-zero exit only on connection-level catastrophe.

import process from 'node:process';
import { Pool } from 'pg';
import { embedText } from '../lib/rag/embed';
import { buildBodyExcerpt, buildEmbeddingInput } from '../lib/rag/excerpt';
import { type Direction, upsertEmailPoint } from '../lib/rag/qdrant';

interface BackfillRow {
  message_id: string;
  thread_id: string | null;
  sender: string;
  recipient: string;
  subject: string | null;
  body: string;
  sent_at: string;
  direction: Direction;
  classification_category: string | null;
}

async function fetchInbox(pool: Pool, lookbackDays: number): Promise<BackfillRow[]> {
  const r = await pool.query<BackfillRow>(
    `
    SELECT
      message_id,
      thread_id,
      COALESCE(from_addr, '')      AS sender,
      COALESCE(to_addr, '')        AS recipient,
      subject,
      COALESCE(body, '')           AS body,
      COALESCE(received_at, NOW()) AS sent_at,
      'inbound'::text              AS direction,
      classification              AS classification_category
    FROM mailbox.inbox_messages
    WHERE COALESCE(received_at, created_at) > NOW() - make_interval(days => $1)
      AND message_id IS NOT NULL
    `,
    [lookbackDays],
  );
  return r.rows;
}

async function fetchSent(pool: Pool, lookbackDays: number): Promise<BackfillRow[]> {
  const r = await pool.query<BackfillRow>(
    `
    SELECT
      'sent_history:' || sh.id::text AS message_id,
      sh.thread_id,
      sh.from_addr                   AS sender,
      sh.to_addr                     AS recipient,
      sh.subject,
      COALESCE(sh.draft_sent, '')    AS body,
      sh.sent_at,
      'outbound'::text               AS direction,
      sh.classification_category
    FROM mailbox.sent_history sh
    WHERE sh.sent_at > NOW() - make_interval(days => $1)
    `,
    [lookbackDays],
  );
  return r.rows;
}

async function backfillRow(row: BackfillRow): Promise<'ok' | 'skip' | 'fail'> {
  const excerpt = buildBodyExcerpt(row.body);
  const input = buildEmbeddingInput(row.subject, excerpt);
  if (!input.trim()) return 'skip';
  const vector = await embedText(input);
  if (!vector) return 'fail';
  const r = await upsertEmailPoint(vector, {
    message_id: row.message_id,
    thread_id: row.thread_id,
    sender: row.sender,
    recipient: row.recipient,
    subject: row.subject,
    body_excerpt: excerpt,
    sent_at: typeof row.sent_at === 'string' ? row.sent_at : new Date(row.sent_at).toISOString(),
    direction: row.direction,
    classification_category: row.classification_category,
  });
  return r.ok ? 'ok' : 'fail';
}

async function main(): Promise<void> {
  const url = process.env.POSTGRES_URL;
  if (!url) throw new Error('POSTGRES_URL not set');
  const lookbackDays = Number(process.env.RAG_BACKFILL_LOOKBACK_DAYS ?? 90);

  const pool = new Pool({ connectionString: url, max: 2 });
  console.log(`[rag-backfill] lookback=${lookbackDays}d`);

  const [inbox, sent] = await Promise.all([
    fetchInbox(pool, lookbackDays),
    fetchSent(pool, lookbackDays),
  ]);
  const all = [...inbox, ...sent];
  console.log(
    `[rag-backfill] fetched ${inbox.length} inbox + ${sent.length} sent = ${all.length} rows`,
  );

  const counts = { ok: 0, skip: 0, fail: 0 };
  let i = 0;
  for (const row of all) {
    i += 1;
    try {
      const r = await backfillRow(row);
      counts[r] += 1;
      if (i % 25 === 0 || i === all.length) {
        console.log(
          `[rag-backfill] ${i}/${all.length} ok=${counts.ok} skip=${counts.skip} fail=${counts.fail}`,
        );
      }
    } catch (err) {
      counts.fail += 1;
      console.error(`[rag-backfill] ${row.message_id} threw:`, err);
    }
  }
  console.log(`[rag-backfill] complete — ok=${counts.ok} skip=${counts.skip} fail=${counts.fail}`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
