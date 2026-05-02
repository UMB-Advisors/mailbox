// Canonical drafting prompt for MailBOX Zero (D-41).
//
// Single source of truth for both the local Qwen3 path and the Ollama Cloud
// escalation path. Consumed by the n8n 04-draft-sub workflow at runtime via
// POST /api/internal/draft-prompt. Keep this file diff-friendly — n8n cannot
// inline-edit the prompt.
//
// 02-07 cloud-path pivot (2026-04-30): both endpoints speak the Ollama
// /api/chat schema, so the same `messages` array works for either. Routing
// from category → endpoint+model lives in ./router.ts.

import type { Category } from '@/lib/classification/prompt';
import { CATEGORY_DESCRIPTIONS } from '@/lib/classification/prompt';
import type { PersonaContext } from './persona';

export const DRAFT_LOCAL_MODEL = 'qwen3:4b-ctx4k';
// Default Ollama Cloud escalation model. Swappable via OLLAMA_CLOUD_MODEL env.
export const DRAFT_CLOUD_MODEL_DEFAULT = 'gpt-oss:120b';
// Anthropic alt-cloud config-ready (not wired tonight; see `cost.ts` PRICING).
export const DRAFT_ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface DraftPromptInput {
  // Denormalized fields from mailbox.drafts (populated at classify-time per
  // migration 003).
  from_addr: string;
  to_addr: string;
  subject: string;
  body_text: string;
  // Classification outcome.
  category: Category;
  confidence: number;
  // Persona — stubbed today; 02-06 fills the real fields without changing
  // this signature (D-41 anti-drift).
  persona: PersonaContext;
  // Optional future hooks. 02-05 (RAG) and 02-06 (full persona) fill these.
  thread_context?: ReadonlyArray<{ from_addr: string; body_text: string }>;
  rag_refs?: ReadonlyArray<{ source: string; excerpt: string }>;
  // STAQPRO-148 — operator-uploaded knowledge base snippets. Rendered as a
  // distinct prompt section ("Reference snippets from your knowledge base")
  // so the LLM treats them as authoritative policy content, not
  // conversational context. Same {source, excerpt} contract as rag_refs.
  kb_refs?: ReadonlyArray<{ source: string; excerpt: string }>;
}

// D-45 egress allowlist: when the assembled prompt is sent to a non-local
// endpoint (Ollama Cloud, Anthropic), only the fields below leave the
// appliance. The TypeScript return type is the contract — adding a field
// requires a deliberate edit to this interface.
export interface AssembledPrompt {
  messages: ReadonlyArray<ChatMessage>;
  // Soft cap to keep responses concise. Customers can tune later.
  max_tokens: number;
  // Temperature tuned for voice variation while preserving fidelity. Higher
  // than the classifier (which is 0 for reproducibility).
  temperature: number;
}

const MAX_BODY_CHARS = 6000;
const MAX_THREAD_CHARS = 2000;

export function buildSystemPrompt(persona: PersonaContext): string {
  // Lean on the operator's voice. The `category` rules sit in the user prompt
  // because they're per-message; the system prompt is per-operator.
  //
  // The placeholder block is intentionally explicit + example-driven. The
  // 4B local model follows abstract instructions only ~50% of the time but
  // mimics concrete examples reliably. Worth the extra prompt tokens.
  const tone = persona.tone ?? 'concise, direct, warm';
  const signoff = persona.signoff ?? `— ${persona.operator_first_name ?? 'the operator'}`;
  return [
    `You are an email assistant for a small CPG brand operator (${persona.operator_first_name ?? 'the operator'}, ${persona.operator_brand ?? 'their brand'}).`,
    `You draft replies in their voice: ${tone}.`,
    `You are NOT a chatbot. The operator reviews every draft before it sends, so be specific, useful, and short.`,
    `Sign off with: ${signoff}`,
    `Never mention that you are an AI.`,
    '',
    'CRITICAL — when you do not know a fact, leave a bracketed placeholder.',
    'Do not invent prices, minimums, lead times, capabilities, or commitments.',
    'Use [confirm with operator: <what to confirm>] inline. Examples:',
    '',
    '  ✗ BAD:  "Our minimum order is 5,000 units and pricing starts at $1.20/unit."',
    '  ✓ GOOD: "Our minimum is [confirm with operator: MOQ for this product] and',
    '          pricing depends on volume — happy to share once we know your spec."',
    '',
    '  ✗ BAD:  "We will ship a replacement shipment today."',
    '  ✓ GOOD: "I will get a replacement shipment moving — [confirm with operator:',
    '          ship date once warehouse confirms]."',
    '',
    '  ✗ BAD:  "Our lead time is 3 weeks."  (when not stated by the customer)',
    '  ✓ GOOD: "Lead time is [confirm with operator: current production calendar]."',
    '',
    'If the customer gave you the fact in their email (e.g. "3-week lead time works for us"),',
    'restate it instead of using a placeholder — that is confirmation, not invention.',
  ].join('\n');
}

function categoryHint(category: Category, confidence: number): string {
  const desc = CATEGORY_DESCRIPTIONS[category];
  const conf = (confidence * 100).toFixed(0);
  return `Classification: ${category} (${conf}% confidence) — ${desc}`;
}

function threadBlock(input: DraftPromptInput): string {
  if (!input.thread_context || input.thread_context.length === 0) return '';
  // Truncate to keep within ctx budget.
  let used = 0;
  const lines: string[] = ['', '## Prior thread context'];
  for (const msg of input.thread_context) {
    const block = `From: ${msg.from_addr}\n${(msg.body_text ?? '').slice(0, 800)}`;
    if (used + block.length > MAX_THREAD_CHARS) break;
    lines.push(block, '---');
    used += block.length;
  }
  return lines.join('\n');
}

function ragBlock(input: DraftPromptInput): string {
  if (!input.rag_refs || input.rag_refs.length === 0) return '';
  const lines: string[] = ['', '## Reference snippets (use only if relevant)'];
  for (const ref of input.rag_refs.slice(0, 3)) {
    lines.push(`[${ref.source}] ${ref.excerpt.slice(0, 600)}`);
  }
  return lines.join('\n');
}

// STAQPRO-148 — KB block. Distinct from ragBlock (which is conversational
// email-history context) — KB content is authoritative policy/SOP that the
// LLM should defer to over its priors. Section header explicitly says
// "your knowledge base" so the LLM weights these as ground truth.
function kbBlock(input: DraftPromptInput): string {
  if (!input.kb_refs || input.kb_refs.length === 0) return '';
  const lines: string[] = ['', '## Reference snippets from your knowledge base'];
  for (const ref of input.kb_refs.slice(0, 3)) {
    lines.push(`[${ref.source}] ${ref.excerpt.slice(0, 800)}`);
  }
  return lines.join('\n');
}

export function buildUserPrompt(input: DraftPromptInput): string {
  const safeBody = (input.body_text ?? '').slice(0, MAX_BODY_CHARS);
  return [
    // /no_think — Qwen3 directive that suppresses <think>...</think> blocks
    // in the response. Cloud models (gpt-oss, etc.) don't recognize it and
    // will ignore the leading line. normalizeDraftBody() strips any residual
    // blocks defensively.
    '/no_think',
    categoryHint(input.category, input.confidence),
    '',
    "Draft a reply to this email. Match the operator's voice from the system prompt.",
    '',
    '## Inbound email',
    `From: ${input.from_addr}`,
    `To: ${input.to_addr}`,
    `Subject: ${input.subject}`,
    '',
    safeBody,
    threadBlock(input),
    ragBlock(input),
    kbBlock(input),
    '',
    '## Output format',
    'Return ONLY the body of the reply email. No subject line, no headers, no quoted original. Plain text only.',
  ]
    .filter((line) => line !== null && line !== undefined)
    .join('\n');
}

// Assemble the final messages payload. This is the function that crosses the
// egress boundary (D-45) — its return type defines what's allowed to leave.
export function assemblePrompt(input: DraftPromptInput): AssembledPrompt {
  const messages: ReadonlyArray<ChatMessage> = [
    { role: 'system', content: buildSystemPrompt(input.persona) },
    { role: 'user', content: buildUserPrompt(input) },
  ];
  return {
    messages,
    max_tokens: 600,
    // 0.7 = enough variation to avoid robot-feel; low enough to stay grounded.
    temperature: 0.7,
  };
}
