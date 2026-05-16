// dashboard/scripts/local-model-cosine-eval.ts
//
// STAQPRO-390 — local-model A/B cosine eval. Runs ON M1 against the
// backfilled sent_history corpus (441 inbound, reply pairs from Heron's
// pre-Mailbox Gmail history). Methodology mirrors STAQPRO-198 rag-eval-harness
// — cosine similarity of generated draft against the operator-approved
// actual reply, embedded with nomic-embed-text:v1.5 (768d unit-norm) — but
// loops two model tags so each row is scored against the same gold for both.
//
// Why this script and not a flag on rag-eval-harness:
//   - rag-eval-harness's variable is RAG_DISABLED (RAG on vs off), single model.
//   - This script's variable is the local Ollama tag, single RAG mode (off).
//   - Different CLI surfaces, different output shapes (per-row has TWO draft
//     texts + TWO cosine scores). Better as a focused sibling than a flag
//     bolted onto an existing eval.
//
// Phases (serial — 8 GB unified-RAM appliance can't co-load both Qwen tags +
// nomic + baseline services):
//
//   A. baseline_drafts  — load `--baseline` tag, generate one draft per row,
//                         persist text only (no embedding yet).
//   B. candidate_drafts — `ollama stop` the baseline, load `--candidate`,
//                         generate one draft per row, persist text only.
//   C. score            — `ollama stop` the candidate, the embed call
//                         implicitly loads nomic. For each row embed
//                         {baseline_draft, candidate_draft, gold_reply},
//                         compute cosine(baseline, gold) and
//                         cosine(candidate, gold). Aggregate.
//
// RAG retrieval is intentionally disabled (`RAG_DISABLED=1` forced from this
// script) so the only variable across pairs is the model. Persona context is
// resolved from the local appliance — run on M1 so getPersonaContext('default')
// returns the Heron persona that produced the gold corpus.
//
// Usage:
//   POSTGRES_URL=postgresql://mailbox:<pw>@postgres:5432/mailbox \
//   tsx scripts/local-model-cosine-eval.ts \
//       --baseline qwen3:4b-ctx4k \
//       --candidate qwen3.5:4b-ctx4k \
//       --limit 100 \
//       --run-tag 2026-05-16-A
//
// Pre-flight (must hold before running):
//   - Both --baseline and --candidate Ollama tags are pulled on the local
//     daemon (`ollama list` shows them).
//   - `MailBOX` parent workflow set inactive for the eval window so the
//     5-min poll doesn't compete for Ollama memory.
//
// Output:
//   - dashboard/eval-results/local-model-cosine-<run-tag>.json (per-row +
//     aggregate, gitignored)
//   - summary table to stdout
//
// Failure mode: per-row try/catch. A row's Ollama failure leaves that row's
// draft empty and its cosine null; aggregate filters those out and the
// final JSON has a `status` field per row so dropouts are visible.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { Pool } from 'pg';
import type { Category } from '../lib/classification/prompt';
import { getPersonaContext } from '../lib/drafting/persona';
import { assemblePrompt, type ChatMessage } from '../lib/drafting/prompt';
import { embedText } from '../lib/rag/embed';

// Force RAG off — we are isolating the model variable.
process.env.RAG_DISABLED = '1';

// =============================================================================
// Pure helpers (no Node-only imports above this line in the file is the
// convention; helpers are placed where the test file can import them).
// =============================================================================

/**
 * Cosine similarity for two equal-length numeric vectors. Mirrors the helper
 * in rag-eval-harness — duplicated rather than re-imported because we don't
 * want a hard dependency between two eval scripts.
 *
 * nomic-embed-text:v1.5 emits unit-normalized 768-dim vectors, so dot product
 * equals cosine. We still divide by magnitudes defensively. Returns 0 (not
 * NaN) for mismatched lengths or zero-magnitude vectors so aggregation math
 * stays sane.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    magA += x * x;
    magB += y * y;
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

export interface CosineResult {
  baseline: number | null;
  candidate: number | null;
}

export type WinLabel = 'baseline' | 'candidate' | 'tie' | 'dropout';

/**
 * Classify a row's outcome. A tie band of 0.005 absorbs nomic-embed noise —
 * empirically the embedder produces ~0.003 jitter across paraphrased inputs,
 * so a 0.005 dead-zone avoids spurious wins from re-roll variance.
 */
export function classifyWin(result: CosineResult, tieBand = 0.005): WinLabel {
  if (result.baseline === null || result.candidate === null) return 'dropout';
  const diff = result.candidate - result.baseline;
  if (Math.abs(diff) <= tieBand) return 'tie';
  return diff > 0 ? 'candidate' : 'baseline';
}

export interface AggregateSummary {
  total_rows: number;
  scored_rows: number;
  dropouts: number;
  baseline_mean: number;
  candidate_mean: number;
  baseline_median: number;
  candidate_median: number;
  mean_delta: number;
  candidate_wins: number;
  baseline_wins: number;
  ties: number;
  candidate_win_pct: number;
}

/** Sample median over a numeric array. Returns 0 for empty arrays. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2;
  return sorted[mid];
}

export function aggregate(scores: readonly CosineResult[]): AggregateSummary {
  const labels = scores.map((r) => classifyWin(r));
  const ok = scores.filter(
    (r): r is { baseline: number; candidate: number } =>
      r.baseline !== null && r.candidate !== null,
  );
  const baselineVals = ok.map((r) => r.baseline);
  const candidateVals = ok.map((r) => r.candidate);
  const mean = (xs: readonly number[]): number =>
    xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;
  const baseline_mean = mean(baselineVals);
  const candidate_mean = mean(candidateVals);
  const candidate_wins = labels.filter((l) => l === 'candidate').length;
  const baseline_wins = labels.filter((l) => l === 'baseline').length;
  const ties = labels.filter((l) => l === 'tie').length;
  const dropouts = labels.filter((l) => l === 'dropout').length;
  const decided = candidate_wins + baseline_wins + ties;
  return {
    total_rows: scores.length,
    scored_rows: ok.length,
    dropouts,
    baseline_mean: Number(baseline_mean.toFixed(4)),
    candidate_mean: Number(candidate_mean.toFixed(4)),
    baseline_median: Number(median(baselineVals).toFixed(4)),
    candidate_median: Number(median(candidateVals).toFixed(4)),
    mean_delta: Number((candidate_mean - baseline_mean).toFixed(4)),
    candidate_wins,
    baseline_wins,
    ties,
    candidate_win_pct: decided === 0 ? 0 : Number(((candidate_wins / decided) * 100).toFixed(1)),
  };
}

// =============================================================================
// I/O — only reachable when invoked via tsx (not when imported by tests).
// =============================================================================

interface ParsedArgs {
  baseline: string;
  candidate: string;
  limit: number;
  run_tag: string;
  output_dir: string;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let baseline: string | null = null;
  let candidate: string | null = null;
  let limit = 100;
  let run_tag: string | null = null;
  let output_dir = 'eval-results';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--baseline') {
      baseline = argv[++i] ?? null;
    } else if (a === '--candidate') {
      candidate = argv[++i] ?? null;
    } else if (a === '--limit') {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n <= 0) throw new Error('--limit must be a positive number');
      limit = Math.floor(n);
    } else if (a === '--run-tag') {
      run_tag = argv[++i] ?? null;
    } else if (a === '--output-dir') {
      output_dir = argv[++i] ?? output_dir;
    }
  }
  if (!baseline) throw new Error('--baseline <ollama-tag> is required');
  if (!candidate) throw new Error('--candidate <ollama-tag> is required');
  if (!run_tag) run_tag = new Date().toISOString().replace(/[:.]/g, '-');
  return { baseline, candidate, limit, run_tag, output_dir };
}

interface CorpusRow {
  sent_history_id: number;
  inbox_message_id: string;
  inbox_from: string;
  inbox_to: string;
  inbox_subject: string;
  inbox_body: string;
  classification_category: Category;
  classification_confidence: number;
  actual_reply_body: string;
}

async function loadCorpus(pool: Pool, limit: number): Promise<CorpusRow[]> {
  // Random sample — `random()` is fine at this volume (441 rows). For larger
  // corpora a TABLESAMPLE BERNOULLI would be cheaper but irrelevant here.
  const sql = `
    SELECT sh.id                          AS sent_history_id,
           im.message_id                  AS inbox_message_id,
           im.from_addr                   AS inbox_from,
           im.to_addr                     AS inbox_to,
           im.subject                     AS inbox_subject,
           im.body                        AS inbox_body,
           sh.classification_category     AS classification_category,
           sh.classification_confidence   AS classification_confidence,
           sh.draft_sent                  AS actual_reply_body
    FROM mailbox.sent_history sh
    JOIN mailbox.inbox_messages im ON im.id = sh.inbox_message_id
    WHERE sh.source = 'backfill'
      AND sh.inbox_message_id IS NOT NULL
      AND COALESCE(sh.draft_sent, '') <> ''
      AND COALESCE(im.body, '')       <> ''
      AND length(im.body) < 4000
      AND length(sh.draft_sent) < 4000
    ORDER BY random()
    LIMIT $1
  `;
  const res = await pool.query<CorpusRow>(sql, [limit]);
  return res.rows;
}

const OLLAMA_BASE = process.env.OLLAMA_BASE_URL ?? 'http://ollama:11434';

interface OllamaChatResponse {
  message?: { content?: string };
  total_duration?: number;
  eval_count?: number;
  prompt_eval_count?: number;
}

async function ollamaChat(
  model: string,
  messages: ReadonlyArray<ChatMessage>,
): Promise<{
  content: string;
  eval_count?: number;
  prompt_eval_count?: number;
  latency_ms?: number;
}> {
  const started = Date.now();
  const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      // Force thinking off for qwen3.5 (default-on); harmless on qwen3.
      think: false,
      options: { num_ctx: 4096, temperature: 0.3 },
    }),
  });
  if (!res.ok) {
    throw new Error(`ollama /api/chat ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = (await res.json()) as OllamaChatResponse;
  return {
    content: data.message?.content ?? '',
    eval_count: data.eval_count,
    prompt_eval_count: data.prompt_eval_count,
    latency_ms: Date.now() - started,
  };
}

async function ollamaStop(model: string): Promise<void> {
  // POST /api/generate with `keep_alive: 0` is the documented way to release
  // a loaded model from VRAM. Ignore errors — the next call will load
  // whatever model it needs and Ollama's LRU will sort it out.
  try {
    await fetch(`${OLLAMA_BASE}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, keep_alive: 0 }),
    });
  } catch (e) {
    console.warn(`[warn] ollama stop ${model} failed (continuing):`, (e as Error).message);
  }
}

interface PerRow {
  sent_history_id: number;
  inbox_message_id: string;
  classification_category: Category;
  baseline_draft: string | null;
  candidate_draft: string | null;
  baseline_status: 'ok' | 'failed';
  candidate_status: 'ok' | 'failed';
  baseline_latency_ms: number | null;
  candidate_latency_ms: number | null;
  baseline_eval_count: number | null;
  candidate_eval_count: number | null;
  cosine_baseline_vs_gold: number | null;
  cosine_candidate_vs_gold: number | null;
  win: WinLabel;
  error?: string;
}

async function generateDraft(
  row: CorpusRow,
  model: string,
  persona: Awaited<ReturnType<typeof getPersonaContext>>,
): Promise<{ content: string; latency_ms?: number; eval_count?: number } | null> {
  const prompt = assemblePrompt({
    from_addr: row.inbox_from,
    to_addr: row.inbox_to,
    subject: row.inbox_subject,
    body_text: row.inbox_body,
    category: row.classification_category,
    confidence: row.classification_confidence,
    persona,
    // RAG/exemplar slots intentionally empty per the isolated-model-variable design.
  });
  const result = await ollamaChat(model, prompt.messages);
  if (!result.content.trim()) return null;
  return result;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.POSTGRES_URL) {
    throw new Error('POSTGRES_URL is required');
  }
  const pool = new Pool({ connectionString: process.env.POSTGRES_URL });
  try {
    console.log(`[setup] loading corpus (limit=${args.limit})…`);
    const corpus = await loadCorpus(pool, args.limit);
    console.log(`[setup] corpus rows: ${corpus.length}`);
    if (corpus.length === 0) throw new Error('corpus empty — check sent_history backfill');

    console.log('[setup] resolving persona…');
    const persona = await getPersonaContext('default');
    console.log(
      `[setup] persona.business_description=${JSON.stringify(persona.business_description ?? null)}`,
    );

    // Per-row state seeded with placeholders; phases fill in.
    const rows: PerRow[] = corpus.map((r) => ({
      sent_history_id: r.sent_history_id,
      inbox_message_id: r.inbox_message_id,
      classification_category: r.classification_category,
      baseline_draft: null,
      candidate_draft: null,
      baseline_status: 'failed',
      candidate_status: 'failed',
      baseline_latency_ms: null,
      candidate_latency_ms: null,
      baseline_eval_count: null,
      candidate_eval_count: null,
      cosine_baseline_vs_gold: null,
      cosine_candidate_vs_gold: null,
      win: 'dropout',
    }));

    // ── Phase A: baseline drafts ─────────────────────────────────────────
    console.log(`\n[phase A] generating baseline drafts with ${args.baseline}`);
    for (let i = 0; i < corpus.length; i++) {
      const row = corpus[i];
      try {
        const r = await generateDraft(row, args.baseline, persona);
        if (r) {
          rows[i].baseline_draft = r.content;
          rows[i].baseline_status = 'ok';
          rows[i].baseline_latency_ms = r.latency_ms ?? null;
          rows[i].baseline_eval_count = r.eval_count ?? null;
        }
      } catch (e) {
        rows[i].error = `baseline: ${(e as Error).message}`;
        console.warn(`[phase A] row ${row.sent_history_id} failed: ${(e as Error).message}`);
      }
      if ((i + 1) % 10 === 0) console.log(`[phase A] ${i + 1}/${corpus.length}`);
    }
    await ollamaStop(args.baseline);

    // ── Phase B: candidate drafts ────────────────────────────────────────
    console.log(`\n[phase B] generating candidate drafts with ${args.candidate}`);
    for (let i = 0; i < corpus.length; i++) {
      const row = corpus[i];
      try {
        const r = await generateDraft(row, args.candidate, persona);
        if (r) {
          rows[i].candidate_draft = r.content;
          rows[i].candidate_status = 'ok';
          rows[i].candidate_latency_ms = r.latency_ms ?? null;
          rows[i].candidate_eval_count = r.eval_count ?? null;
        }
      } catch (e) {
        rows[i].error =
          `${rows[i].error ? `${rows[i].error} | ` : ''}candidate: ${(e as Error).message}`;
        console.warn(`[phase B] row ${row.sent_history_id} failed: ${(e as Error).message}`);
      }
      if ((i + 1) % 10 === 0) console.log(`[phase B] ${i + 1}/${corpus.length}`);
    }
    await ollamaStop(args.candidate);

    // ── Phase C: embed + score ───────────────────────────────────────────
    console.log('\n[phase C] embedding + cosine scoring');
    for (let i = 0; i < corpus.length; i++) {
      const row = corpus[i];
      const baseline_text = rows[i].baseline_draft;
      const candidate_text = rows[i].candidate_draft;
      try {
        const goldVec = await embedText(row.actual_reply_body);
        if (!goldVec) {
          rows[i].error = `${rows[i].error ? `${rows[i].error} | ` : ''}embed-gold: returned null`;
          continue;
        }
        if (baseline_text) {
          const v = await embedText(baseline_text);
          if (v) rows[i].cosine_baseline_vs_gold = Number(cosineSimilarity(v, goldVec).toFixed(4));
        }
        if (candidate_text) {
          const v = await embedText(candidate_text);
          if (v) rows[i].cosine_candidate_vs_gold = Number(cosineSimilarity(v, goldVec).toFixed(4));
        }
      } catch (e) {
        rows[i].error =
          `${rows[i].error ? `${rows[i].error} | ` : ''}embed: ${(e as Error).message}`;
      }
      rows[i].win = classifyWin({
        baseline: rows[i].cosine_baseline_vs_gold,
        candidate: rows[i].cosine_candidate_vs_gold,
      });
      if ((i + 1) % 10 === 0) console.log(`[phase C] ${i + 1}/${corpus.length}`);
    }

    // ── Aggregate + write ────────────────────────────────────────────────
    const summary = aggregate(
      rows.map((r) => ({
        baseline: r.cosine_baseline_vs_gold,
        candidate: r.cosine_candidate_vs_gold,
      })),
    );

    const outDir = path.resolve(args.output_dir);
    await mkdir(outDir, { recursive: true });
    const outPath = path.join(outDir, `local-model-cosine-${args.run_tag}.json`);
    const output = {
      run_tag: args.run_tag,
      baseline_model: args.baseline,
      candidate_model: args.candidate,
      ollama_base: OLLAMA_BASE,
      generated_at: new Date().toISOString(),
      summary,
      rows,
    };
    await writeFile(outPath, JSON.stringify(output, null, 2));
    console.log(`\n[done] wrote ${outPath}`);
    console.log('\n=== SUMMARY ===');
    console.table([
      {
        rows: summary.scored_rows,
        dropouts: summary.dropouts,
        baseline_mean: summary.baseline_mean,
        candidate_mean: summary.candidate_mean,
        delta: summary.mean_delta,
        candidate_wins: summary.candidate_wins,
        baseline_wins: summary.baseline_wins,
        ties: summary.ties,
        candidate_win_pct: `${summary.candidate_win_pct}%`,
      },
    ]);
  } finally {
    await pool.end();
  }
}

// Only run when invoked directly (not when imported by tests).
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname;
if (invokedDirectly) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
