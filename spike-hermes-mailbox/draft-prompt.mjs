// Control-arm (A) prompt builder for the Hermes spike A/B.
//
// MIRRORS dashboard/lib/drafting/prompt.ts (assemblePrompt) — the canonical
// MailBOX drafting prompt. Kept as a zero-dependency .mjs copy so the harness
// runs on a bare bench box without the dashboard's TS toolchain / @/ alias /
// DB import chain.
//
// !! SOURCE OF TRUTH is dashboard/lib/drafting/prompt.ts. If that file changes,
//    re-sync this mirror (diff the buildSystemPrompt / buildUserPrompt bodies)
//    or the control arm stops representing real MailBOX behavior.
//
// Arm B (Hermes) gets the SAME inbound + the SAME persona-derived instruction
// via 22-run-ab.mjs, so the A/B isolates Hermes' context/skill contribution,
// not a prompt difference.

const MAX_BODY_CHARS = 6000;
const MAX_THREAD_CHARS = 2000;
const RAG_REFS_CAP_DEFAULT = 3;
const RAG_REFS_CAP_WHEN_EXEMPLARS = 2;

// Minimal mirror of CATEGORY_DESCRIPTIONS used by categoryHint(). Keep aligned
// with dashboard/lib/classification/prompt.ts.
const CATEGORY_DESCRIPTIONS = {
  inquiry: 'a question or request for information',
  reorder: 'an existing customer reordering or asking about an order',
  scheduling: 'a request to schedule, reschedule, or confirm a meeting/call',
  follow_up: 'a follow-up on a prior thread',
  internal: 'internal / operator-domain correspondence',
  escalate: 'something that needs the operator personally / is sensitive',
  spam_marketing: 'unsolicited marketing or spam',
  unknown: 'could not be confidently classified',
};

export function buildSystemPrompt(persona = {}) {
  const tone = persona.tone ?? 'concise, direct, warm';
  const signoff = persona.signoff ?? `— ${persona.operator_first_name ?? 'the operator'}`;
  const operatorName = persona.operator_first_name?.trim() || 'the operator';
  const operatorBrand = persona.operator_brand?.trim() || "the operator's business";
  const businessDesc = persona.business_description?.trim();
  const businessFraming = businessDesc
    ? `${operatorName} at ${operatorBrand} — a ${businessDesc}`
    : `${operatorName}, ${operatorBrand}`;
  return [
    `You are an email assistant for ${businessFraming}.`,
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
    'If the customer gave you the fact in their email, restate it instead of using a',
    'placeholder — that is confirmation, not invention.',
  ].join('\n');
}

function categoryHint(category, confidence) {
  const desc = CATEGORY_DESCRIPTIONS[category] ?? 'an email';
  const conf = (Number(confidence ?? 0) * 100).toFixed(0);
  return `Classification: ${category} (${conf}% confidence) — ${desc}`;
}

function threadBlock(input) {
  if (!input.thread_context || input.thread_context.length === 0) return '';
  let used = 0;
  const lines = ['', '## Prior thread context'];
  for (const msg of input.thread_context) {
    const block = `From: ${msg.from_addr}\n${(msg.body_text ?? '').slice(0, 800)}`;
    if (used + block.length > MAX_THREAD_CHARS) break;
    lines.push(block, '---');
    used += block.length;
  }
  return lines.join('\n');
}

function effectiveRagCap(input) {
  return input.exemplar_refs && input.exemplar_refs.length > 0
    ? RAG_REFS_CAP_WHEN_EXEMPLARS
    : RAG_REFS_CAP_DEFAULT;
}

function ragBlock(input) {
  if (!input.rag_refs || input.rag_refs.length === 0) return '';
  const lines = ['', '## Reference snippets (use only if relevant)'];
  for (const ref of input.rag_refs.slice(0, effectiveRagCap(input))) {
    lines.push(`[${ref.source}] ${ref.excerpt.slice(0, 600)}`);
  }
  return lines.join('\n');
}

function exemplarBlock(input) {
  if (!input.exemplar_refs || input.exemplar_refs.length === 0) return '';
  const lines = ['', "## Past replies you've sent for this kind of message"];
  for (const ex of input.exemplar_refs.slice(0, 2)) {
    const date = ex.sent_at ? ` (${ex.sent_at.slice(0, 10)})` : '';
    const subj = ex.subject ? ` "${ex.subject.slice(0, 80)}"` : '';
    lines.push(`Reply${date}${subj}:`, ex.snippet.slice(0, 600));
  }
  return lines.join('\n');
}

export function buildUserPrompt(input) {
  const safeBody = (input.body_text ?? '').slice(0, MAX_BODY_CHARS);
  return [
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
    exemplarBlock(input),
    ragBlock(input),
    '',
    '## Output format',
    'Return ONLY the body of the reply email. No subject line, no headers, no quoted original. Plain text only.',
  ]
    .filter((line) => line !== null && line !== undefined)
    .join('\n');
}

export function assemblePrompt(input) {
  return {
    messages: [
      { role: 'system', content: buildSystemPrompt(input.persona ?? {}) },
      { role: 'user', content: buildUserPrompt(input) },
    ],
    max_tokens: 600,
    temperature: 0.7,
  };
}
