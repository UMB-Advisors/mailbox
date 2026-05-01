import { sql } from 'kysely';
import { type NextRequest, NextResponse } from 'next/server';
import { getKysely } from '@/lib/db';
import { parseJson } from '@/lib/middleware/validate';
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
