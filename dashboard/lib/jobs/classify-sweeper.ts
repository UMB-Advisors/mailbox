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
import { getKysely } from '@/lib/db';
import { normalizeClassifierOutput } from '@/lib/classification/normalize';
import { buildPrompt, MODEL_VERSION } from '@/lib/classification/prompt';

const OLLAMA_URL = process.env.OLLAMA_BASE_URL ?? 'http://ollama:11434';
const LOCK_KEY = 7234567; // arbitrary 32-bit int, scoped to this sweeper
const LOOKBACK_HOURS = 24;
const ROW_LIMIT = 50;
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

interface SweeperResult {
  checked: number;
  classified: number;
  failed: number;
}

interface InboxRow {
  id: number;
  from_addr: string | null;
  to_addr: string | null;
  subject: string | null;
  body: string | null;
  snippet: string | null;
}

interface ClassifyOutcome {
  category: string;
  confidence: number;
  latency_ms: number;
  raw_output: string;
  json_parse_ok: boolean;
  think_stripped: boolean;
}

async function classifyRow(row: InboxRow): Promise<ClassifyOutcome> {
  const prompt = buildPrompt({
    from: row.from_addr ?? '',
    subject: row.subject ?? '',
    body: row.body ?? row.snippet ?? '',
  });

  const t0 = Date.now();
  const ollamaRes = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL_VERSION,
      prompt,
      stream: false,
      format: 'json',
      options: { temperature: 0 },
    }),
  });
  if (!ollamaRes.ok) {
    throw new Error(`ollama -> HTTP ${ollamaRes.status}`);
  }
  const ollamaJson = (await ollamaRes.json()) as { response?: string };
  const latency_ms = Date.now() - t0;

  const normalized = normalizeClassifierOutput(ollamaJson.response ?? '', {
    from: row.from_addr ?? undefined,
    to: row.to_addr ?? undefined,
  });

  return {
    category: normalized.category,
    confidence: normalized.confidence,
    latency_ms,
    raw_output: normalized.raw_output,
    json_parse_ok: normalized.json_parse_ok,
    think_stripped: normalized.think_stripped,
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
    const queryResult = await sql<InboxRow>`
      SELECT m.id, m.from_addr, m.to_addr, m.subject, m.body, m.snippet
        FROM mailbox.inbox_messages m
   LEFT JOIN mailbox.classification_log c ON c.inbox_message_id = m.id
       WHERE c.id IS NULL
         AND m.received_at > NOW() - make_interval(hours => ${LOOKBACK_HOURS})
    ORDER BY m.received_at ASC
       LIMIT ${ROW_LIMIT}
    `.execute(db);

    result.checked = queryResult.rows.length;
    for (const row of queryResult.rows) {
      try {
        const outcome = await classifyRow(row);
        await db
          .insertInto('classification_log')
          .values({
            inbox_message_id: row.id,
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
    runSweeperTick().catch((e: unknown) => {
      console.error(
        '[classify-sweeper] tick error:',
        e instanceof Error ? e.message : String(e),
      );
    });
  }, intervalMs);
}
