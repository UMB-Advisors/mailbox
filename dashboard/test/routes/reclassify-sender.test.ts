import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { getSenderOverride } from '@/lib/classification/sender-override';
import { closeTestPool, fakeRequest, getTestPool, HAS_DB } from '../helpers/db';

// MBOX-368 — real-Postgres integration tests for reclassify-by-sender.
//
// Exercises the whole "past + future" transaction against a live schema:
//   - relabel fan-out across MULTIPLE messages from the same sender, including
//     the "Name <addr>" header form (the bare-address SQL extraction is the
//     risky part);
//   - existing drafts relabelled;
//   - one classification_log audit row per message;
//   - the sticky rule upserted + read back by getSenderOverride (future path);
//   - idempotent re-reclassify (upsert, not duplicate).
//
// Skips cleanly when no DB is configured.
const dbDescribe = HAS_DB ? describe : describe.skip;

const SENDER = 'vendor-368@example.com';
const HEADER_FORM = `"Vendor Newsletter" <${SENDER}>`;

async function seedInbox(messageId: string, fromAddr: string): Promise<number> {
  const pool = getTestPool();
  const r = await pool.query<{ id: number }>(
    `INSERT INTO mailbox.inbox_messages
       (message_id, from_addr, to_addr, subject, body, received_at)
     VALUES ($1, $2, 'op@example.com', $3, 'body', NOW())
     RETURNING id`,
    [messageId, fromAddr, `subj ${messageId}`],
  );
  return r.rows[0].id;
}

async function cleanup(): Promise<void> {
  const pool = getTestPool();
  // classification_log + drafts FK-cascade off inbox_messages, but delete
  // explicitly to be safe across FK NO ACTION variants.
  await pool.query(
    `DELETE FROM mailbox.classification_log
      WHERE inbox_message_id IN
        (SELECT id FROM mailbox.inbox_messages WHERE message_id LIKE 'mbox368-%')`,
  );
  await pool.query(
    `DELETE FROM mailbox.drafts
      WHERE inbox_message_id IN
        (SELECT id FROM mailbox.inbox_messages WHERE message_id LIKE 'mbox368-%')`,
  );
  await pool.query("DELETE FROM mailbox.inbox_messages WHERE message_id LIKE 'mbox368-%'");
  await pool.query('DELETE FROM mailbox.sender_classification_overrides WHERE email = $1', [
    SENDER,
  ]);
}

dbDescribe('POST /api/classifications/reclassify-sender — real Postgres', () => {
  afterEach(cleanup);
  afterAll(closeTestPool);

  it('relabels all past mail from a sender (incl. "Name <addr>"), creates the sticky rule, and is read back by the classifier', async () => {
    const pool = getTestPool();
    // Two messages: one bare-address, one full-header form. Both must match.
    const m1 = await seedInbox('mbox368-1', SENDER);
    const m2 = await seedInbox('mbox368-2', HEADER_FORM);
    // A draft on m1 that was (wrongly) drafted as inquiry — should get relabelled.
    await pool.query(
      `INSERT INTO mailbox.drafts
         (inbox_message_id, draft_body, draft_subject, model, status,
          classification_category, classification_confidence,
          from_addr, to_addr, subject, body_text)
       VALUES ($1, 'hi', 'Re: x', 'qwen3:4b-ctx4k', 'pending',
               'inquiry', 0.4, $2, 'op@example.com', 'subj', 'body')`,
      [m1, SENDER],
    );

    const { POST } = await import('@/app/api/classifications/reclassify-sender/route');
    const res = await POST(
      fakeRequest({ body: { email: SENDER, category: 'spam_marketing', reason: 'newsletter' } }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.inbox_messages_relabelled).toBe(2);
    expect(body.drafts_relabelled).toBe(1);
    expect(body.log_rows_appended).toBe(2);

    // Both inbox rows relabelled (denorm + trigger).
    const inbox = await pool.query<{ classification: string }>(
      'SELECT classification FROM mailbox.inbox_messages WHERE id IN ($1, $2)',
      [m1, m2],
    );
    expect(inbox.rows.map((r) => r.classification)).toEqual(['spam_marketing', 'spam_marketing']);

    // Draft relabelled.
    const draft = await pool.query<{ classification_category: string }>(
      'SELECT classification_category FROM mailbox.drafts WHERE inbox_message_id = $1',
      [m1],
    );
    expect(draft.rows[0].classification_category).toBe('spam_marketing');

    // One audit row per message, tagged operator-sender-override.
    const log = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM mailbox.classification_log
        WHERE inbox_message_id IN ($1, $2) AND model_version = 'operator-sender-override'`,
      [m1, m2],
    );
    expect(Number(log.rows[0].n)).toBe(2);

    // FUTURE path: the classify-time lookup now forces this sender, including
    // when the inbound arrives in "Name <addr>" header form.
    const hit = await getSenderOverride(HEADER_FORM);
    expect(hit?.category).toBe('spam_marketing');
  });

  it('is idempotent — re-reclassifying upserts the rule, never duplicates', async () => {
    await seedInbox('mbox368-1', SENDER);
    const { POST } = await import('@/app/api/classifications/reclassify-sender/route');

    await POST(fakeRequest({ body: { email: SENDER, category: 'spam_marketing' } }));
    const res2 = await POST(fakeRequest({ body: { email: SENDER, category: 'inquiry' } }));
    expect(res2.status).toBe(200);

    const pool = getTestPool();
    const rule = await pool.query<{ n: string; category: string }>(
      `SELECT count(*) AS n, max(category) AS category
         FROM mailbox.sender_classification_overrides WHERE email = $1`,
      [SENDER],
    );
    expect(Number(rule.rows[0].n)).toBe(1); // upsert, single row
    expect(rule.rows[0].category).toBe('inquiry'); // latest wins

    const hit = await getSenderOverride(SENDER);
    expect(hit?.category).toBe('inquiry');
  });
});
