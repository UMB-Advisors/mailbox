import { jsonBuildObject } from 'kysely/helpers/postgres';
import { getKysely, normalizeDraftBody } from '@/lib/db';
import type { DraftStatus, DraftWithMessage } from '@/lib/types';

// Re-exported for callers that previously imported VALID_STATUSES from here.
// STAQPRO-137 moved the canonical const to lib/types.ts so all consumers
// (queries, schemas, future migrations) read from one place.
export { DRAFT_STATUSES as VALID_STATUSES } from '@/lib/types';

// Both helpers select all draft columns plus an inline {message: InboxMessage}
// JSON object built from the joined inbox_messages row. kysely's
// jsonBuildObject helper compiles to the same Postgres json_build_object()
// call the original SQL used.

export async function listDrafts(
  statuses: DraftStatus[] = ['pending'],
  limit = 50,
): Promise<DraftWithMessage[]> {
  const db = getKysely();
  const safeLimit = Math.min(Math.max(Math.trunc(limit) || 50, 1), 200);
  const rows = await db
    .selectFrom('drafts as d')
    .innerJoin('inbox_messages as m', 'd.inbox_message_id', 'm.id')
    .where('d.status', 'in', statuses)
    .selectAll('d')
    .select((eb) =>
      jsonBuildObject({
        id: eb.ref('m.id'),
        message_id: eb.ref('m.message_id'),
        thread_id: eb.ref('m.thread_id'),
        from_addr: eb.ref('m.from_addr'),
        to_addr: eb.ref('m.to_addr'),
        subject: eb.ref('m.subject'),
        received_at: eb.ref('m.received_at'),
        snippet: eb.ref('m.snippet'),
        body: eb.ref('m.body'),
        classification: eb.ref('m.classification'),
        confidence: eb.ref('m.confidence'),
        classified_at: eb.ref('m.classified_at'),
        model: eb.ref('m.model'),
        created_at: eb.ref('m.created_at'),
        draft_id: eb.ref('m.draft_id'),
      }).as('message'),
    )
    .orderBy('d.created_at', 'desc')
    .limit(safeLimit)
    .execute();
  return rows.map((row) => {
    const r = row as unknown as DraftWithMessage;
    return { ...r, draft_body: normalizeDraftBody(r.draft_body) };
  });
}

export async function getDraft(id: number): Promise<DraftWithMessage | null> {
  const db = getKysely();
  const row = await db
    .selectFrom('drafts as d')
    .innerJoin('inbox_messages as m', 'd.inbox_message_id', 'm.id')
    .where('d.id', '=', id)
    .selectAll('d')
    .select((eb) =>
      jsonBuildObject({
        id: eb.ref('m.id'),
        message_id: eb.ref('m.message_id'),
        thread_id: eb.ref('m.thread_id'),
        from_addr: eb.ref('m.from_addr'),
        to_addr: eb.ref('m.to_addr'),
        subject: eb.ref('m.subject'),
        received_at: eb.ref('m.received_at'),
        snippet: eb.ref('m.snippet'),
        body: eb.ref('m.body'),
        classification: eb.ref('m.classification'),
        confidence: eb.ref('m.confidence'),
        classified_at: eb.ref('m.classified_at'),
        model: eb.ref('m.model'),
        created_at: eb.ref('m.created_at'),
        draft_id: eb.ref('m.draft_id'),
      }).as('message'),
    )
    .executeTakeFirst();
  if (!row) return null;
  const r = row as unknown as DraftWithMessage;
  return { ...r, draft_body: normalizeDraftBody(r.draft_body) };
}
