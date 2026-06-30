// Canonical Qwen3 classification prompt.
// Single source of truth (D-29). Consumed by:
//   - n8n classify sub-workflow via GET /api/internal/classification-prompt
//   - scripts/heron-labs-score.mjs (imports this module directly)
// Keep this file diff-friendly — n8n cannot inline-edit the prompt.

// Single runtime source of truth for the classification enum (Spec 002 FR1,
// Stage 2a). The UNION of the 8 legacy coarse values (kept valid during the
// transition — historical rows are display-mapped, not re-classified, per FR2)
// and the full design taxonomy from seed/buckets.yaml. lib/types.ts
// ClassificationCategory is pinned to this set at compile time, and
// test/schema-invariants.test.ts pins migration 048's CHECK lists to it — so the
// dual-source drift that caused the original mis-sorts now fails CI.
export const CATEGORIES = [
  // --- legacy coarse (transition; a later migration drops these) ---
  'inquiry',
  'reorder',
  'scheduling',
  'follow_up',
  'internal',
  'spam_marketing',
  'escalate',
  'unknown',
  // --- design taxonomy (seed/buckets.yaml) ---
  'client_request',
  'proposal_request',
  'sales_lead',
  'meeting_invite',
  'meeting_notes',
  'receipt',
  'marketplace_notification',
  'marketing_promo',
  'vendor_partner',
  'finance_legal',
  'admin_account',
  'invoice_payable',
  'contract_legal',
  'notification',
  'spam',
] as const;

export type Category = (typeof CATEGORIES)[number];

export const MODEL_VERSION = 'qwen3:4b-ctx4k';

export const CATEGORY_DESCRIPTIONS: Record<Category, string> = {
  // legacy coarse (transition — prefer the design buckets below going forward)
  inquiry:
    'Coarse/legacy: first-touch question from a prospect or customer. Prefer client_request or sales_lead.',
  reorder:
    'Coarse/legacy: existing customer placing or asking about a repeat order, restock, PO. Maps to client_request.',
  scheduling: 'Meeting, call, visit, or calendar logistics.',
  follow_up:
    'Coarse/legacy state: continuation of a prior thread already engaged in. Reclassify to its real bucket.',
  internal:
    'Team/colleague mail on the operator domain — internal coordination, bid replies, action items.',
  spam_marketing: 'Coarse/legacy: split into spam (unwanted) and marketing_promo (opted-in bulk).',
  escalate:
    'Urgent / action-needed / money / deadline: payment failed, account suspension, tax/filing due, legal, breach, or a commerce return/refund/dispute. Real human escalations too.',
  unknown: 'Cannot be confidently placed in any other category.',
  // design taxonomy (seed/buckets.yaml)
  client_request: 'Request or inquiry from an existing client/customer (the priority queue).',
  proposal_request: 'A request for a proposal or formal quote (enters the proposal flow).',
  sales_lead: 'New prospect / win-the-job opportunity (e.g. Reverb buyers).',
  meeting_invite: 'Calendar invite to accept, decline, or propose a new time.',
  meeting_notes: 'Meeting recap / notes (Gemini/Fathom/Otter etc.) — a source of action items.',
  receipt: 'Receipt, shipping, or payment confirmation (already paid; track only).',
  marketplace_notification:
    'A real offer/message/activity on a marketplace (e.g. an offer on a listing).',
  marketing_promo:
    'Promotional / bulk marketing email — newsletters, vendor blasts, campaigns (opted-in).',
  vendor_partner: 'Mail from a vendor or business partner.',
  finance_legal:
    'Finance / accounting / banking / tax / govt-compliance (e.g. Chase, CO Revenue, FAMLI).',
  admin_account:
    'Admin / account / employee / tax notices (e.g. 1Password, Google account, payroll admin).',
  invoice_payable: 'An invoice or bill you owe (finance action; distinct from a paid receipt).',
  contract_legal: 'Contract, agreement, NDA, or legal document to review or sign.',
  notification:
    'Automated software/system alert (sign-in, "payroll ran", shipping). Collapses to FYI unless it matches an escalation signal; a review subtype stays surfaced.',
  spam: 'Unwanted / unsolicited mail (trainable spam bucket).',
};

export interface ClassifierInput {
  from: string;
  subject: string;
  body: string;
}

// /no_think directive per D-05 — keeps classification under p95 5s (MAIL-06).
// Fallback to `unknown` on parse failure is enforced in normalize.ts (D-06).
//
// `businessFraming` is the operator-business descriptor — populated during
// onboarding via the persona resolver and forwarded by the route handler.
// Empty / unset → falls back to a generic "small business operator" framing
// (CPG-scrub Phase 1, 2026-05-08; replaces the prior hardcoded "small CPG
// brand operator" anchor that biased Qwen3 against non-CPG mail on M2).
//
// `senderPrior` (Spec 002 FR7, Stage 2b-1) is the suggested bucket from a
// `bias`-mode Train sender-rule (lib/classification/sender-rules.ts). It is a
// PRIOR the model reconciles, NOT a bypass — injected as a single hint line so
// the content can still override it (the MBOX-370 multi-intent fix). `force`-mode
// rules never reach here; they short-circuit the LLM upstream.
//
// `exemplars` (Spec 002 FR7b, Stage 2b-2) are labeled (snippet → bucket) few-shot
// demonstrations — the operator's prior corrections — rendered so the model can match
// lookalike mail from new senders. The CALLER does the retrieval, ranking, and
// CAP (lib/classification/exemplars.ts:retrieveClassificationExemplars protects
// the qwen3:4b ctx4k window); buildPrompt only RENDERS what it is handed. The
// rendering is a pure function (renderExemplarSection) so the injection contract
// is unit-testable in isolation.

// A minimal exemplar shape for the prompt — kept local so prompt.ts has no
// import cycle with lib/classification/exemplars.ts (which imports Category
// from here). ClassificationExemplar structurally satisfies this.
export interface ExemplarForPrompt {
  snippet: string;
  bucket: Category;
}

// Per-exemplar snippet cap in the rendered prompt — a second guard (on top of
// the caller's count CAP) so one long snippet can't blow the ctx4k window.
const EXEMPLAR_SNIPPET_CHARS = 240;

/**
 * PURE render of the few-shot block: labeled (snippet → bucket) examples the
 * model matches new mail against. Empty input → '' (prompt unchanged — the
 * description-only fallback). Exported for direct unit testing of the injection
 * contract.
 */
export function renderExemplarSection(exemplars?: ReadonlyArray<ExemplarForPrompt>): string {
  if (!exemplars || exemplars.length === 0) return '';
  const lines = exemplars
    .map((ex, i) => {
      const snip = ex.snippet.replace(/\s+/g, ' ').trim().slice(0, EXEMPLAR_SNIPPET_CHARS);
      return `${i + 1}. [${ex.bucket}] ${snip}`;
    })
    .join('\n');
  return `\nExamples — past mail labeled with its correct category; match the email below to the closest:\n${lines}\n`;
}

export function buildPrompt(
  input: ClassifierInput,
  businessFraming?: string,
  senderPrior?: Category,
  exemplars?: ReadonlyArray<ExemplarForPrompt>,
): string {
  const catLines = CATEGORIES.map((c) => `  - ${c}: ${CATEGORY_DESCRIPTIONS[c]}`).join('\n');

  const safeBody = (input.body ?? '').slice(0, 4000);

  const framing = (businessFraming ?? '').trim() || 'a small business operator';

  const priorLine = senderPrior
    ? `\nPrior: messages from this sender are usually "${senderPrior}". Treat this as a hint, not a rule — if the content clearly indicates a different category, classify by the content.\n`
    : '';

  const exemplarSection = renderExemplarSection(exemplars);

  return `/no_think
You are an email classifier for ${framing}.
Classify the email into exactly one of these ${CATEGORIES.length} categories:

${catLines}

Output a single JSON object and nothing else:
{"category": "<one of the ${CATEGORIES.length}>", "confidence": <number from 0 to 1>}

Rules:
- "category" must be one of: ${CATEGORIES.join(', ')}.
- "confidence" reflects how sure you are (0.0 = guessing, 1.0 = certain).
- If unsure, use "unknown" with low confidence rather than guessing.
- No prose, no markdown, no explanations — JSON only.
${priorLine}${exemplarSection}
Email:
From: ${input.from ?? ''}
Subject: ${input.subject ?? ''}
Body:
${safeBody}
`;
}

// Routing rule per D-01 / D-02. Pure function; n8n IF node mirrors this logic
// (D-30). Exposed here so scripts/scoring/dashboard diagnostics can evaluate
// the same routing without re-implementing it.
//
// 2026-05-01 retune: 'inquiry' moved local — Eric's "do as much as we can
// with a local model" call. The 3-way eval (Qwen3 vs gpt-oss:120b vs Haiku)
// showed Qwen3's "vague defer" on inquiry is actually preferred over
// gpt-oss's hallucinated pricing template. The strengthened persona prompt
// (with explicit [confirm with operator] examples) closes the gap further.
// Confidence floor still kicks low-confidence drafts to cloud as the safety
// net.
export const LOCAL_CONFIDENCE_FLOOR = 0.75;
export const LOCAL_CATEGORIES: ReadonlyArray<Category> = [
  'reorder',
  'scheduling',
  'follow_up',
  'internal',
  'inquiry',
];
export const CLOUD_CATEGORIES: ReadonlyArray<Category> = ['escalate', 'unknown'];

export type Route = 'local' | 'cloud' | 'drop';

export function routeFor(category: Category, confidence: number): Route {
  if (category === 'spam_marketing') return 'drop';
  if (confidence < LOCAL_CONFIDENCE_FLOOR) return 'cloud';
  if (LOCAL_CATEGORIES.includes(category)) return 'local';
  return 'cloud';
}

// STAQPRO-331 #3 — explanation for why a draft took its route. Operator-facing
// in the DraftDetail RoutingBadge; lets the reviewer distinguish "model was
// confident, took the normal path" from "fell back to cloud as a safety net."
// Pure derivation from existing columns (no new schema). Returns null when
// classification metadata is missing or the source is a legacy
// `local_qwen3` / `cloud_haiku` value the live drafter no longer writes.
export type RoutingReason =
  | 'local_category'
  | 'cloud_category'
  | 'cloud_low_confidence'
  | 'unknown';

export function routingReasonFor(
  source: 'local' | 'cloud' | 'local_qwen3' | 'cloud_haiku',
  category: Category | null,
  confidence: number | null,
): RoutingReason {
  if (source !== 'local' && source !== 'cloud') return 'unknown';
  if (category == null) return 'unknown';
  if (source === 'local') {
    return LOCAL_CATEGORIES.includes(category) ? 'local_category' : 'unknown';
  }
  // source === 'cloud'
  if (confidence != null && confidence < LOCAL_CONFIDENCE_FLOOR) {
    return 'cloud_low_confidence';
  }
  if (CLOUD_CATEGORIES.includes(category)) return 'cloud_category';
  return 'unknown';
}
