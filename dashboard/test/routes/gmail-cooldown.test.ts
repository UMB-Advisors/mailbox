// MBOX-107 — coverage for the force-resume escape hatch on the
// system-wide Gmail rate-limit cooldown.
//
// Scope: only the NEW surface (clearGmailCooldown + the DELETE handler).
// Existing read-side coverage (getGmailCooldown, setGmailCooldown, the
// gmail-ratelimit-sweeper) lives under STAQPRO-227/231 and is not
// re-asserted here.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { clearGmailCooldown, setGmailCooldown } from '@/lib/queries-system-state';
import { closeTestPool, getTestPool, HAS_DB } from '../helpers/db';

const dbDescribe = HAS_DB ? describe : describe.skip;

dbDescribe('Gmail cooldown force-resume — real Postgres', () => {
  afterAll(async () => {
    await closeTestPool();
  });

  beforeEach(async () => {
    // Reset singleton to no-cooldown baseline for each test. Migration 018
    // guarantees the row exists; we just null the cooldown columns.
    const pool = getTestPool();
    await pool.query(`
      UPDATE mailbox.system_state
         SET gmail_rate_limit_until = NULL,
             gmail_rate_limit_set_at = NULL
       WHERE id = 1
    `);
  });

  describe('clearGmailCooldown helper', () => {
    it('clears an active cooldown and returns the previous deadline', async () => {
      const future = new Date(Date.now() + 30 * 60 * 1000); // +30 min
      await setGmailCooldown(future);

      const result = await clearGmailCooldown();
      expect(result.cleared).toBe(true);
      expect(result.previous_until).toBeInstanceOf(Date);
      // Cooldown timestamps round-trip via Postgres TIMESTAMPTZ — compare
      // by ISO string to avoid millisecond drift on the wire.
      expect(result.previous_until?.toISOString()).toBe(future.toISOString());

      // Verify the row was actually nulled.
      const pool = getTestPool();
      const { rows } = await pool.query<{
        gmail_rate_limit_until: string | null;
        gmail_rate_limit_set_at: string | null;
      }>(`
        SELECT gmail_rate_limit_until, gmail_rate_limit_set_at
          FROM mailbox.system_state
         WHERE id = 1
      `);
      expect(rows[0].gmail_rate_limit_until).toBeNull();
      expect(rows[0].gmail_rate_limit_set_at).toBeNull();
    });

    it('is idempotent — clearing an already-cleared cooldown is a no-op success', async () => {
      // No setGmailCooldown call — baseline is already nulled by beforeEach.
      const result = await clearGmailCooldown();
      expect(result.cleared).toBe(false);
      expect(result.previous_until).toBeNull();
    });
  });

  describe('DELETE /api/system/gmail-cooldown', () => {
    it('clears an active cooldown and returns previous_until', async () => {
      const future = new Date(Date.now() + 30 * 60 * 1000);
      await setGmailCooldown(future);

      const { DELETE } = await import('@/app/api/system/gmail-cooldown/route');
      const res = await DELETE();
      expect(res.status).toBe(200);
      const body = (await res.json()) as { cleared: boolean; previous_until: string | null };
      expect(body.cleared).toBe(true);
      expect(body.previous_until).toBe(future.toISOString());

      // GET should now report inactive — round-trip through the operator-
      // facing read so we also assert the route layer agrees the gate is
      // open.
      const { GET } = await import('@/app/api/system/gmail-cooldown/route');
      const getRes = await GET();
      const getBody = (await getRes.json()) as { is_active: boolean; until: string | null };
      expect(getBody.is_active).toBe(false);
      expect(getBody.until).toBeNull();
    });

    it('returns 200 with cleared:false when no cooldown was active', async () => {
      const { DELETE } = await import('@/app/api/system/gmail-cooldown/route');
      const res = await DELETE();
      expect(res.status).toBe(200);
      const body = (await res.json()) as { cleared: boolean; previous_until: string | null };
      expect(body.cleared).toBe(false);
      expect(body.previous_until).toBeNull();
    });
  });
});
