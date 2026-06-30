// STAQPRO-370 — shared classify-one chain for backlog cleanup paths.
//
// Both `scripts/classify-backfill.ts` (operator one-shot, STAQPRO-368) and
// `app/api/internal/classify-sweep/route.ts` (periodic sweeper, this issue)
// need to run the exact same classify chain that `MailBOX-Classify` runs in
// the live pipeline. Until this module landed, the script reimplemented the
// chain inline. The sweeper would have done the same, duplicating the
// "prompt → ollama → normalize → log" sequence for the third time. Pull it
// out once.
//
// Scope is intentionally narrow — backlog rows that arrived via
// FetchHistory (or were missed during n8n downtime). Skipped vs the live
// chain:
//
//   - Live Gate check (`/api/onboarding/live-gate`): backlog rows predate
//     the gate's intent; we don't want one disabled appliance to leave a
//     permanent unclassified cohort.
//   - Drop-spam IF gate / Insert Draft Stub / Trigger Draft Sub: backlog
//     rows are days/weeks old; auto-drafting historical mail is a separate
//     decision (operator usually doesn't want that — see STAQPRO-368
//     scope note).
//
// Goal is exactly: restore visibility on the Classifications page + give
// RAG retrieval a `classification_category` payload to filter on. Drafts,
// gates, and sends are not the sweeper's job.
//
// The chain calls dashboard helpers directly (no HTTP hop) — this code
// runs in the dashboard container alongside the route handlers, so a
// fetch() against localhost would just be wasted latency.

import { readOllamaBaseUrl } from '@umb-advisors/llm';
import { getPersonaContext } from '@/lib/drafting/persona';
import { type EscalationSignal, promoteEscalation } from './escalation-promotion';
import type { ClassificationExemplar } from './exemplars';
import { type ClassificationResult, normalizeClassifierOutput } from './normalize';
import { buildPrompt, type Category, MODEL_VERSION } from './prompt';
import { reverbRoute } from './reverb-routing';
import { type SenderRuleHit, senderRuleAction } from './sender-rules';

export interface InboxRowForClassify {
  id: number;
  from_addr: string | null;
  to_addr: string | null;
  subject: string | null;
  body: string | null;
  snippet: string | null;
}

export interface ClassifyOneResult {
  inbox_message_id: number;
  category: ClassificationResult['category'];
  confidence: number;
  model_version: string;
  latency_ms: number;
  raw_output: string;
  json_parse_ok: boolean;
  think_stripped: boolean;
  preclass_applied: boolean;
  preclass_source: ClassificationResult['preclass_source'];
  // Spec 002 FR4 (Stage 2b-1) — escalation-promotion metadata. `category` above
  // already reflects a notification→escalate promotion; these surface WHY for the
  // audit trail / urgency badge. `important` keeps a review-subtype notification
  // surfaced in the FYI tab (not collapsed). Persisting `important` is a thin
  // future column add — the promoted `category` is what the log row carries today.
  escalation_signal?: EscalationSignal | null;
  important?: boolean;
}

export interface ClassifyOneDeps {
  /**
   * Fetch implementation — injectable for tests. Defaults to global fetch.
   */
  fetchImpl?: typeof fetch;
  /**
   * Base URL of the local Ollama runtime serving Qwen3 classification.
   * Defaults to `readOllamaBaseUrl()` (env: `OLLAMA_BASE_URL`, fallback
   * `http://ollama:11434`), matching the live `MailBOX-Classify > Call
   * Ollama` node verbatim. DR-25 cutover (llama.cpp drafting) does NOT
   * affect this URL — Ollama still serves the classifier on the live
   * appliance.
   */
  llmBaseUrl?: string;
  /**
   * MBOX-370 — sender is on the never-spam allowlist. Forwarded into the
   * normalize ctx so the heuristic suppressions (noreply / self-loop) are
   * skipped and the real category stands. Used by the reclassify-by-sender
   * re-run (where the sender is allowlisted by construction).
   */
  neverSpam?: boolean;
  /**
   * Spec 002 FR7 (Stage 2b-1) — injected Train sender-rule resolver. Keeps
   * classifyOne Postgres-free (the DB lookup lives in the injected fn) and
   * unit-testable. The live callers pass
   * `lib/classification/sender-rules.ts:senderRule` (account-scoped, fail-open,
   * kill switch SENDER_RULES_DISABLE=1). Omitted → no Train rules apply (the
   * unchanged default). A `force` hit short-circuits the LLM; a `bias` hit only
   * seeds a prompt prior the model reconciles.
   */
  senderRuleLookup?: (rawFrom: string | undefined) => Promise<SenderRuleHit | null>;
  /**
   * Spec 002 FR7b (Stage 2b-2) — injected few-shot exemplar retriever. Keeps
   * classifyOne Postgres-free (the DB read + ranking + ctx CAP live in the
   * injected fn) and unit-testable. The live callers pass
   * `lib/classification/exemplars.ts:retrieveClassificationExemplars`
   * (fail-closed → [] on any DB error; cap CLASSIFY_FEWSHOT_CAP). Omitted → no
   * few-shot (the unchanged, description-only prompt). The retriever is handed
   * the `bias`-rule prior + the inbound subject so it can bias toward the likely
   * bucket and rank by keyword relevance.
   */
  exemplarLookup?: (opts: {
    senderPrior?: Category;
    subject?: string | null;
  }) => Promise<ReadonlyArray<ClassificationExemplar>>;
}

// Mirror of the live `MailBOX-Classify > Call Ollama` body. Kept here as a
// type so the call site below stays self-documenting.
interface LocalGenerateBody {
  model: string;
  prompt: string;
  stream: false;
  format: 'json';
  think: false;
  options: { temperature: number };
}

interface LocalGenerateResponse {
  response?: string;
  thinking?: string;
}

// Compose the same framing the `POST /api/internal/classification-prompt`
// route uses. Inlined rather than HTTP'd because we already share a process
// with that route.
async function buildFramedPrompt(
  row: InboxRowForClassify,
  senderPrior?: Category,
  exemplars?: ReadonlyArray<ClassificationExemplar>,
): Promise<string> {
  // Mirrors `personaToClassifyFraming` in
  // app/api/internal/classification-prompt/route.ts. Three-layer fallback
  // (operator override → extraction-derived → hardcoded default) lives inside
  // getPersonaContext per STAQPRO-195.
  const persona = await getPersonaContext();
  const brand = persona.operator_brand?.trim() ?? '';
  const desc = persona.business_description?.trim() ?? '';
  let framing = '';
  if (desc && brand && brand !== "the operator's business") {
    framing = `${brand} — ${desc}`;
  } else if (desc) {
    framing = desc;
  }
  return buildPrompt(
    {
      from: row.from_addr ?? '',
      subject: row.subject ?? '',
      body: row.body ?? row.snippet ?? '',
    },
    framing,
    // Spec 002 FR7 (Stage 2b-1): a `bias` Train rule's suggested bucket, injected
    // as a prior the model reconciles (undefined → no hint, unchanged prompt).
    senderPrior,
    // Spec 002 FR7b (Stage 2b-2): retrieved + capped few-shot exemplars (empty →
    // unchanged prompt). The retrieval/rank/CAP happened in the injected dep.
    exemplars,
  );
}

/**
 * Run the classify chain for one inbox row. Pure function over the supplied
 * row + deps — does NOT touch Postgres. The caller is responsible for
 * writing the resulting row to `mailbox.classification_log` (so callers can
 * batch the writes inside their own transaction if they want).
 *
 * Throws on infra failure (LLM call non-200, malformed JSON output of the
 * pipeline itself). The caller decides whether to swallow the error and
 * keep processing or abort the batch.
 */
export async function classifyOne(
  row: InboxRowForClassify,
  deps: ClassifyOneDeps = {},
): Promise<ClassifyOneResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const baseUrl = deps.llmBaseUrl ?? readOllamaBaseUrl();

  // Spec 002 FR7 (Stage 2b-1) — Train sender-rule resolution (injected; fail-open
  // inside the resolver). `force` hard-routes BEFORE the LLM (single-purpose
  // automated senders only — highest precedence, like the reverted MBOX-368
  // override BUT only for force-mode rows). `bias` does NOT short-circuit — it
  // becomes a prompt prior the model reconciles (the multi-intent-safe path).
  const ruleHit = deps.senderRuleLookup
    ? await deps.senderRuleLookup(row.from_addr ?? undefined)
    : null;
  const action = senderRuleAction(ruleHit);
  if (action.kind === 'force') {
    return {
      inbox_message_id: row.id,
      category: action.category,
      confidence: 1,
      model_version: MODEL_VERSION,
      latency_ms: 0,
      raw_output: '',
      json_parse_ok: true,
      think_stripped: false,
      preclass_applied: true,
      preclass_source: 'sender-rule-force',
      escalation_signal: null,
      important: false,
    };
  }
  // Spec 002 FR7 (Stage 2b-2) — Reverb subject routing (the multi-intent case
  // 2b-1 deferred). Reverb sends 4 message types from one domain, so it is NEVER
  // a single `force` sender rule (the MBOX-370 lesson); instead a PURE content
  // matcher hard-routes the templated subjects ("Message about…"→sales_lead,
  // payout→receipt, feed/saved-search→marketing_promo, offer→
  // marketplace_notification). A non-matching Reverb subject returns null and
  // falls through to the LLM. Runs after `force` (no Reverb force rule exists)
  // and BEFORE the bias prior + LLM — a deterministic templated subject beats a
  // soft prior. Kill switch REVERB_ROUTING_DISABLE=1.
  if (process.env.REVERB_ROUTING_DISABLE !== '1') {
    const reverbBucket = reverbRoute(row.from_addr ?? undefined, row.subject);
    if (reverbBucket) {
      return {
        inbox_message_id: row.id,
        category: reverbBucket,
        confidence: 1,
        model_version: MODEL_VERSION,
        latency_ms: 0,
        raw_output: '',
        json_parse_ok: true,
        think_stripped: false,
        preclass_applied: true,
        preclass_source: 'reverb-subject',
        escalation_signal: null,
        important: false,
      };
    }
  }

  const senderPrior = action.kind === 'bias' ? action.prior : undefined;

  // Spec 002 FR7b (Stage 2b-2) — retrieve few-shot exemplars (injected; the DB
  // read + rank + ctx CAP live in the dep, fail-closed → []). Handed the bias
  // prior + subject so it can bias toward the likely bucket. Omitted dep → [].
  const exemplars = deps.exemplarLookup
    ? await deps.exemplarLookup({ senderPrior, subject: row.subject })
    : [];

  const prompt = await buildFramedPrompt(row, senderPrior, exemplars);

  const body: LocalGenerateBody = {
    model: MODEL_VERSION,
    prompt,
    stream: false,
    format: 'json',
    // Mirrors the n8n `Call Ollama` body + the live classify route + the
    // STAQPRO-240 fix. On Ollama < 0.21 the field is ignored (M1
    // historical); on 0.23+ (M2 + M1 post-2026-05-08 unify) it disables
    // Qwen3 thinking-mode.
    think: false,
    options: { temperature: 0 },
  };

  const t0 = Date.now();
  const res = await fetchImpl(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`local LLM /api/generate -> HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as LocalGenerateResponse;
  const latency_ms = Date.now() - t0;

  // Defensive: if a future runtime revives thinking-mode despite think:false,
  // fall back to the thinking field. Same shape as the n8n Normalize node's
  // `$json.response || $json.thinking || ''`.
  const rawOutput = json.response ?? json.thinking ?? '';

  const normalized = normalizeClassifierOutput(rawOutput, {
    from: row.from_addr ?? undefined,
    to: row.to_addr ?? undefined,
    neverSpam: deps.neverSpam,
  });

  // Spec 002 FR4 (Stage 2b-1) — escalation-promotion post-classify step. A
  // `notification` matching an escalation_signal is promoted to `escalate`; a
  // `notification` with a review subtype stays `notification` but flagged
  // important. Pure + deterministic; only touches notification verdicts. Kill
  // switch ESCALATION_PROMOTE_DISABLE=1 reverts to the raw verdict.
  const promoted =
    process.env.ESCALATION_PROMOTE_DISABLE === '1'
      ? null
      : promoteEscalation({
          category: normalized.category,
          subject: row.subject,
          body: row.body ?? row.snippet,
        });

  return {
    inbox_message_id: row.id,
    category: promoted?.category ?? normalized.category,
    confidence: normalized.confidence,
    model_version: MODEL_VERSION,
    latency_ms,
    raw_output: normalized.raw_output,
    json_parse_ok: normalized.json_parse_ok,
    think_stripped: normalized.think_stripped,
    preclass_applied: normalized.preclass_applied,
    preclass_source: normalized.preclass_source,
    escalation_signal: promoted?.escalation_signal ?? null,
    important: promoted?.important ?? false,
  };
}
