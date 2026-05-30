import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CanonicalMessage } from '@/lib/mail/providers/types';
import { encryptToken } from '@/lib/oauth/google';
import { runImapVoiceBackfill, VoiceBackfillError } from '@/lib/voice/imap-backfill';
import { closeTestPool, getTestPool, HAS_DB } from '../helpers/db';

// MBOX-373 (MBOX-162 V6 P2) — IMAP voice-backfill orchestrator. DB-backed but
// the IMAP I/O is INJECTED (deps.fetchSent), so no imapflow/network needed — the
// ingest + dedup + cred/guard paths are fully exercised. Skips without
// TEST_POSTGRES_URL.

const dbDescribe = HAS_DB ? describe : describe.skip;
const TEST_KEY = '0'.repeat(64); // 32 bytes hex for MAILBOX_OAUTH_TOKEN_KEY
const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function canonical(id: string, body: string): CanonicalMessage {
  return {
    provider_message_id: id,
    thread_id: null,
    from_addr: `imap-${stamp}@example.test`,
    to_addr: 'customer@example.com',
    subject: 'Re: hello',
    body,
    in_reply_to: null,
    references: null,
    received_at: '2026-05-01T09:00:00.000Z',
    direction: 'outbound',
  };
}

// A fake fetch yielding 3 messages where #3 duplicates #1's message_id.
async function* fakeFetch(): AsyncIterable<CanonicalMessage> {
  yield canonical(`m1-${stamp}`, 'Hi — happy to help. Best, Dustin');
  yield canonical(`m2-${stamp}`, 'Thanks for the order! Cheers, Dustin');
  yield canonical(`m1-${stamp}`, 'Hi — happy to help. Best, Dustin'); // dup message_id
}

dbDescribe('runImapVoiceBackfill — real Postgres (injected fetch)', () => {
  const savedKey = process.env.MAILBOX_OAUTH_TOKEN_KEY;

  beforeAll(() => {
    process.env.MAILBOX_OAUTH_TOKEN_KEY = TEST_KEY;
  });
  afterAll(async () => {
    if (savedKey === undefined) delete process.env.MAILBOX_OAUTH_TOKEN_KEY;
    else process.env.MAILBOX_OAUTH_TOKEN_KEY = savedKey;
    await closeTestPool();
  });

  async function mkImapAccount(withSecret: boolean): Promise<number> {
    const pool = getTestPool();
    const r = await pool.query<{ id: number }>(
      `INSERT INTO mailbox.accounts
         (email_address, is_default, provider, provider_config, provider_secret_enc)
       VALUES ($1, false, 'imap', $2::jsonb, $3) RETURNING id`,
      [
        `imap-${stamp}-${Math.random().toString(36).slice(2, 6)}@example.test`,
        JSON.stringify({
          imap_host: 'imap.example.test',
          imap_port: 993,
          username: 'u',
          tls: true,
        }),
        withSecret ? encryptToken('app-password') : null,
      ],
    );
    return r.rows[0].id;
  }

  it('archives fetched Sent mail into sent_history, deduped, tagged with account_id', async () => {
    const pool = getTestPool();
    const accountId = await mkImapAccount(true);
    try {
      const res = await runImapVoiceBackfill(accountId, { fetchSent: () => fakeFetch() });
      expect(res).toEqual({ account_id: accountId, fetched: 3, inserted: 2 }); // dup collapsed

      const rows = await pool.query<{ source: string; draft_sent: string; category: string }>(
        `SELECT source, draft_sent, classification_category AS category
           FROM mailbox.sent_history WHERE account_id = $1 ORDER BY message_id`,
        [accountId],
      );
      expect(rows.rows).toHaveLength(2);
      expect(rows.rows.every((r) => r.source === 'backfill')).toBe(true);
      expect(rows.rows.every((r) => r.category === 'unknown')).toBe(true);
      expect(rows.rows[0].draft_sent).toContain('happy to help');

      // Idempotent: a second run inserts nothing new.
      const again = await runImapVoiceBackfill(accountId, { fetchSent: () => fakeFetch() });
      expect(again.inserted).toBe(0);
    } finally {
      await pool.query('DELETE FROM mailbox.sent_history WHERE account_id = $1', [accountId]);
      await pool.query('DELETE FROM mailbox.accounts WHERE id = $1', [accountId]);
    }
  });

  it('throws not_imap for a non-IMAP account (before any fetch)', async () => {
    const pool = getTestPool();
    const r = await pool.query<{ id: number }>(
      `INSERT INTO mailbox.accounts (email_address, is_default, provider)
       VALUES ($1, false, 'gmail') RETURNING id`,
      [`gmail-${stamp}@example.test`],
    );
    const id = r.rows[0].id;
    try {
      await expect(runImapVoiceBackfill(id)).rejects.toMatchObject({
        name: 'VoiceBackfillError',
        code: 'not_imap',
      });
    } finally {
      await pool.query('DELETE FROM mailbox.accounts WHERE id = $1', [id]);
    }
  });

  it('throws no_credential for an IMAP account with no stored secret', async () => {
    const pool = getTestPool();
    const id = await mkImapAccount(false);
    try {
      await expect(runImapVoiceBackfill(id)).rejects.toMatchObject({
        name: 'VoiceBackfillError',
        code: 'no_credential',
      });
    } finally {
      await pool.query('DELETE FROM mailbox.accounts WHERE id = $1', [id]);
    }
  });

  it('throws not_found for an unknown account id', async () => {
    await expect(runImapVoiceBackfill(2_000_000_002)).rejects.toMatchObject({
      name: 'VoiceBackfillError',
      code: 'not_found',
    });
  });

  it('guard: VoiceBackfillError is exported', () => {
    expect(typeof VoiceBackfillError).toBe('function');
  });
});
