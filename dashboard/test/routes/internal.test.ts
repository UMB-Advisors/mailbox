import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, deleteSeededDraft, fakeRequest, HAS_DB, seedDraft } from '../helpers/db';

const dbDescribe = HAS_DB ? describe : describe.skip;

// STAQPRO-191 — fetch mock used by the rag.* cases below. Stubs both the
// Ollama embed endpoint and the Qdrant search endpoint. Mirrors the helper
// in test/lib/rag-retrieve.test.ts; intentionally duplicated rather than
// shared because route tests need to flex the same mock surface from a
// different file.
function mockRagFetch(opts: {
  embedding?: number[] | null;
  searchStatus?: number;
  hits?: Array<{ id: string; score: number; payload: Record<string, unknown> }>;
}) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/embeddings')) {
      if (opts.embedding === null) return new Response('boom', { status: 500 });
      const e = opts.embedding ?? new Array(768).fill(0.01);
      return new Response(JSON.stringify({ embedding: e }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('/collections/email_messages/points/search')) {
      const status = opts.searchStatus ?? 200;
      if (status !== 200) return new Response('boom', { status });
      return new Response(JSON.stringify({ result: opts.hits ?? [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

dbDescribe('internal route handlers — real Postgres', () => {
  afterAll(async () => {
    await closeTestPool();
  });

  describe('POST /api/internal/draft-finalize', () => {
    it('returns 404 for nonexistent draft_id', async () => {
      const { POST } = await import('@/app/api/internal/draft-finalize/route');
      const res = await POST(
        fakeRequest({
          body: {
            draft_id: 999_999_999,
            body: 'finalized body',
            source: 'local',
            model: 'qwen3:4b-ctx4k',
            input_tokens: 10,
            output_tokens: 20,
          },
        }),
      );
      expect(res.status).toBe(404);
    });

    it('rejects unknown source with 400 (validation)', async () => {
      const { POST } = await import('@/app/api/internal/draft-finalize/route');
      const res = await POST(
        fakeRequest({
          body: {
            draft_id: 1,
            body: 'x',
            source: 'magic',
            model: 'm',
          },
        }),
      );
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe('validation_failed');
    });
  });

  describe('POST /api/internal/draft-prompt', () => {
    it('returns 422 when classification_category is null', async () => {
      const seed = await seedDraft({ withClassification: false });
      try {
        const { POST } = await import('@/app/api/internal/draft-prompt/route');
        const res = await POST(fakeRequest({ body: { draft_id: seed.draftId } }));
        expect(res.status).toBe(422);
      } finally {
        await deleteSeededDraft(seed);
      }
    });

    it('returns 404 for nonexistent draft_id', async () => {
      const { POST } = await import('@/app/api/internal/draft-prompt/route');
      const res = await POST(fakeRequest({ body: { draft_id: 999_999_999 } }));
      expect(res.status).toBe(404);
    });

    // STAQPRO-191 — RAG retrieval + writeback contract (Linus pre-flight #5
    // eval acceptance test). Two cases: happy path verifies refs flow into
    // the prompt + are persisted as UUIDs with reason='ok'; degraded path
    // verifies an Ollama outage doesn't gate the draft and the audit chain
    // captures 'embed_unavailable' so STAQPRO-192's eval delta can exclude
    // those rows from the comparison.
    describe('rag retrieval + writeback', () => {
      const originalFetch = globalThis.fetch;
      beforeEach(() => {
        process.env.OLLAMA_BASE_URL = 'http://test-ollama:11434';
        process.env.QDRANT_URL = 'http://test-qdrant:6333';
      });
      afterEach(() => {
        globalThis.fetch = originalFetch;
        vi.restoreAllMocks();
      });

      it('happy path: writes rag_context_refs UUIDs + reason=ok and surfaces rag.refs_count', async () => {
        const seed = await seedDraft();
        try {
          mockRagFetch({
            hits: [
              {
                id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                score: 0.9,
                payload: {
                  message_id: 'm-1',
                  sender: 'sender@example.com',
                  subject: 'prior thread',
                  body_excerpt: 'we agreed to ship on the 15th',
                  sent_at: '2026-04-20T10:00:00Z',
                  direction: 'outbound',
                  persona_key: 'default',
                },
              },
            ],
          });

          const { POST } = await import('@/app/api/internal/draft-prompt/route');
          const res = await POST(fakeRequest({ body: { draft_id: seed.draftId } }));
          expect(res.status).toBe(200);
          const json = await res.json();
          expect(json.rag).toEqual({ refs_count: 1, reason: 'ok' });

          const { getPool } = await import('@/lib/db');
          const r = await getPool().query<{
            rag_context_refs: unknown;
            rag_retrieval_reason: string;
          }>(
            'SELECT rag_context_refs, rag_retrieval_reason FROM mailbox.drafts WHERE id = $1',
            [seed.draftId],
          );
          expect(r.rows[0].rag_retrieval_reason).toBe('ok');
          expect(r.rows[0].rag_context_refs).toEqual(['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']);
        } finally {
          await deleteSeededDraft(seed);
        }
      });

      it('degraded path: embed outage → empty refs + reason=embed_unavailable, draft still ships', async () => {
        const seed = await seedDraft();
        try {
          mockRagFetch({ embedding: null });

          const { POST } = await import('@/app/api/internal/draft-prompt/route');
          const res = await POST(fakeRequest({ body: { draft_id: seed.draftId } }));
          expect(res.status).toBe(200);
          const json = await res.json();
          // Drafting still proceeds — RAG is augmentation, not gate.
          expect(Array.isArray(json.messages)).toBe(true);
          expect(json.rag).toEqual({ refs_count: 0, reason: 'embed_unavailable' });

          const { getPool } = await import('@/lib/db');
          const r = await getPool().query<{
            rag_context_refs: unknown;
            rag_retrieval_reason: string;
          }>(
            'SELECT rag_context_refs, rag_retrieval_reason FROM mailbox.drafts WHERE id = $1',
            [seed.draftId],
          );
          expect(r.rows[0].rag_retrieval_reason).toBe('embed_unavailable');
          expect(r.rows[0].rag_context_refs).toEqual([]);
        } finally {
          await deleteSeededDraft(seed);
        }
      });
    });
  });

  describe('POST /api/internal/inbox-messages', () => {
    it('inserts a new row and returns {id, message_id, created: true}', async () => {
      const messageId = `staqpro135-${Date.now()}-new`;
      try {
        const { POST } = await import('@/app/api/internal/inbox-messages/route');
        const res = await POST(
          fakeRequest({
            body: {
              message_id: messageId,
              thread_id: 't-1',
              from_addr: 'a@b.com',
              to_addr: 'c@d.com',
              subject: 's',
              snippet: 'sn',
              body: 'b',
            },
          }),
        );
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.message_id).toBe(messageId);
        expect(json.created).toBe(true);
        expect(typeof json.id).toBe('number');
      } finally {
        const { getPool } = await import('@/lib/db');
        await getPool().query('DELETE FROM mailbox.inbox_messages WHERE message_id = $1', [
          messageId,
        ]);
      }
    });

    it('returns existing id with created: false on duplicate message_id', async () => {
      const messageId = `staqpro135-${Date.now()}-dupe`;
      try {
        const { POST } = await import('@/app/api/internal/inbox-messages/route');
        const first = await POST(fakeRequest({ body: { message_id: messageId } }));
        const firstJson = await first.json();
        expect(firstJson.created).toBe(true);

        const second = await POST(fakeRequest({ body: { message_id: messageId } }));
        const secondJson = await second.json();
        expect(second.status).toBe(200);
        expect(secondJson.id).toBe(firstJson.id);
        expect(secondJson.created).toBe(false);
      } finally {
        const { getPool } = await import('@/lib/db');
        await getPool().query('DELETE FROM mailbox.inbox_messages WHERE message_id = $1', [
          messageId,
        ]);
      }
    });

    it('rejects missing message_id with 400 (validation)', async () => {
      const { POST } = await import('@/app/api/internal/inbox-messages/route');
      const res = await POST(fakeRequest({ body: { from_addr: 'a@b.com' } }));
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe('validation_failed');
    });
  });
});
