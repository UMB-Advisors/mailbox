import { sql } from 'kysely';
import { type NextRequest, NextResponse } from 'next/server';
import { getKysely } from '@/lib/db';
import { parseJson } from '@/lib/middleware/validate';
import { embedText } from '@/lib/rag/embed';
import { buildBodyExcerpt, buildEmbeddingInput } from '@/lib/rag/excerpt';
import { upsertEmailPoint } from '@/lib/rag/qdrant';
import { inboxMessageInsertBodySchema } from '@/lib/schemas/internal';

export const dynamic = 'force-dynamic';

// STAQPRO-135 — n8n ↔ dashboard ↔ Postgres ownership boundary refactor.
//
// Replaces the legacy n8n `Insert Inbox (skip dupes)` Postgres node so n8n no
// longer writes to `mailbox.inbox_messages` directly. The dashboard becomes
// the single writer for the schema; n8n shrinks to a Gmail / Ollama / HTTP
// adapter.
//
// Response shape — LOCKED contract (downstream `MailBOX-Classify > Load Inbox
// Row` reads `$json.id`; do not break this without coordinating the n8n
// workflow JSON change in the same PR):
//
//   { id: number, message_id: string, created: boolean }
//
// `created` distinguishes a new insert from a dedupe-on-message_id skip via
// the postgres `xmax = 0` trick. xmax is 0 for tuples freshly inserted in the
// current transaction; non-zero on rows that were UPDATE-touched (which is
// what `ON CONFLICT DO UPDATE SET message_id = EXCLUDED.message_id` does to
// force the existing row's `id` into RETURNING). The no-op self-update is
// safe because `mailbox.inbox_messages` has no triggers and no `updated_at`
// column to bump.

export async function POST(req: NextRequest) {
  const b = await parseJson(req, inboxMessageInsertBodySchema);
  if (!b.ok) return b.response;
  const { message_id, received_at, ...rest } = b.data;

  try {
    const db = getKysely();
    const row = await db
      .insertInto('inbox_messages')
      .values({
        message_id,
        ...rest,
        // received_at is optional in the body; only include when provided so
        // missing values land as NULL rather than 'undefined' string.
        ...(received_at !== undefined ? { received_at } : {}),
      })
      .onConflict((oc) =>
        oc.column('message_id').doUpdateSet((eb) => ({
          message_id: eb.ref('excluded.message_id'),
        })),
      )
      .returning(['id', 'message_id', sql<boolean>`xmax = 0`.as('created')])
      .executeTakeFirstOrThrow();

    // STAQPRO-190 — fire-and-forget embed + Qdrant upsert for newly-inserted
    // inbox rows. Skipped on dedup (created=false) since the point already
    // exists with deterministic id (idempotent on re-run anyway, but skipping
    // saves an Ollama call per 5-min Gmail poll cycle).
    //
    // Failure is silent on purpose: RAG is augmentation, not gate. The
    // response to n8n must not depend on Qdrant/Ollama health, otherwise a
    // momentarily-down RAG stack stalls the draft pipeline.
    if (row.created) {
      void embedAndUpsertInbound({
        message_id: row.message_id,
        thread_id: rest.thread_id ?? null,
        sender: rest.from_addr ?? '',
        recipient: rest.to_addr ?? '',
        subject: rest.subject ?? null,
        body: rest.body ?? '',
        sent_at: received_at ?? new Date().toISOString(),
      });
    }

    return NextResponse.json({
      id: row.id,
      message_id: row.message_id,
      created: row.created,
    });
  } catch (error) {
    console.error('POST /api/internal/inbox-messages failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}

interface EmbedInboundParams {
  message_id: string;
  thread_id: string | null;
  sender: string;
  recipient: string;
  subject: string | null;
  body: string;
  sent_at: string;
}

async function embedAndUpsertInbound(params: EmbedInboundParams): Promise<void> {
  try {
    const excerpt = buildBodyExcerpt(params.body);
    const input = buildEmbeddingInput(params.subject, excerpt);
    if (!input.trim()) return;
    const vector = await embedText(input);
    if (!vector) return;
    await upsertEmailPoint(vector, {
      message_id: params.message_id,
      thread_id: params.thread_id,
      sender: params.sender,
      recipient: params.recipient,
      subject: params.subject,
      body_excerpt: excerpt,
      sent_at: params.sent_at,
      direction: 'inbound',
      classification_category: null,
    });
  } catch (err) {
    console.error('[rag] inbound embed/upsert failed (non-fatal):', err);
  }
}
