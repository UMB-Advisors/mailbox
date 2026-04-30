// Canonical Qwen3 classification prompt.
// Single source of truth (D-29). Consumed by:
//   - n8n classify sub-workflow via GET /api/internal/classification-prompt
//   - scripts/heron-labs-score.mjs (imports this module directly)
// Keep this file diff-friendly — n8n cannot inline-edit the prompt.

export const CATEGORIES = [
  'inquiry',
  'reorder',
  'scheduling',
  'follow_up',
  'internal',
  'spam_marketing',
  'escalate',
  'unknown',
] as const;

export type Category = (typeof CATEGORIES)[number];

export const MODEL_VERSION = 'qwen3:4b-ctx4k';

export const CATEGORY_DESCRIPTIONS: Record<Category, string> = {
  inquiry:
    'First-touch question from a prospect or customer (pricing, samples, product info, partnership intro).',
  reorder:
    'Existing customer placing or asking about a repeat order, restock, PO, or invoice.',
  scheduling:
    'Meeting, call, visit, sample drop, or calendar logistics.',
  follow_up:
    'Continuation of a prior thread the recipient was already engaged in.',
  internal:
    'Team-internal coordination from the operator\'s own staff/contractors with no customer or prospect being addressed in this email.',
  spam_marketing:
    'Cold solicitation, marketing newsletter, sales pitch, lead-gen blast, recruiter spam.',
  escalate:
    'Complaint, legal threat, regulatory notice, recall risk, or anything requiring human judgment.',
  unknown:
    'Cannot be confidently placed in any other category.',
};

// Operator-identity injection — fixes the catastrophic `internal` recall
// observed in MAIL-08 scoring (D-50). Without this, the model has no way to
// tell which sender domains belong to the operator.
export const OPERATOR_DOMAINS = (
  process.env.OPERATOR_DOMAINS ?? 'heronlabsinc.com,elefanteinc.com'
)
  .split(',')
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

export const OPERATOR_NAME = process.env.OPERATOR_NAME ?? 'Heron Labs';

export interface ClassifierInput {
  from: string;
  subject: string;
  body: string;
}

// /no_think directive per D-05 — keeps classification under p95 5s (MAIL-06).
// Fallback to `unknown` on parse failure is enforced in normalize.ts (D-06).
export function buildPrompt(input: ClassifierInput): string {
  const catLines = CATEGORIES.map(
    (c) => `  - ${c}: ${CATEGORY_DESCRIPTIONS[c]}`,
  ).join('\n');

  const safeBody = (input.body ?? '').slice(0, 4000);

  const domainList = OPERATOR_DOMAINS.map((d) => `@${d}`).join(', ');

  return `/no_think
You are an email classifier for ${OPERATOR_NAME}, a small CPG brand operator.
The operator's own email domains are: ${domainList}.
Classify the email into exactly one of these 8 categories:

${catLines}

Output a single JSON object and nothing else:
{"category": "<one of the 8>", "confidence": <number from 0 to 1>}

Rules:
- "category" must be one of: ${CATEGORIES.join(', ')}.
- "confidence" reflects how sure you are (0.0 = guessing, 1.0 = certain).
- Use "internal" ONLY when the sender's email domain is in [${domainList}] AND the email is internal team coordination (no customer or prospect being addressed). If a team member is replying to a customer/prospect, classify by what the THREAD is about (follow_up, scheduling, reorder, etc.) — not internal.
- If the sender domain is in [${domainList}] but the email is clearly addressed to a customer or prospect, prefer follow_up / scheduling / reorder over internal.
- If unsure, use "unknown" with low confidence rather than guessing.
- No prose, no markdown, no explanations — JSON only.

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
export const LOCAL_CONFIDENCE_FLOOR = 0.75;
export const LOCAL_CATEGORIES: ReadonlyArray<Category> = [
  'reorder',
  'scheduling',
  'follow_up',
  'internal',
];
export const CLOUD_CATEGORIES: ReadonlyArray<Category> = [
  'inquiry',
  'escalate',
  'unknown',
];

export type Route = 'local' | 'cloud' | 'drop';

export function routeFor(category: Category, confidence: number): Route {
  if (category === 'spam_marketing') return 'drop';
  if (confidence < LOCAL_CONFIDENCE_FLOOR) return 'cloud';
  if (LOCAL_CATEGORIES.includes(category)) return 'local';
  return 'cloud';
}
