// dashboard/lib/jobs/classify-sweeper.ts
//
// In-process auto-recovery for the failure mode STAQPRO-181 exposed:
// when MailBOX-Classify is unhealthy (inactive sub-workflow, n8n crash,
// etc.), the parent's `Only If Newly Inserted` IF gate dedup-skips
// re-polls and rows orphan permanently in `mailbox.inbox_messages` with
// no `classification_log` entry. The /status page's Classify-lag Stat
// surfaces the state but doesn't recover. This sweeper does.
//
// Tick (every 5 min via instrumentation.ts):
//   1. Try to acquire a single-process advisory lock so overlapping ticks
//      can't double-classify.
//   2. Find inbox_messages from the last 24h with no classification_log.
//   3. For each: build prompt (lib/classification/prompt), call Ollama,
//      normalize (lib/classification/normalize), INSERT classification_log.
//   4. Per-row try/catch — one bad row doesn't poison the tick.
//
// Direct in-process — no HTTP roundtrip to /api/internal/* (saves ~5ms
// per row and avoids the Next.js route handler overhead). The
// scripts/classify-backfill.ts CLI keeps its HTTP-based shape because it
// runs as a one-shot tsx process without the Next.js module context.

import { sql } from 'kysely';
import { classifyOne, type InboxRowForClassify } from '@/lib/classification/classify-one';
import { retrieveClassificationExemplars } from '@/lib/classification/exemplars';
import { MODEL_VERSION } from '@/lib/classification/prompt';
import { senderRule } from '@/lib/classification/sender-rules';
import { getKysely } from '@/lib/db';
import { withJobRun } from '@/lib/jobs/job-runs';

const LOCK_KEY = 7234567; // arbitrary 32-bit int, scoped to this sweeper

// Per-row classify HTTP timeout. Matches the n8n MailBOX-Classify HTTP node
// timeout (180s, c9caa33). Without this, a hung Ollama or llama-server holds
// the per-row promise indefinitely and the outer advisory-lock unlock never
// runs — every subsequent sweeper tick is a silent no-op.
const CLASSIFY_TIMEOUT_MS = Number(process.env.CLASSIFY_SWEEPER_TIMEOUT_MS ?? 180_000);
const LOOKBACK_HOURS = Number(process.env.CLASSIFY_SWEEPER_LOOKBACK_HOURS ?? 24);
const ROW_LIMIT = Number(process.env.CLASSIFY_SWEEPER_ROW_LIMIT ?? 50);
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

interface SweeperResult {
  checked: number;
  classified: number;
  failed: number;
}

type InboxRow = InboxRowForClassify;

// Wrap global fetch with a per-call AbortController timeout. classify-one's
// ClassifyOneDeps takes a `fetchImpl` injection point precisely for this —
// we don't want to bake a timeout into the shared classify chain because
// the live MailBOX-Classify node + the operator backfill script have
// different latency tolerances.
function timeoutFetch(timeoutMs: number, label: string): typeof fetch {
  return async (input, init) => {
    const ctrl = new AbortController();
    const handle = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(input, { ...init, signal: ctrl.signal });
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        throw new Error(`${label} -> timeout after ${timeoutMs}ms`);
      }
      throw e;
    } finally {
      clearTimeout(handle);
    }
  };
}

export async function runSweeperTick(): Promise<SweeperResult> {
  const db = getKysely();
  const result: SweeperResult = { checked: 0, classified: 0, failed: 0 };

  const lock = await sql<{ acquired: boolean }>`
    SELECT pg_try_advisory_lock(${LOCK_KEY}) AS acquired
  `.execute(db);
  if (!lock.rows[0]?.acquired) {
    return result;
  }

  try {
    // Phase 1b — carry m.account_id so the classification_log row is tagged with
    // the SAME mailbox as its inbox row (multi-account correctness). classifyOne
    // ignores the extra field; only the log INSERT below consumes it.
    const queryResult = await sql<InboxRow & { account_id: number }>`
      SELECT m.id, m.from_addr, m.to_addr, m.subject, m.body, m.snippet, m.account_id
        FROM mailbox.inbox_messages m
   LEFT JOIN mailbox.classification_log c ON c.inbox_message_id = m.id
       WHERE c.id IS NULL
         AND m.received_at > NOW() - make_interval(hours => ${LOOKBACK_HOURS})
    ORDER BY m.received_at ASC
       LIMIT ${ROW_LIMIT}
    `.execute(db);

    const sharedFetch = timeoutFetch(CLASSIFY_TIMEOUT_MS, 'classify-sweeper');
    result.checked = queryResult.rows.length;
    for (const row of queryResult.rows) {
      try {
        // Spec 002 FR7 (Stage 2b-1) — pass the Train sender-rule resolver so
        // force/bias rules apply on this (live, timer-driven) classify path.
        // Empty sender_rules table → no-op; fail-open + kill switch live in
        // senderRule. The n8n classification-normalize route is intentionally
        // NOT wired here (no n8n change — see MANIFEST).
        const outcome = await classifyOne(row, {
          fetchImpl: sharedFetch,
          senderRuleLookup: senderRule,
          // Spec 002 FR7b (Stage 2b-2) — few-shot exemplar retrieval (fail-closed
          // → [] inside the retriever; empty table → no-op; ctx CAP enforced
          // there). Biased toward the bias-rule prior + ranked by subject overlap.
          exemplarLookup: ({ senderPrior, subject }) =>
            retrieveClassificationExemplars({
              senderPrior,
              subject,
              account_id: row.account_id,
            }),
        });
        await db
          .insertInto('classification_log')
          .values({
            inbox_message_id: row.id,
            // Phase 1b — tag the log with the inbox row's owning account so
            // per-account classification analytics are correct. Was previously
            // omitted → fell to the column DEFAULT (account 1).
            account_id: row.account_id,
            category: outcome.category,
            confidence: outcome.confidence,
            model_version: MODEL_VERSION,
            latency_ms: outcome.latency_ms,
            raw_output: outcome.raw_output,
            json_parse_ok: outcome.json_parse_ok,
            think_stripped: outcome.think_stripped,
          })
          .execute();
        result.classified += 1;
      } catch (e) {
        console.error(
          `[classify-sweeper] id=${row.id} fail:`,
          e instanceof Error ? e.message : String(e),
        );
        result.failed += 1;
      }
    }
  } finally {
    await sql`SELECT pg_advisory_unlock(${LOCK_KEY})`.execute(db);
  }

  if (result.checked > 0 || result.failed > 0) {
    console.log(`[classify-sweeper] tick: ${JSON.stringify(result)}`);
  }
  return result;
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;

export function startClassifySweeper(intervalMs = DEFAULT_INTERVAL_MS): void {
  if (intervalHandle) return;
  console.log(`[classify-sweeper] starting (interval=${intervalMs}ms)`);
  intervalHandle = setInterval(() => {
    withJobRun('classify-sweeper', runSweeperTick).catch((e: unknown) => {
      console.error('[classify-sweeper] tick error:', e instanceof Error ? e.message : String(e));
    });
  }, intervalMs);
}
