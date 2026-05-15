import { sql } from 'kysely';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { classifyOne, type InboxRowForClassify } from '@/lib/classification/classify-one';
import { getKysely, getPool } from '@/lib/db';
import { parseJson } from '@/lib/middleware/validate';

// STAQPRO-370 — sweep body schema. Kept inline rather than in
// `lib/schemas/internal.ts` so the contract lives next to its only consumer.
// Both knobs cap how far back the sweep looks and how many rows it processes
// per call; defaults match the live `MailBOX-ClassifySweeper` schedule
// (hourly, 50 rows/hr ≈ 1 per ~70s so we don't starve Qwen3 of capacity for
// the live 5-min poll cycle).
const classifySweepBodySchema = z.object({
  // Window relative to NOW(). Default 7 days. Cap at 90 days so a runaway
  // sweep can't iterate through years of backfilled history; longer cleanup
  // jobs should run via `scripts/classify-backfill.ts` as a one-shot.
  lookback_hours: z.coerce
    .number()
    .int()
    .positive()
    .max(24 * 90)
    .default(24 * 7),
  // Hard cap per call. Default 50 — at ~3s/classify on Qwen3 that's ~2.5min
  // per sweep, well inside the hourly cadence and leaves ~95% of Qwen3
  // capacity free for the live 5-min poll cycle.
  limit: z.coerce.number().int().positive().max(500).default(50),
});

export const dynamic = 'force-dynamic';
// A 50-row sweep at ~3s/row on Qwen3 plus framing overhead can stretch past
// the App Router default. Cap at 10 minutes so the long-tail rows on a
// loaded appliance don't 504 mid-sweep.
export const maxDuration = 600;

// Postgres advisory-lock key derived from the ticket number. pg_try_advisory_lock
// returns immediately (no wait) so a stacked hourly tick + an operator
// manual fire get a clean 409 instead of doubling up on Qwen3 capacity.
const SWEEP_LOCK_KEY = 370;

// STAQPRO-370 — periodic classify sweeper for inbox rows that bypassed the
// live `MailBOX-Classify` chain. Two known sources of unclassified rows:
//
//   1. `MailBOX-FetchHistory` (onboarding backfill) writes rows directly to
//      `mailbox.inbox_messages` via `lib/onboarding/gmail-history-backfill.ts:upsertInbound`
//      with `classification: null`. The live pipeline's `Insert Inbox` dedup
//      gate then skips them on the next 5-min poll cycle. This is by design
//      (classifying every row of a 5k-thread backfill would turn onboarding
//      into a multi-hour ordeal) but means every fresh appliance starts
//      with an unclassified backlog.
//
//   2. n8n downtime / sub-workflow deactivation (STAQPRO-181 hit this for
//      ~12h on M2 post-upgrade). Live rows from that window are never
//      auto-classified on a future cycle.
//
// This route is the structural fix for source #1 and the safety net for
// source #2. Companion to `scripts/classify-backfill.ts` (STAQPRO-368) — the
// script is the operator one-shot for an existing backlog; this route is
// the always-on janitor that prevents new backlogs from accumulating.
//
// Invoked hourly by the `MailBOX-ClassifySweeper` n8n workflow over the
// docker network (`http://mailbox-dashboard:3001/api/internal/classify-sweep`).
// Also operator-callable for manual fire when the on-call wants to drain a
// known cohort faster than the hourly cadence.
//
// What this DOES classify-chain-wise: prompt → Ollama Qwen3 → normalize →
// INSERT classification_log. The migration 021 sync trigger then fans the
// new log row out to inbox_messages.classification / confidence / model.
//
// What it deliberately SKIPS vs the live chain:
//   - Live Gate check (backlog rows predate the gate's intent)
//   - Drop-spam IF gate / Insert Draft Stub / Trigger Draft Sub (auto-
//     drafting historical mail is a separate decision; see STAQPRO-368
//     scope note)
//
// Response shape:
//   { ok: true, processed, ok_count, fail_count, remaining, elapsed_ms,
//     lookback_hours, limit }
// `remaining` is the count of still-unclassified rows in the window AFTER
// the sweep ran — the n8n sweeper logs this to make backlog drain rate
// visible without a separate dashboard query.

interface SweepRowRaw {
  id: number;
  from_addr: string | null;
  to_addr: string | null;
  subject: string | null;
  body: string | null;
  snippet: string | null;
}

export async function POST(req: NextRequest): Promise<Response> {
  const parsed = await parseJson(req, classifySweepBodySchema);
  if (!parsed.ok) return parsed.response;

  const { lookback_hours, limit } = parsed.data;
  const startedAt = Date.now();
  const db = getKysely();
  const pool = getPool();

  // Concurrency guard. Without this, an hourly tick that overlaps with an
  // operator-fired manual sweep would double-stack Qwen3 inference calls
  // (~6s/row instead of ~3s) and starve the live 5-min poll's Qwen3
  // capacity. 409 lets the caller distinguish "no work" from "another
  // sweep already running."
  const lockRow = await sql<{
    locked: boolean;
  }>`SELECT pg_try_advisory_lock(${SWEEP_LOCK_KEY}) AS locked`.execute(db);
  const acquired = lockRow.rows[0]?.locked === true;
  if (!acquired) {
    return NextResponse.json(
      {
        ok: false,
        error: 'already_running',
        message: 'A classify sweep is already in progress on this appliance',
      },
      { status: 409 },
    );
  }

  try {
    // Pull oldest-first inside the lookback window. ORDER BY received_at ASC
    // mirrors `scripts/classify-backfill.ts` — backlog drain is FIFO so the
    // operator sees old rows resolve first on the Classifications page.
    //
    // Joins classification_log to skip rows we've already processed in a
    // previous sweep. classification_log is append-only and the migration
    // 021 trigger writes inbox_messages.classification from it, so the
    // anti-join is the source of truth for "needs classify."
    const rows = await pool.query<SweepRowRaw>(
      `SELECT m.id, m.from_addr, m.to_addr, m.subject, m.body, m.snippet
         FROM mailbox.inbox_messages m
    LEFT JOIN mailbox.classification_log c ON c.inbox_message_id = m.id
        WHERE c.id IS NULL
          AND m.received_at > NOW() - make_interval(hours => $1)
     ORDER BY m.received_at ASC
        LIMIT $2`,
      [lookback_hours, limit],
    );

    let okCount = 0;
    let failCount = 0;
    for (const row of rows.rows) {
      try {
        const result = await classifyOne(row as InboxRowForClassify);
        await pool.query(
          `INSERT INTO mailbox.classification_log
             (inbox_message_id, category, confidence, model_version,
              latency_ms, raw_output, json_parse_ok, think_stripped)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            result.inbox_message_id,
            result.category,
            result.confidence,
            result.model_version,
            result.latency_ms,
            result.raw_output,
            result.json_parse_ok,
            result.think_stripped,
          ],
        );
        okCount += 1;
      } catch (err) {
        // Per-row failures are logged + counted but don't abort the batch —
        // a single malformed row shouldn't black-hole the sweep. The next
        // hourly tick will retry naturally (the row still has no
        // classification_log entry).
        console.error(
          `[classify-sweep] row id=${row.id} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        failCount += 1;
      }
    }

    // Remaining-after-sweep count is a cheap visibility hook for the n8n
    // sweeper to log and for `/status` to surface drain progress.
    const remainingRow = await pool.query<{ remaining: string }>(
      `SELECT COUNT(*)::text AS remaining
         FROM mailbox.inbox_messages m
    LEFT JOIN mailbox.classification_log c ON c.inbox_message_id = m.id
        WHERE c.id IS NULL
          AND m.received_at > NOW() - make_interval(hours => $1)`,
      [lookback_hours],
    );
    const remaining = Number.parseInt(remainingRow.rows[0]?.remaining ?? '0', 10);

    return NextResponse.json({
      ok: true,
      processed: rows.rows.length,
      ok_count: okCount,
      fail_count: failCount,
      remaining,
      elapsed_ms: Date.now() - startedAt,
      lookback_hours,
      limit,
    });
  } catch (error) {
    console.error('POST /api/internal/classify-sweep failed:', error);
    return NextResponse.json(
      {
        ok: false,
        error: 'sweep_failed',
        message: error instanceof Error ? error.message : 'unknown',
        elapsed_ms: Date.now() - startedAt,
      },
      { status: 502 },
    );
  } finally {
    // Release the advisory lock — pool-backed so the lock is bound to the
    // pg connection that acquired it; the same Kysely instance reuses the
    // pool so the unlock targets the correct session.
    await sql`SELECT pg_advisory_unlock(${SWEEP_LOCK_KEY})`.execute(db);
  }
}
