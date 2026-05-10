// dashboard/lib/queries-system-state.ts
//
// Singleton-row queries for mailbox.system_state — system-wide flags that
// don't fit on any individual row (drafts, inbox_messages, etc.). Currently
// just the Gmail rate-limit cooldown landed by STAQPRO-227 stretch; future
// system flags (RAG eval-disabled, classify-paused, etc.) will live here.

import { sql } from 'kysely';
import { getKysely } from '@/lib/db';

export interface GmailCooldown {
  until: Date | null;
  isActive: boolean;
}

export async function getGmailCooldown(): Promise<GmailCooldown> {
  const db = getKysely();
  const row = await sql<{ gmail_rate_limit_until: string | null }>`
    SELECT gmail_rate_limit_until FROM mailbox.system_state WHERE id = 1
  `.execute(db);
  const until = row.rows[0]?.gmail_rate_limit_until
    ? new Date(row.rows[0].gmail_rate_limit_until)
    : null;
  return {
    until,
    isActive: until !== null && until.getTime() > Date.now(),
  };
}

// Idempotent: only advances the cooldown forward — never retreats it. A
// sweeper that finds an older retry-after timestamp shouldn't shorten an
// active probation window. Useful when multiple n8n executions are 429'd
// near-simultaneously and the sweeper races to record the latest.
export async function setGmailCooldown(until: Date): Promise<void> {
  const db = getKysely();
  await sql`
    UPDATE mailbox.system_state
       SET gmail_rate_limit_until = GREATEST(gmail_rate_limit_until, ${until.toISOString()}::timestamptz),
           gmail_rate_limit_set_at = NOW()
     WHERE id = 1
  `.execute(db);
}

// STAQPRO-226 — Gmail bootstrap mode for first-install rate limiting.
//
// While `complete=false`, the n8n MailBOX workflow throttles Gmail Get to
// `GMAIL_GET_LIMIT_BOOTSTRAP` per cycle to avoid burning through Google's
// 250 unit/sec per-user quota during the first-install backlog drain.
// `recordCycleComplete()` flips `complete=true` once a cycle returns fewer
// messages than the bootstrap cap (i.e. didn't fill the bucket).

export const GMAIL_GET_LIMIT_BOOTSTRAP = 25;
export const GMAIL_GET_LIMIT_STEADY = 50;

export interface BootstrapState {
  complete: boolean;
  startedAt: Date | null;
  messagesSeen: number;
}

export async function getBootstrapState(): Promise<BootstrapState> {
  const db = getKysely();
  const row = await sql<{
    bootstrap_complete: boolean;
    bootstrap_started_at: string | null;
    bootstrap_messages_seen: number;
  }>`
    SELECT bootstrap_complete, bootstrap_started_at, bootstrap_messages_seen
      FROM mailbox.system_state
     WHERE id = 1
  `.execute(db);
  const r = row.rows[0];
  return {
    complete: r?.bootstrap_complete ?? true,
    startedAt: r?.bootstrap_started_at ? new Date(r.bootstrap_started_at) : null,
    messagesSeen: r?.bootstrap_messages_seen ?? 0,
  };
}

// Returned by recordCycleComplete so the n8n cycle-complete route can
// echo the post-update state back to the workflow log without a second
// SELECT round-trip.
export interface CycleCompleteResult {
  bootstrap_complete: boolean;
  bootstrap_messages_seen: number;
  flipped_this_cycle: boolean;
}

// Records one Gmail-Get cycle's outcome. While bootstrap is incomplete:
//   - increments messages_seen by N
//   - sets started_at on the first cycle (NULL → NOW)
//   - flips complete=true when the cycle returned fewer than the bootstrap
//     cap (didn't fill the bucket → backlog drained)
// Once complete=true, this is a no-op — steady-state cycles don't update.
export async function recordCycleComplete(messagesReturned: number): Promise<CycleCompleteResult> {
  const db = getKysely();
  const didFillBucket = messagesReturned >= GMAIL_GET_LIMIT_BOOTSTRAP;
  const row = await sql<{
    bootstrap_complete: boolean;
    bootstrap_messages_seen: number;
    flipped_this_cycle: boolean;
  }>`
    UPDATE mailbox.system_state
       SET bootstrap_started_at =
             COALESCE(bootstrap_started_at, NOW()),
           bootstrap_messages_seen =
             bootstrap_messages_seen + ${messagesReturned}::int,
           bootstrap_complete =
             bootstrap_complete OR NOT ${didFillBucket}::bool
     WHERE id = 1
       AND bootstrap_complete = false
    RETURNING
      bootstrap_complete,
      bootstrap_messages_seen,
      (NOT ${didFillBucket}::bool) AS flipped_this_cycle
  `.execute(db);
  if (row.rows[0]) return row.rows[0];
  // Already complete — no row updated. Return current state from a SELECT.
  const state = await getBootstrapState();
  return {
    bootstrap_complete: state.complete,
    bootstrap_messages_seen: state.messagesSeen,
    flipped_this_cycle: false,
  };
}
