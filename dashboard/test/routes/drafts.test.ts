import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  closeTestPool,
  deleteSeededDraft,
  fakeRequest,
  getDraftRow,
  getTestPool,
  HAS_DB,
  seedDraft,
} from '../helpers/db';

// Real-DB tests for the drafts CRUD routes. State-machine transitions are the
// most failure-prone surface — these tests exercise the SQL guards (the
// `AND status IN (...)` clauses that produce 409 on wrong-state) plus the
// happy paths.
//
// Skip suite cleanly when no DB is available.
const dbDescribe = HAS_DB ? describe : describe.skip;

dbDescribe('drafts route handlers — real Postgres', () => {
  beforeAll(() => {
    // Stub fetch so approve/retry don't actually hit the n8n webhook.
    // Use mockImplementation so each call gets a *fresh* Response — Response
    // bodies are single-use, so a shared mockResolvedValue would 502 on the
    // second webhook caller.
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
        ),
    );
    // Webhook URL must be set or triggerSendWebhook short-circuits to 502.
    process.env.N8N_WEBHOOK_URL = 'http://stub.test/webhook';
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await closeTestPool();
  });

  describe('GET /api/drafts/[id]', () => {
    it('returns 404 for nonexistent draft', async () => {
      const { GET } = await import('@/app/api/drafts/[id]/route');
      const res = await GET(fakeRequest(), {
        params: { id: '999999999' },
      });
      expect(res.status).toBe(404);
    });

    it('returns 400 for non-numeric id', async () => {
      const { GET } = await import('@/app/api/drafts/[id]/route');
      const res = await GET(fakeRequest(), { params: { id: 'abc' } });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('validation_failed');
    });
  });

  describe('POST /api/drafts/[id]/approve', () => {
    it('flips pending → approved and fires webhook', async () => {
      const seed = await seedDraft({ status: 'pending' });
      try {
        const { POST } = await import('@/app/api/drafts/[id]/approve/route');
        const res = await POST(fakeRequest(), {
          params: { id: String(seed.draftId) },
        });
        expect(res.status).toBe(200);
        const row = await getDraftRow(seed.draftId);
        expect(row?.status).toBe('approved');
      } finally {
        await deleteSeededDraft(seed);
      }
    });

    it('returns 409 when draft is already sent', async () => {
      const seed = await seedDraft({ status: 'sent' });
      try {
        const { POST } = await import('@/app/api/drafts/[id]/approve/route');
        const res = await POST(fakeRequest(), {
          params: { id: String(seed.draftId) },
        });
        expect(res.status).toBe(409);
        const row = await getDraftRow(seed.draftId);
        expect(row?.status).toBe('sent'); // unchanged
      } finally {
        await deleteSeededDraft(seed);
      }
    });
  });

  describe('POST /api/drafts/[id]/reject', () => {
    it('flips pending → rejected and persists trimmed reason', async () => {
      const seed = await seedDraft({ status: 'pending' });
      try {
        const { POST } = await import('@/app/api/drafts/[id]/reject/route');
        const res = await POST(fakeRequest({ body: { reason: '  not on brand  ' } }), {
          params: { id: String(seed.draftId) },
        });
        expect(res.status).toBe(200);
        const row = await getDraftRow(seed.draftId);
        expect(row?.status).toBe('rejected');
        expect(row?.error_message).toBe('not on brand');
      } finally {
        await deleteSeededDraft(seed);
      }
    });

    it('returns 409 for already-approved drafts', async () => {
      const seed = await seedDraft({ status: 'approved' });
      try {
        const { POST } = await import('@/app/api/drafts/[id]/reject/route');
        const res = await POST(fakeRequest({ body: {} }), {
          params: { id: String(seed.draftId) },
        });
        expect(res.status).toBe(409);
      } finally {
        await deleteSeededDraft(seed);
      }
    });
  });

  describe('POST /api/drafts/[id]/edit', () => {
    it('updates body, transitions to edited', async () => {
      const seed = await seedDraft({ status: 'pending' });
      try {
        const { POST } = await import('@/app/api/drafts/[id]/edit/route');
        const res = await POST(
          fakeRequest({
            body: {
              draft_body: 'Hand-edited body for the test',
              draft_subject: 'Re: edited',
            },
          }),
          { params: { id: String(seed.draftId) } },
        );
        expect(res.status).toBe(200);
        const row = await getDraftRow(seed.draftId);
        expect(row?.status).toBe('edited');
        expect(row?.draft_body).toBe('Hand-edited body for the test');
        expect(row?.draft_subject).toBe('Re: edited');
      } finally {
        await deleteSeededDraft(seed);
      }
    });

    it('rejects empty draft_body with 400', async () => {
      const seed = await seedDraft({ status: 'pending' });
      try {
        const { POST } = await import('@/app/api/drafts/[id]/edit/route');
        const res = await POST(fakeRequest({ body: { draft_body: '   ' } }), {
          params: { id: String(seed.draftId) },
        });
        expect(res.status).toBe(400);
      } finally {
        await deleteSeededDraft(seed);
      }
    });

    it('returns 409 when draft is in a terminal state (rejected)', async () => {
      // STAQPRO-202 / migration 016 retired the 'failed' status; 'rejected'
      // is the canonical terminal state the edit guard must refuse.
      const seed = await seedDraft({ status: 'rejected' });
      try {
        const { POST } = await import('@/app/api/drafts/[id]/edit/route');
        const res = await POST(fakeRequest({ body: { draft_body: 'any body' } }), {
          params: { id: String(seed.draftId) },
        });
        expect(res.status).toBe(409);
      } finally {
        await deleteSeededDraft(seed);
      }
    });
  });

  describe('POST /api/drafts/[id]/retry', () => {
    it('re-fires webhook for stuck-at-approved draft and clears error', async () => {
      // STAQPRO-202 / migration 016 — retry now only advances rows stuck at
      // status='approved' (Gmail Reply errors leave them there; the
      // StuckApproved UI surfaces them for operator-driven re-send).
      const seed = await seedDraft({ status: 'approved' });
      try {
        const { POST } = await import('@/app/api/drafts/[id]/retry/route');
        const res = await POST(fakeRequest(), {
          params: { id: String(seed.draftId) },
        });
        expect(res.status).toBe(200);
        const row = await getDraftRow(seed.draftId);
        expect(row?.status).toBe('approved');
        expect(row?.error_message).toBeNull();
      } finally {
        await deleteSeededDraft(seed);
      }
    });

    it('returns 409 when draft is pending (retry only valid from approved)', async () => {
      const seed = await seedDraft({ status: 'pending' });
      try {
        const { POST } = await import('@/app/api/drafts/[id]/retry/route');
        const res = await POST(fakeRequest(), {
          params: { id: String(seed.draftId) },
        });
        expect(res.status).toBe(409);
      } finally {
        await deleteSeededDraft(seed);
      }
    });

    it('returns 429 gmail_rate_limit_active when system cooldown is set (STAQPRO-227 stretch)', async () => {
      const seed = await seedDraft({ status: 'approved' });
      const pool = getTestPool();
      // Set system cooldown 10 min in the future. Restored after.
      await pool.query(
        `UPDATE mailbox.system_state SET gmail_rate_limit_until = NOW() + interval '10 minutes', gmail_rate_limit_set_at = NOW() WHERE id = 1`,
      );
      try {
        const { POST } = await import('@/app/api/drafts/[id]/retry/route');
        const res = await POST(fakeRequest(), {
          params: { id: String(seed.draftId) },
        });
        expect(res.status).toBe(429);
        const body = (await res.json()) as { error: string; next_retry_at: string };
        expect(body.error).toBe('gmail_rate_limit_active');
        expect(typeof body.next_retry_at).toBe('string');
        expect(new Date(body.next_retry_at).getTime()).toBeGreaterThan(Date.now());
        // System cooldown gates ALL retries, regardless of per-draft last_retry_at
        // — confirm no n8n call was made (last_retry_at unchanged from seed=NULL)
        const r = await pool.query<{ last_retry_at: string | null }>(
          `SELECT last_retry_at FROM mailbox.drafts WHERE id = $1`,
          [seed.draftId],
        );
        expect(r.rows[0]?.last_retry_at).toBeNull();
      } finally {
        // Clear system cooldown so other tests aren't gated.
        await pool.query(
          `UPDATE mailbox.system_state SET gmail_rate_limit_until = NULL, gmail_rate_limit_set_at = NULL WHERE id = 1`,
        );
        await deleteSeededDraft(seed);
      }
    });

    it('returns 429 with next_retry_at when within 5-minute cooldown (STAQPRO-227)', async () => {
      const seed = await seedDraft({ status: 'approved' });
      try {
        // Stamp a recent retry to trigger the cooldown.
        const pool = getTestPool();
        await pool.query(
          `UPDATE mailbox.drafts SET last_retry_at = NOW() - interval '1 minute' WHERE id = $1`,
          [seed.draftId],
        );
        const { POST } = await import('@/app/api/drafts/[id]/retry/route');
        const res = await POST(fakeRequest(), {
          params: { id: String(seed.draftId) },
        });
        expect(res.status).toBe(429);
        const body = (await res.json()) as { error: string; next_retry_at: string };
        expect(body.error).toBe('retry_cooldown');
        expect(typeof body.next_retry_at).toBe('string');
        // next_retry_at should be in the future
        expect(new Date(body.next_retry_at).getTime()).toBeGreaterThan(Date.now());
      } finally {
        await deleteSeededDraft(seed);
      }
    });

    it('stamps last_retry_at on successful retry (STAQPRO-227)', async () => {
      const seed = await seedDraft({ status: 'approved' });
      try {
        const { POST } = await import('@/app/api/drafts/[id]/retry/route');
        const res = await POST(fakeRequest(), {
          params: { id: String(seed.draftId) },
        });
        expect(res.status).toBe(200);
        const pool = getTestPool();
        const r = await pool.query<{ last_retry_at: string | null }>(
          `SELECT last_retry_at FROM mailbox.drafts WHERE id = $1`,
          [seed.draftId],
        );
        expect(r.rows[0]?.last_retry_at).not.toBeNull();
      } finally {
        await deleteSeededDraft(seed);
      }
    });
  });

  describe('GET /api/drafts (list)', () => {
    it('filters by status', async () => {
      const seedA = await seedDraft({ status: 'pending' });
      const seedB = await seedDraft({ status: 'rejected' });
      try {
        const { GET } = await import('@/app/api/drafts/route');
        const res = await GET(
          fakeRequest({ url: 'http://test/api/drafts?status=rejected&limit=250' }),
        );
        expect(res.status).toBe(200);
        const json = (await res.json()) as { drafts: Array<{ id: number }> };
        const ids = json.drafts.map((d) => d.id);
        expect(ids).toContain(seedB.draftId);
        expect(ids).not.toContain(seedA.draftId);
      } finally {
        await deleteSeededDraft(seedA);
        await deleteSeededDraft(seedB);
      }
    });

    it('rejects unknown status with 400', async () => {
      const { GET } = await import('@/app/api/drafts/route');
      const res = await GET(fakeRequest({ url: 'http://test/api/drafts?status=bogus' }));
      expect(res.status).toBe(400);
    });
  });
});
