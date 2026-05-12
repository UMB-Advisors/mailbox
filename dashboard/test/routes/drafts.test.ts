import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  closeTestPool,
  deleteSeededDraft,
  fakeRequest,
  getDraftRow,
  getLatestTransition,
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
    // STAQPRO-331 #1 — reject route now writes mailbox.draft_feedback with
    // structured reason_code + optional free_text. error_message is NO LONGER
    // written here (it's send-side per CLAUDE.md state machine).
    it('flips pending → rejected and inserts draft_feedback row', async () => {
      const seed = await seedDraft({ status: 'pending' });
      try {
        const { POST } = await import('@/app/api/drafts/[id]/reject/route');
        const res = await POST(
          fakeRequest({
            body: { reason_code: 'wrong_tone', free_text: '  too formal  ' },
          }),
          { params: { id: String(seed.draftId) } },
        );
        expect(res.status).toBe(200);
        const row = await getDraftRow(seed.draftId);
        expect(row?.status).toBe('rejected');
        // error_message is reserved for send-side failures now (Gmail Reply
        // 429 etc) — reject must not touch it.
        expect(row?.error_message).toBeNull();

        // Feedback row written in the same transaction.
        const { getKysely } = await import('@/lib/db');
        const fb = await getKysely()
          .selectFrom('draft_feedback')
          .selectAll()
          .where('draft_id', '=', seed.draftId)
          .execute();
        expect(fb).toHaveLength(1);
        expect(fb[0].reason_code).toBe('wrong_tone');
        expect(fb[0].free_text).toBe('too formal');
      } finally {
        await deleteSeededDraft(seed);
      }
    });

    it("requires free_text when reason_code is 'other'", async () => {
      const seed = await seedDraft({ status: 'pending' });
      try {
        const { POST } = await import('@/app/api/drafts/[id]/reject/route');
        const res = await POST(fakeRequest({ body: { reason_code: 'other' } }), {
          params: { id: String(seed.draftId) },
        });
        expect(res.status).toBe(400);
        const row = await getDraftRow(seed.draftId);
        expect(row?.status).toBe('pending');
      } finally {
        await deleteSeededDraft(seed);
      }
    });

    it('rejects body without reason_code with 400', async () => {
      const seed = await seedDraft({ status: 'pending' });
      try {
        const { POST } = await import('@/app/api/drafts/[id]/reject/route');
        const res = await POST(fakeRequest({ body: {} }), {
          params: { id: String(seed.draftId) },
        });
        expect(res.status).toBe(400);
      } finally {
        await deleteSeededDraft(seed);
      }
    });

    it('returns 409 for already-approved drafts', async () => {
      const seed = await seedDraft({ status: 'approved' });
      try {
        const { POST } = await import('@/app/api/drafts/[id]/reject/route');
        const res = await POST(fakeRequest({ body: { reason_code: 'wrong_tone' } }), {
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

  describe('POST /api/drafts/[id]/undo-reject', () => {
    // STAQPRO-331 #9 — operator-initiated undo of a fresh reject. Flips
    // rejected → pending and removes the latest draft_feedback row in one
    // transaction; writes a state_transitions audit row via session GUCs.

    it('flips rejected → pending and removes the latest draft_feedback row', async () => {
      const seed = await seedDraft({ status: 'pending' });
      try {
        // First reject so we have a row in draft_feedback to remove.
        const { POST: rejectPOST } = await import('@/app/api/drafts/[id]/reject/route');
        const rejectRes = await rejectPOST(fakeRequest({ body: { reason_code: 'wrong_tone' } }), {
          params: { id: String(seed.draftId) },
        });
        expect(rejectRes.status).toBe(200);
        const afterReject = await getDraftRow(seed.draftId);
        expect(afterReject?.status).toBe('rejected');

        const { getKysely } = await import('@/lib/db');
        const fbBefore = await getKysely()
          .selectFrom('draft_feedback')
          .selectAll()
          .where('draft_id', '=', seed.draftId)
          .execute();
        expect(fbBefore).toHaveLength(1);

        const { POST: undoPOST } = await import('@/app/api/drafts/[id]/undo-reject/route');
        const undoRes = await undoPOST(fakeRequest({ body: {} }), {
          params: { id: String(seed.draftId) },
        });
        expect(undoRes.status).toBe(200);
        const afterUndo = await getDraftRow(seed.draftId);
        expect(afterUndo?.status).toBe('pending');

        const fbAfter = await getKysely()
          .selectFrom('draft_feedback')
          .selectAll()
          .where('draft_id', '=', seed.draftId)
          .execute();
        expect(fbAfter).toHaveLength(0);
      } finally {
        await deleteSeededDraft(seed);
      }
    });

    it('returns 409 when draft is not in rejected state', async () => {
      const seed = await seedDraft({ status: 'pending' });
      try {
        const { POST } = await import('@/app/api/drafts/[id]/undo-reject/route');
        const res = await POST(fakeRequest({ body: {} }), {
          params: { id: String(seed.draftId) },
        });
        expect(res.status).toBe(409);
        const row = await getDraftRow(seed.draftId);
        expect(row?.status).toBe('pending'); // unchanged

        // No draft_feedback rows existed; ensure none were created/touched.
        const { getKysely } = await import('@/lib/db');
        const fb = await getKysely()
          .selectFrom('draft_feedback')
          .selectAll()
          .where('draft_id', '=', seed.draftId)
          .execute();
        expect(fb).toHaveLength(0);
      } finally {
        await deleteSeededDraft(seed);
      }
    });

    it("writes a state_transitions row with actor='operator' reason='undo_reject'", async () => {
      const seed = await seedDraft({ status: 'pending' });
      try {
        const { POST: rejectPOST } = await import('@/app/api/drafts/[id]/reject/route');
        await rejectPOST(fakeRequest({ body: { reason_code: 'wrong_tone' } }), {
          params: { id: String(seed.draftId) },
        });
        const { POST: undoPOST } = await import('@/app/api/drafts/[id]/undo-reject/route');
        const res = await undoPOST(fakeRequest({ body: {} }), {
          params: { id: String(seed.draftId) },
        });
        expect(res.status).toBe(200);

        const latest = await getLatestTransition(seed.draftId);
        expect(latest).not.toBeNull();
        expect(latest?.from_status).toBe('rejected');
        expect(latest?.to_status).toBe('pending');
        expect(latest?.actor).toBe('operator');
        expect(latest?.reason).toBe('undo_reject');
      } finally {
        await deleteSeededDraft(seed);
      }
    });

    it('is idempotent — second undo returns 409 without further mutation', async () => {
      const seed = await seedDraft({ status: 'pending' });
      try {
        const { POST: rejectPOST } = await import('@/app/api/drafts/[id]/reject/route');
        await rejectPOST(fakeRequest({ body: { reason_code: 'wrong_tone' } }), {
          params: { id: String(seed.draftId) },
        });
        const { POST: undoPOST } = await import('@/app/api/drafts/[id]/undo-reject/route');
        const first = await undoPOST(fakeRequest({ body: {} }), {
          params: { id: String(seed.draftId) },
        });
        expect(first.status).toBe(200);
        const second = await undoPOST(fakeRequest({ body: {} }), {
          params: { id: String(seed.draftId) },
        });
        expect(second.status).toBe(409);

        // Confirm draft is still 'pending' (first undo's terminal state) and
        // no additional draft_feedback rows were created/removed.
        const row = await getDraftRow(seed.draftId);
        expect(row?.status).toBe('pending');
        const { getKysely } = await import('@/lib/db');
        const fb = await getKysely()
          .selectFrom('draft_feedback')
          .selectAll()
          .where('draft_id', '=', seed.draftId)
          .execute();
        expect(fb).toHaveLength(0);
      } finally {
        await deleteSeededDraft(seed);
      }
    });
  });
});
