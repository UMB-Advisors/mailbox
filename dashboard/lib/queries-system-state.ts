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
  set_at: Date | null;
  // Google's "Retry after" hint is a SOFT minimum — STAQPRO-271 + the n8n
  // boundary contract document that probing right at the hint timestamp
  // tends to extend the cooldown. The operator-facing recommendation is
  // `until + 1h` (STAQPRO-228 buffer). Mirror that here so the UI banner
  // can show both the raw deadline and the safe-to-send recommendation.
  recommended_safe_at: Date | null;
  isActive: boolean;
}

// STAQPRO-228 buffer constant. Kept in lockstep with
// app/api/internal/gmail-cooldown/route.ts:BUFFER_MS so the operator UI
// and the n8n-facing gate use the same recommendation.
const SAFE_BUFFER_MS = 60 * 60 * 1000;

export async function getGmailCooldown(): Promise<GmailCooldown> {
  const db = getKysely();
  const row = await sql<{
    gmail_rate_limit_until: string | null;
    gmail_rate_limit_set_at: string | null;
  }>`
    SELECT gmail_rate_limit_until, gmail_rate_limit_set_at
    FROM mailbox.system_state
    WHERE id = 1
  `.execute(db);
  const r = row.rows[0];
  const until = r?.gmail_rate_limit_until ? new Date(r.gmail_rate_limit_until) : null;
  const set_at = r?.gmail_rate_limit_set_at ? new Date(r.gmail_rate_limit_set_at) : null;
  const recommended_safe_at = until ? new Date(until.getTime() + SAFE_BUFFER_MS) : null;
  // `isActive` is keyed off the recommended safe deadline so the banner
  // stays visible across the +1h buffer window — matches the n8n-facing
  // gate's behavior.
  const isActive = recommended_safe_at !== null && recommended_safe_at.getTime() > Date.now();
  return {
    until,
    set_at,
    recommended_safe_at,
    isActive,
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

// MBOX-107 — operator-driven force-resume escape hatch. Clears the Gmail
// cooldown row (sets `gmail_rate_limit_until` + `gmail_rate_limit_set_at`
// to NULL) so the n8n `Cooldown Active?` gate reopens and the dashboard
// approve/retry transitions stop short-circuiting at the cooldown gate.
//
// Captures the previous deadline via a CTE so the route layer can log
// what the operator overrode (useful for forensics if a force-resume
// re-aggravates a still-active Google probation — see
// gmail_ratelimit_probation memory: calling Gmail inside an active
// probation extends the cooldown +15 min).
//
// Idempotent: clearing an already-cleared cooldown returns `cleared:
// false, previous_until: null`. The route layer treats both shapes as
// HTTP 200 to keep DELETE semantics clean — the operator gets the same
// "cooldown is cleared" outcome either way.
export interface ClearGmailCooldownResult {
  cleared: boolean;
  previous_until: Date | null;
}

export async function clearGmailCooldown(): Promise<ClearGmailCooldownResult> {
  const db = getKysely();
  const row = await sql<{ previous_until: string | null }>`
    WITH prev AS (
      SELECT gmail_rate_limit_until AS previous_until
        FROM mailbox.system_state
       WHERE id = 1
    )
    UPDATE mailbox.system_state
       SET gmail_rate_limit_until = NULL,
           gmail_rate_limit_set_at = NULL
     WHERE id = 1
    RETURNING (SELECT previous_until FROM prev)
  `.execute(db);
  const previousUntilRaw = row.rows[0]?.previous_until ?? null;
  const previous_until = previousUntilRaw ? new Date(previousUntilRaw) : null;
  return {
    cleared: previous_until !== null,
    previous_until,
  };
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
