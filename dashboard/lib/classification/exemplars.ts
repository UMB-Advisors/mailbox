// Spec 002 FR7b (Stage 2b-2) — classifier few-shot exemplars: retrieval + pure
// top-K selection for the prompt's (snippet → bucket) demonstration block.
//
// Mirrors the DRAFTING exemplar surface (lib/drafting/exemplars.ts auto-mined
// from sent_history; persona.category_exemplars hand-curated; audited via
// drafts.exemplar_refs) rather than inventing a new mechanism — plan §2b:
// "Reuse this pattern for classifier few-shot — do not invent a new one."
//
// Two halves, deliberately split so the classify path stays Postgres-free and
// unit-testable:
//   1. selectExemplars(candidates, opts)  — PURE. Ranks + caps a candidate list.
//      The injection input. Tested directly with no DB.
//   2. retrieveClassificationExemplars(opts) — the live wrapper: lists recent
//      enabled rows (optionally biased toward the senderPrior bucket), runs
//      selectExemplars, and FAILS CLOSED to [] on any DB error (a Postgres
//      hiccup degrades to a description-only prompt, never throws). This is the
//      `exemplarLookup` dep classify-one injects.
//
// RETRIEVAL IS DELIBERATELY SIMPLE + DB-LIGHT (plan "Few-shot latency" risk):
// top-K by keyword/recency relevance with a hard CAP to protect the qwen3:4b
// ctx4k window. NO embeddings yet.
// TODO(future): embedding-ranked retrieval (nomic-embed-text, the same model
// RAG uses) for semantic lookalike matching — ranked by cosine vs the inbound
// snippet instead of keyword overlap. Out of scope for 2b-2 (keep DB-light;
// don't add a vector dependency to the classify hot path until measured).

import {
  type ClassificationExemplarRow,
  listClassificationExemplars,
} from '@/lib/queries-classification-exemplars';
import type { Category } from './prompt';

export interface ClassificationExemplar {
  // The labeled example text (subject + body excerpt). Rendered as the
  // demonstration the model matches new mail against.
  snippet: string;
  // The bucket this exemplar demonstrates.
  bucket: Category;
  // Optional provenance — the corrected message id this was minted from.
  source_msg_id?: string | null;
  // Optional recency tiebreaker (ISO-8601). Candidates arrive recent-first.
  created_at?: string;
}

// Hard cap on injected exemplars — protects the qwen3:4b ctx4k window
// (FR7 open question / plan "Few-shot latency"). 6–10 is the safe band; default
// 8. Env override CLASSIFY_FEWSHOT_CAP; a bad/blank value falls back to 8 and a
// value ≤ 0 disables few-shot entirely.
export const DEFAULT_EXEMPLAR_CAP = 8;
const HARD_MAX_EXEMPLAR_CAP = 10;

export function exemplarCap(): number {
  const raw = process.env.CLASSIFY_FEWSHOT_CAP;
  if (raw == null || raw.trim() === '') return DEFAULT_EXEMPLAR_CAP;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_EXEMPLAR_CAP;
  if (n <= 0) return 0;
  return Math.min(Math.floor(n), HARD_MAX_EXEMPLAR_CAP);
}

// Cheap keyword tokens — lowercased word stems ≥ 3 chars, deduped. Used for the
// subject-overlap relevance signal (no embeddings).
function tokens(text: string | null | undefined): Set<string> {
  if (!text) return new Set();
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3),
  );
}

function overlapScore(a: Set<string>, bText: string): number {
  if (a.size === 0) return 0;
  const b = tokens(bText);
  let n = 0;
  for (const t of a) if (b.has(t)) n += 1;
  return n;
}

/**
 * PURE top-K selection. Ranks candidates by, in order:
 *   1. senderPrior match — an exemplar whose bucket equals the bias-rule prior
 *      ranks first (it's the bucket we're nudging toward).
 *   2. keyword overlap with the inbound subject (cheap relevance, no embeddings).
 *   3. recency — candidates are assumed pre-sorted recent-first; the sort is
 *      STABLE so equal-score ties keep that order.
 * Caps at `cap` (default exemplarCap()). cap ≤ 0 → []. Never throws; never reads
 * the DB. This is the function the injection contract is tested against.
 */
export function selectExemplars(
  candidates: ReadonlyArray<ClassificationExemplar>,
  opts: { senderPrior?: Category; subject?: string | null; cap?: number } = {},
): ClassificationExemplar[] {
  const cap = opts.cap ?? exemplarCap();
  if (cap <= 0 || candidates.length === 0) return [];

  const subjectTokens = tokens(opts.subject);
  const scored = candidates.map((ex, i) => ({
    ex,
    i, // original index — preserves recent-first order as the final tiebreaker
    priorMatch: opts.senderPrior != null && ex.bucket === opts.senderPrior ? 1 : 0,
    overlap: overlapScore(subjectTokens, ex.snippet),
  }));

  scored.sort((a, b) => {
    if (a.priorMatch !== b.priorMatch) return b.priorMatch - a.priorMatch;
    if (a.overlap !== b.overlap) return b.overlap - a.overlap;
    return a.i - b.i; // stable: keep recent-first
  });

  return scored.slice(0, cap).map((s) => s.ex);
}

function rowToExemplar(r: ClassificationExemplarRow): ClassificationExemplar {
  return {
    snippet: r.snippet,
    bucket: r.bucket as Category,
    source_msg_id: r.source_msg_id,
    created_at: r.created_at,
  };
}

/**
 * Live retrieval: list recent enabled exemplars (biased toward the senderPrior
 * bucket when one is supplied — we over-fetch a small window, then selectExemplars
 * re-ranks across buckets so a strong subject-overlap example in another bucket
 * can still surface), then cap. FAILS CLOSED to [] on any error so the classify
 * path degrades to a description-only prompt rather than throwing. This is the
 * `exemplarLookup` dep classify-one injects on the live (sweeper) path.
 */
export async function retrieveClassificationExemplars(opts: {
  senderPrior?: Category;
  subject?: string | null;
  account_id?: number;
}): Promise<ClassificationExemplar[]> {
  const cap = exemplarCap();
  if (cap <= 0) return [];
  try {
    // Over-fetch a bounded window (cap * 3, floored at 24) so selectExemplars has
    // something to rank — still DB-light (a single indexed LIMIT query).
    const window = Math.max(cap * 3, 24);
    const rows = await listClassificationExemplars({
      account_id: opts.account_id,
      // Bias the fetch toward the prior bucket but don't hard-filter — we want
      // cross-bucket lookalikes too, so when a prior is set we fetch BOTH the
      // prior bucket and the general recent window and let selectExemplars rank.
      preferBucket: opts.senderPrior,
      limit: window,
    });
    return selectExemplars(rows.map(rowToExemplar), {
      senderPrior: opts.senderPrior,
      subject: opts.subject,
      cap,
    });
  } catch (error) {
    console.error('[classification-exemplars] retrieval failed — degrading to no few-shot:', error);
    return [];
  }
}
