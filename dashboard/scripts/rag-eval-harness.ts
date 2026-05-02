// dashboard/scripts/rag-eval-harness.ts
//
// STAQPRO-198 — RAG eval harness. Cosine-similarity-based offline A/B for
// "is RAG helping?" against the customer-#1 backfilled corpus (441 inbound,
// reply pairs in mailbox.sent_history with source = 'backfill').
//
// Methodology (locked in the issue):
//
//   For each (inbound, actual_reply) pair:
//     1. Assemble the live drafter's prompt for the inbound (same primitives
//        the /api/internal/draft-prompt route uses — RAG retrieval included
//        when RAG_DISABLED is unset, skipped when RAG_DISABLED=1).
//     2. POST that prompt to Ollama /api/chat with model qwen3:4b-ctx4k.
//     3. Embed both the generated draft and the actual reply via
//        nomic-embed-text:v1.5 (lib/rag/embed.ts).
//     4. Compute cosine similarity (raw dot product — nomic vectors are
//        unit-normalized).
//
// Mode is set by the operator via env, NOT by a CLI flag:
//
//     # baseline (no RAG, persona-stub only)
//     RAG_DISABLED=1 npm run eval:rag -- --limit 50
//     # treatment (with RAG)
//     npm run eval:rag -- --limit 50
//
// Output: dashboard/eval-results/rag-eval-<ISO-timestamp>-<mode>.json plus
// a summary table to stdout. The directory is gitignored — eval JSON is
// per-run customer data.
//
// Why we import the prompt primitives directly instead of POSTing to the
// /api/internal/draft-prompt route: the route requires a mailbox.drafts row
// keyed on draft_id, but backfilled inbounds in inbox_messages have no
// matching draft row. Inserting synthetic drafts to drive the route would
// pollute the live queue. Importing assemblePrompt + retrieveForDraft +
// pickEndpoint + getPersonaContext gives byte-identical assembly without
// the synthetic-draft pollution.
//
// Failure mode: per-pair try/catch — a single Ollama / embed failure logs
// the pair's message_id and continues. Final JSON has a per-pair status
// field so the operator can see which rows dropped out.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { Pool } from 'pg';
import type { Category } from '../lib/classification/prompt';
import { getPersonaContext } from '../lib/drafting/persona';
import { assemblePrompt } from '../lib/drafting/prompt';
import { pickEndpoint } from '../lib/drafting/router';
import { embedText } from '../lib/rag/embed';
import { type RetrievalResult, retrieveForDraft } from '../lib/rag/retrieve';

// =============================================================================
// Pure helpers (unit-tested in test/lib/rag-eval-harness.test.ts)
// =============================================================================

/**
 * Cosine similarity for two equal-length numeric vectors.
 *
 * nomic-embed-text:v1.5 emits unit-normalized 768-dim vectors so dot product
 * equals cosine similarity. We still divide by the magnitude product to be
 * robust against ingested vectors that may have lost normalization through
 * upstream serialization (defensive — sub-microsecond cost on 768 dims).
 *
 * Returns 0 for mismatched lengths or zero-magnitude inputs (rather than
 * NaN) so the aggregator math stays sane.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i];
    const bi = b[i];
    dot += ai * bi;
    magA += ai * ai;
    magB += bi * bi;
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  if (denom === 0) return 0;
  return dot / denom;
}

/**
 * Sample-selection SQL. JOIN sent_history → inbox_messages on the live
 * foreign-key (sent_history.inbox_message_id = inbox_messages.id), filter
 * to backfilled rows (source = 'backfill'), drop pairs missing either body.
 *
 * The issue spec called for `sh.in_reply_to = im.rfc822_message_id` "or
 * equivalent — confirm during research". Research found:
 *   - sent_history has no in_reply_to / rfc822_message_id columns.
 *   - inbox_messages has in_reply_to + message_id (Gmail msg id).
 *   - The backfill orchestrator (lib/onboarding/gmail-history-backfill.ts)
 *     wires sent_history.inbox_message_id directly to the inbound row's
 *     numeric id. That's the canonical pairing — no header chase needed.
 *
 * limitClause is null for `--limit all`; otherwise `LIMIT N`.
 */
export function buildSampleSql(limitClause: number | null): string {
  const limitFragment = limitClause === null ? '' : `LIMIT ${Math.max(1, Math.floor(limitClause))}`;
  // Order by sent_at so successive runs hit the same prefix when --limit < total.
  return `
    SELECT
      sh.id                          AS sent_history_id,
      sh.message_id                  AS sent_message_id,
      sh.draft_sent                  AS actual_reply_body,
      sh.sent_at                     AS reply_sent_at,
      im.id                          AS inbox_id,
      im.message_id                  AS inbox_message_id,
      im.from_addr                   AS inbox_from,
      im.subject                     AS inbox_subject,
      im.body                        AS inbox_body,
      im.classification              AS inbox_classification,
      im.confidence                  AS inbox_confidence
    FROM mailbox.sent_history sh
    JOIN mailbox.inbox_messages im ON im.id = sh.inbox_message_id
    WHERE sh.source = 'backfill'
      AND sh.inbox_message_id IS NOT NULL
      AND COALESCE(sh.draft_sent, '') <> ''
      AND COALESCE(im.body, '') <> ''
    ORDER BY sh.sent_at ASC
    ${limitFragment}
  `;
}

export interface PerPairScore {
  sent_history_id: number;
  inbox_message_id: string;
  classification: string | null;
  cosine: number | null;
  rag_refs_count: number;
  rag_reason: RetrievalResult['reason'];
  draft_chars: number;
  actual_chars: number;
  status: 'ok' | 'draft_failed' | 'embed_failed' | 'error';
  error?: string;
}

export interface AggregateStats {
  count: number;
  mean: number;
  median: number;
  p25: number;
  p75: number;
  min: number;
  max: number;
}

export interface RagEvalReport {
  generated_at: string;
  mode: 'with-rag' | 'no-rag';
  drafter_model: string;
  embed_model: string;
  sample_size_requested: number | 'all';
  sample_size_actual: number;
  aggregates_global: AggregateStats;
  aggregates_by_category: Record<string, AggregateStats>;
  per_pair: PerPairScore[];
  // Counts of pair statuses so an operator can spot drift between modes
  // (e.g., draft_failed exploding under no-rag when local drafts hallucinate
  // empty completions because they have no anchor).
  status_counts: Record<PerPairScore['status'], number>;
}

/**
 * Aggregate stats over a list of cosine scores. Excludes nulls (failed
 * pairs). Returns zeros if the input is empty so the JSON shape is stable
 * regardless of corpus state.
 */
export function aggregate(scores: readonly number[]): AggregateStats {
  const xs = scores
    .filter((s) => Number.isFinite(s))
    .slice()
    .sort((a, b) => a - b);
  if (xs.length === 0) {
    return { count: 0, mean: 0, median: 0, p25: 0, p75: 0, min: 0, max: 0 };
  }
  const sum = xs.reduce((a, b) => a + b, 0);
  return {
    count: xs.length,
    mean: sum / xs.length,
    median: percentile(xs, 0.5),
    p25: percentile(xs, 0.25),
    p75: percentile(xs, 0.75),
    min: xs[0],
    max: xs[xs.length - 1],
  };
}

// Linear-interpolation percentile (R-7 / Excel default). Caller passes
// already-sorted ascending input.
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

export function buildReport(args: {
  mode: 'with-rag' | 'no-rag';
  drafter_model: string;
  embed_model: string;
  sample_size_requested: number | 'all';
  per_pair: PerPairScore[];
}): RagEvalReport {
  const { mode, drafter_model, embed_model, sample_size_requested, per_pair } = args;
  const okScores = per_pair.filter((p) => p.cosine !== null).map((p) => p.cosine as number);
  const byCategory = new Map<string, number[]>();
  for (const pair of per_pair) {
    if (pair.cosine === null) continue;
    const cat = pair.classification ?? 'unclassified';
    let bucket = byCategory.get(cat);
    if (!bucket) {
      bucket = [];
      byCategory.set(cat, bucket);
    }
    bucket.push(pair.cosine);
  }
  const aggregates_by_category: Record<string, AggregateStats> = {};
  for (const [cat, scores] of byCategory) {
    aggregates_by_category[cat] = aggregate(scores);
  }
  const status_counts: Record<PerPairScore['status'], number> = {
    ok: 0,
    draft_failed: 0,
    embed_failed: 0,
    error: 0,
  };
  for (const p of per_pair) status_counts[p.status] += 1;

  return {
    generated_at: new Date().toISOString(),
    mode,
    drafter_model,
    embed_model,
    sample_size_requested,
    sample_size_actual: per_pair.length,
    aggregates_global: aggregate(okScores),
    aggregates_by_category,
    per_pair,
    status_counts,
  };
}

export interface ParsedArgs {
  limit: number | 'all';
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let limit: number | 'all' = 'all';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit') {
      const v = argv[i + 1];
      if (v === undefined || v === '') throw new Error('--limit requires a value');
      if (v === 'all') {
        limit = 'all';
      } else {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) {
          throw new Error(`--limit must be 'all' or a positive number, got: ${v}`);
        }
        limit = Math.floor(n);
      }
      i++;
    }
  }
  return { limit };
}

// =============================================================================
// I/O helpers (mocked in tests)
// =============================================================================

export interface PairRow {
  sent_history_id: number;
  sent_message_id: string;
  actual_reply_body: string;
  reply_sent_at: string;
  inbox_id: number;
  inbox_message_id: string;
  inbox_from: string | null;
  inbox_subject: string | null;
  inbox_body: string;
  inbox_classification: string | null;
  inbox_confidence: number | null;
}

const DEFAULT_PERSONA_KEY = 'default';

/**
 * Assemble the same prompt the live drafter would build for this inbound
 * and POST it to Ollama /api/chat. Returns the generated draft body.
 *
 * Path-of-least-divergence: same getPersonaContext + retrieveForDraft +
 * pickEndpoint + assemblePrompt that /api/internal/draft-prompt uses; the
 * only thing skipped is the mailbox.drafts.rag_context_refs writeback (the
 * harness doesn't write to the drafts table — eval is read-only against
 * Postgres).
 *
 * Fallback for inbox rows that don't carry a real classification (most
 * backfill rows): default to 'inquiry' which routes LOCAL — same path the
 * live drafter takes for low-confidence inbounds.
 */
export interface DrafterDeps {
  fetchFn?: typeof fetch;
  retrieve?: typeof retrieveForDraft;
  resolvePersona?: typeof getPersonaContext;
}

export async function generateDraft(
  pair: PairRow,
  deps: DrafterDeps = {},
): Promise<{ body: string; refs_count: number; reason: RetrievalResult['reason'] }> {
  const fetchFn = deps.fetchFn ?? fetch;
  const retrieve = deps.retrieve ?? retrieveForDraft;
  const resolvePersona = deps.resolvePersona ?? getPersonaContext;

  // Backfill rows are unclassified — default to 'inquiry' so route is LOCAL.
  // Confidence floors at 1.0 to skip the <0.75 cloud-safety-net (eval is
  // local-route only per the issue's out-of-scope guardrail).
  const category: Category = (pair.inbox_classification as Category | null) ?? 'inquiry';
  const confidence = pair.inbox_confidence ?? 1.0;

  const persona = await resolvePersona(DEFAULT_PERSONA_KEY);
  const endpoint = pickEndpoint(category, confidence);
  // Eval covers LOCAL route only. If routing decides cloud (escalate /
  // unknown), surface that as a soft skip via the retrieval reason — the
  // operator should re-run with a category filter if they care.
  const retrieval = await retrieve({
    from_addr: pair.inbox_from ?? '',
    subject: pair.inbox_subject ?? null,
    body_text: pair.inbox_body ?? null,
    draft_source: endpoint.source,
    persona_key: DEFAULT_PERSONA_KEY,
  });
  const assembled = assemblePrompt({
    from_addr: pair.inbox_from ?? '',
    to_addr: '',
    subject: pair.inbox_subject ?? '',
    body_text: pair.inbox_body ?? '',
    category,
    confidence,
    persona,
    rag_refs: retrieval.refs,
  });

  // POST to Ollama /api/chat (matching n8n MailBOX-Draft exactly).
  const url = `${endpoint.baseUrl}/api/chat`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (endpoint.apiKey) headers.authorization = `Bearer ${endpoint.apiKey}`;
  const res = await fetchFn(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: endpoint.model,
      messages: assembled.messages,
      stream: false,
      options: {
        temperature: assembled.temperature,
        num_predict: assembled.max_tokens,
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`ollama /api/chat returned ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as { message?: { content?: string } };
  const content = data.message?.content ?? '';
  return {
    body: content,
    refs_count: retrieval.refs.length,
    reason: retrieval.reason,
  };
}

export interface ScorePairDeps extends DrafterDeps {
  embedFn?: typeof embedText;
}

export async function scorePair(pair: PairRow, deps: ScorePairDeps = {}): Promise<PerPairScore> {
  const embedFn = deps.embedFn ?? embedText;
  const base: Omit<
    PerPairScore,
    'cosine' | 'rag_refs_count' | 'rag_reason' | 'draft_chars' | 'status'
  > & {
    cosine: number | null;
    rag_refs_count: number;
    rag_reason: RetrievalResult['reason'];
    draft_chars: number;
    status: PerPairScore['status'];
  } = {
    sent_history_id: pair.sent_history_id,
    inbox_message_id: pair.inbox_message_id,
    classification: pair.inbox_classification,
    cosine: null,
    rag_refs_count: 0,
    rag_reason: 'no_hits',
    draft_chars: 0,
    actual_chars: pair.actual_reply_body.length,
    status: 'error',
  };

  let draftBody = '';
  let refs_count = 0;
  let reason: RetrievalResult['reason'] = 'no_hits';
  try {
    const drafted = await generateDraft(pair, deps);
    draftBody = drafted.body;
    refs_count = drafted.refs_count;
    reason = drafted.reason;
  } catch (err) {
    return { ...base, status: 'draft_failed', error: errorMessage(err) };
  }

  base.draft_chars = draftBody.length;
  base.rag_refs_count = refs_count;
  base.rag_reason = reason;

  if (!draftBody.trim() || !pair.actual_reply_body.trim()) {
    return { ...base, status: 'embed_failed', error: 'empty draft or actual reply' };
  }

  const [draftVec, actualVec] = await Promise.all([
    embedFn(draftBody),
    embedFn(pair.actual_reply_body),
  ]);
  if (!draftVec || !actualVec) {
    return { ...base, status: 'embed_failed', error: 'embed returned null' };
  }

  return {
    ...base,
    cosine: cosineSimilarity(draftVec, actualVec),
    status: 'ok',
  };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// =============================================================================
// CLI entry point
// =============================================================================

function summaryTable(report: RagEvalReport): string {
  const g = report.aggregates_global;
  const lines: string[] = [];
  lines.push('');
  lines.push(`RAG eval — mode=${report.mode} model=${report.drafter_model}`);
  lines.push(
    `pairs: ${report.sample_size_actual} (requested ${report.sample_size_requested})  ok=${report.status_counts.ok} draft_failed=${report.status_counts.draft_failed} embed_failed=${report.status_counts.embed_failed} error=${report.status_counts.error}`,
  );
  lines.push('');
  lines.push('Global cosine similarity:');
  lines.push(
    `  count=${g.count}  mean=${g.mean.toFixed(4)}  median=${g.median.toFixed(4)}  p25=${g.p25.toFixed(4)}  p75=${g.p75.toFixed(4)}  min=${g.min.toFixed(4)}  max=${g.max.toFixed(4)}`,
  );
  if (Object.keys(report.aggregates_by_category).length > 0) {
    lines.push('');
    lines.push('Per-category:');
    for (const [cat, agg] of Object.entries(report.aggregates_by_category)) {
      lines.push(
        `  ${cat.padEnd(16)} count=${String(agg.count).padStart(4)}  mean=${agg.mean.toFixed(4)}  median=${agg.median.toFixed(4)}`,
      );
    }
  }
  lines.push('');
  return lines.join('\n');
}

async function main(): Promise<void> {
  const url = process.env.POSTGRES_URL;
  if (!url) throw new Error('POSTGRES_URL not set');

  const args = parseArgs(process.argv.slice(2));
  const mode: 'with-rag' | 'no-rag' = process.env.RAG_DISABLED === '1' ? 'no-rag' : 'with-rag';
  const drafterModel = process.env.RAG_EVAL_DRAFTER_MODEL ?? 'qwen3:4b-ctx4k';
  const embedModel = process.env.EMBED_MODEL ?? 'nomic-embed-text:v1.5';

  console.log(
    `[rag-eval] mode=${mode} limit=${args.limit} drafter=${drafterModel} embed=${embedModel}`,
  );

  const pool = new Pool({ connectionString: url, max: 2 });
  try {
    const sql = buildSampleSql(args.limit === 'all' ? null : args.limit);
    const r = await pool.query<PairRow>(sql);
    const pairs = r.rows;
    console.log(`[rag-eval] selected ${pairs.length} (inbound, reply) pairs`);

    const perPair: PerPairScore[] = [];
    let i = 0;
    for (const pair of pairs) {
      i += 1;
      try {
        const score = await scorePair(pair);
        perPair.push(score);
      } catch (err) {
        perPair.push({
          sent_history_id: pair.sent_history_id,
          inbox_message_id: pair.inbox_message_id,
          classification: pair.inbox_classification,
          cosine: null,
          rag_refs_count: 0,
          rag_reason: 'no_hits',
          draft_chars: 0,
          actual_chars: pair.actual_reply_body.length,
          status: 'error',
          error: errorMessage(err),
        });
      }
      if (i % 10 === 0 || i === pairs.length) {
        const ok = perPair.filter((p) => p.status === 'ok').length;
        console.log(`[rag-eval] ${i}/${pairs.length} ok=${ok}`);
      }
    }

    const report = buildReport({
      mode,
      drafter_model: drafterModel,
      embed_model: embedModel,
      sample_size_requested: args.limit,
      per_pair: perPair,
    });

    const outDir = path.resolve(process.cwd(), 'eval-results');
    await mkdir(outDir, { recursive: true });
    const ts = report.generated_at.replace(/[:.]/g, '-');
    const outPath = path.join(outDir, `rag-eval-${ts}-${mode}.json`);
    await writeFile(outPath, JSON.stringify(report, null, 2), 'utf-8');

    console.log(summaryTable(report));
    console.log(`[rag-eval] wrote ${outPath}`);
  } finally {
    await pool.end();
  }
}

// Only run when invoked directly (not when imported by tests).
const isDirect =
  // tsx / node-style entrypoint check — robust to both `node script.ts` and
  // `tsx scripts/x.ts` invocations.
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /rag-eval-harness\.(ts|js|mjs|cjs)$/.test(process.argv[1]);

if (isDirect) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
