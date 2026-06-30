// dashboard/scripts/inbox-sweep-account.ts
//
// AgentBOX mailbox Phase 1 — NATIVE single-account inbound sweeper. For ONE
// connected account (resolved by email), mint a gmail.readonly access token via
// the dashboard's own getAccessToken, stream UNREAD recent inbound via
// fetchInboxViaGmail, and POST each message SERIALLY to the existing
// POST /api/internal/inbox-messages route (same body shape n8n's
// "Insert Inbox (HTTP)" node sends, plus account_email to route the row to the
// correct mailbox). Classification then happens passively via the in-process
// classify-sweeper (writes classification_log every 5 min) — this script does
// NOT classify and does NOT draft.
//
// SAFETY: read-only Gmail (list + get), no send, no draft. BOUNDED — caps the
// fetch at MAX_MESSAGES (default 25) over LOOKBACK_HOURS (default 168h = 7d).
//
// Invocation (via the migrate profile, on the docker network so it can reach
// mailbox-dashboard:3001):
//   INBOX_SWEEP_ACCOUNT_EMAIL=owner@example.com \
//   INTERNAL_BASE_URL=http://mailbox-dashboard:3001/dashboard \
//   npx tsx scripts/inbox-sweep-account.ts

import { fetchInboxViaGmail } from '@/lib/mail/gmail-fetch';
import { getAccessToken } from '@/lib/oauth/google';
import { resolveIngestAccountId } from '@/lib/queries-accounts';

const MAX_MESSAGES = Number(process.env.INBOX_SWEEP_MAX ?? 25);
const LOOKBACK_HOURS = Number(process.env.INBOX_SWEEP_LOOKBACK_HOURS ?? 168);
const BASE = (process.env.INTERNAL_BASE_URL ?? 'http://mailbox-dashboard:3001/dashboard').replace(
  /\/$/,
  '',
);

async function main() {
  const email = process.env.INBOX_SWEEP_ACCOUNT_EMAIL?.trim();
  if (!email) {
    console.error('INBOX_SWEEP_ACCOUNT_EMAIL env not set');
    process.exit(1);
  }

  const acct = await resolveIngestAccountId({ account_email: email });
  if (!acct.ok) {
    console.error(`could not resolve account for ${email}: ${acct.reason}`);
    process.exit(1);
  }
  const accountId = acct.account_id;

  // Mint a short-lived gmail.readonly access token for THIS account's grant.
  const accessToken = await getAccessToken('google_gmail', 8_000, accountId);

  let fetched = 0;
  let inserted = 0;
  let deduped = 0;
  let failed = 0;

  for await (const m of fetchInboxViaGmail(accessToken, {
    lookbackHours: LOOKBACK_HOURS,
    maxMessages: MAX_MESSAGES,
  })) {
    fetched += 1;
    // Mirror n8n's "Insert Inbox (HTTP)" body shape exactly, + account_email so
    // the route's resolveIngestAccountId files it under this mailbox.
    const body = {
      account_email: email,
      message_id: m.provider_message_id,
      thread_id: m.thread_id ?? '',
      from_addr: m.from_addr ?? '',
      to_addr: m.to_addr ?? '',
      subject: m.subject ?? '',
      received_at: m.received_at ?? '',
      snippet: (m.body ?? '').slice(0, 200),
      body: m.body ?? '',
      in_reply_to: m.in_reply_to ?? '',
      references: m.references ?? '',
    };

    try {
      const res = await fetch(`${BASE}/api/internal/inbox-messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        failed += 1;
        const detail = await res.text().catch(() => '');
        console.error(`  POST failed ${res.status} for ${m.provider_message_id}: ${detail.slice(0, 160)}`);
        continue;
      }
      const json = (await res.json().catch(() => null)) as
        | { id: number; created: boolean }
        | null;
      if (json?.created) inserted += 1;
      else deduped += 1;
    } catch (err) {
      failed += 1;
      console.error(
        `  POST error for ${m.provider_message_id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  console.log(
    JSON.stringify({
      ok: true,
      account_email: email,
      account_id: accountId,
      fetched,
      inserted,
      deduped,
      failed,
      max_messages: MAX_MESSAGES,
      lookback_hours: LOOKBACK_HOURS,
    }),
  );
  process.exit(failed > 0 && inserted === 0 && deduped === 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('inbox-sweep-account failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
