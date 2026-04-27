import { getPool, normalizeDraftBody } from '@/lib/db';
import type { DraftWithMessage, DraftStatus } from '@/lib/types';

const LIST_DRAFTS_SQL = `
  SELECT
    d.*,
    json_build_object(
      'id', m.id,
      'message_id', m.message_id,
      'thread_id', m.thread_id,
      'from_addr', m.from_addr,
      'to_addr', m.to_addr,
      'subject', m.subject,
      'received_at', m.received_at,
      'snippet', m.snippet,
      'body', m.body,
      'classification', m.classification,
      'confidence', m.confidence,
      'classified_at', m.classified_at,
      'model', m.model,
      'created_at', m.created_at,
      'draft_id', m.draft_id
    ) AS message
  FROM mailbox.drafts d
  JOIN mailbox.inbox_messages m ON d.inbox_message_id = m.id
  WHERE d.status = ANY($1::text[])
  ORDER BY d.created_at DESC
  LIMIT $2
`;

const GET_DRAFT_SQL = `
  SELECT
    d.*,
    json_build_object(
      'id', m.id,
      'message_id', m.message_id,
      'thread_id', m.thread_id,
      'from_addr', m.from_addr,
      'to_addr', m.to_addr,
      'subject', m.subject,
      'received_at', m.received_at,
      'snippet', m.snippet,
      'body', m.body,
      'classification', m.classification,
      'confidence', m.confidence,
      'classified_at', m.classified_at,
      'model', m.model,
      'created_at', m.created_at,
      'draft_id', m.draft_id
    ) AS message
  FROM mailbox.drafts d
  JOIN mailbox.inbox_messages m ON d.inbox_message_id = m.id
  WHERE d.id = $1
`;

export const VALID_STATUSES: ReadonlyArray<DraftStatus> = [
  'pending',
  'approved',
  'rejected',
  'edited',
  'sent',
  'failed',
];

export async function listDrafts(
  statuses: DraftStatus[] = ['pending'],
  limit = 50,
): Promise<DraftWithMessage[]> {
  const pool = getPool();
  const safeLimit = Math.min(Math.max(Math.trunc(limit) || 50, 1), 200);
  const result = await pool.query<DraftWithMessage>(LIST_DRAFTS_SQL, [
    statuses,
    safeLimit,
  ]);
  return result.rows.map((row) => ({
    ...row,
    draft_body: normalizeDraftBody(row.draft_body),
  }));
}

export async function getDraft(id: number): Promise<DraftWithMessage | null> {
  const pool = getPool();
  const result = await pool.query<DraftWithMessage>(GET_DRAFT_SQL, [id]);
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return { ...row, draft_body: normalizeDraftBody(row.draft_body) };
}
