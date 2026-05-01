import { afterAll, describe, expect, it } from 'vitest';
import { closeTestPool, deleteSeededDraft, fakeRequest, HAS_DB, seedDraft } from '../helpers/db';

const dbDescribe = HAS_DB ? describe : describe.skip;

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
