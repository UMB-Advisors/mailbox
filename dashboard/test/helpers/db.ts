import { Pool } from 'pg';
import type { Category } from '@/lib/classification/prompt';
import type { DraftStatus } from '@/lib/types';

// Test helpers for route tests that need a real Postgres. The route handlers
// call `getPool()` from `lib/db.ts`, which reads `POSTGRES_URL`. To make sure
// the route + the seeding helpers see the same DB, mirror TEST_POSTGRES_URL
// onto POSTGRES_URL early — before any module that captures pool state.
if (process.env.TEST_POSTGRES_URL && !process.env.POSTGRES_URL) {
  process.env.POSTGRES_URL = process.env.TEST_POSTGRES_URL;
}

const DB_URL = process.env.TEST_POSTGRES_URL ?? process.env.POSTGRES_URL;
export const HAS_DB = Boolean(DB_URL);

let pool: Pool | undefined;
export function getTestPool(): Pool {
  if (!HAS_DB) throw new Error('TEST_POSTGRES_URL/POSTGRES_URL not set');
  if (!pool) pool = new Pool({ connectionString: DB_URL, max: 2 });
  return pool;
}

export async function closeTestPool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

export interface SeededDraft {
  draftId: number;
  inboxMessageId: number;
}

let seedCounter = 0;

export interface SeedOpts {
  status?: DraftStatus;
  classification?: Category;
  draftBody?: string;
  draftSubject?: string;
  withClassification?: boolean;
}

export async function seedDraft(opts: SeedOpts = {}): Promise<SeededDraft> {
  const status = opts.status ?? 'pending';
  const classification = opts.classification ?? 'reorder';
  const draftBody = opts.draftBody ?? 'Hi! Thanks for the order — confirming details.';
  const draftSubject = opts.draftSubject ?? 'Re: order confirmation';
  const withClassification = opts.withClassification !== false;
  const tag = `test-${Date.now()}-${++seedCounter}-${Math.random().toString(36).slice(2, 8)}`;

  const pool = getTestPool();

  const inbox = await pool.query<{ id: number }>(
    `INSERT INTO mailbox.inbox_messages
       (message_id, from_addr, to_addr, subject, body, received_at)
     VALUES ($1, 'sender@example.com', 'op@example.com', $2, 'inbound test body', NOW())
     RETURNING id`,
    [tag, `test inbound ${tag}`],
  );
  const inboxMessageId = inbox.rows[0].id;

  const draft = await pool.query<{ id: number }>(
    `INSERT INTO mailbox.drafts
       (inbox_message_id, draft_body, draft_subject, model, status,
        classification_category, classification_confidence,
        from_addr, to_addr, subject, body_text)
     VALUES ($1, $2, $3, 'qwen3:4b-ctx4k', $4, $5, $6,
             'sender@example.com', 'op@example.com',
             $7, 'inbound test body')
     RETURNING id`,
    [
      inboxMessageId,
      draftBody,
      draftSubject,
      status,
      withClassification ? classification : null,
      withClassification ? 0.92 : null,
      `test inbound ${tag}`,
    ],
  );
  return { draftId: draft.rows[0].id, inboxMessageId };
}

export async function deleteSeededDraft(s: SeededDraft): Promise<void> {
  const pool = getTestPool();
  await pool.query('DELETE FROM mailbox.drafts WHERE id = $1', [s.draftId]);
  await pool.query('DELETE FROM mailbox.inbox_messages WHERE id = $1', [s.inboxMessageId]);
}

export async function getDraftStatus(id: number): Promise<DraftStatus | null> {
  const pool = getTestPool();
  const r = await pool.query<{ status: DraftStatus }>(
    'SELECT status FROM mailbox.drafts WHERE id = $1',
    [id],
  );
  return r.rows[0]?.status ?? null;
}

export async function getDraftRow(id: number): Promise<{
  status: DraftStatus;
  draft_body: string;
  draft_subject: string | null;
  error_message: string | null;
} | null> {
  const pool = getTestPool();
  const r = await pool.query(
    'SELECT status, draft_body, draft_subject, error_message FROM mailbox.drafts WHERE id = $1',
    [id],
  );
  return r.rows[0] ?? null;
}

// Build a minimal NextRequest stand-in that satisfies the call sites in our
// route handlers (they only touch .url and .json()).
export function fakeRequest(
  opts: { url?: string; body?: unknown } = {},
): import('next/server').NextRequest {
  const url = opts.url ?? 'http://test.local/api';
  return {
    url,
    json: async () => {
      if (opts.body === undefined) throw new Error('no body');
      return opts.body;
    },
  } as unknown as import('next/server').NextRequest;
}
