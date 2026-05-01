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
});
