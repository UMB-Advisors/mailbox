// dashboard/lib/chat/assemble.ts
//
// MBOX-287 — pure message assembly for the /dashboard/chat orchestration
// (epic MBOX-282). Given the conversation's prior turns (MBOX-285), the new
// user message, and the retrieval result (MBOX-283), build the
// `OllamaChatMessage[]` handed to the local-model streaming relay (MBOX-284).
//
// Kept side-effect-free (no DB, no fetch, no React) so the assembly rules —
// system prompt, the DR-56 retrieval-gating, history ordering — are unit-tested
// hermetically. The route layer (app/api/internal/chat/send) does the IO and
// calls into here.
//
// LOCAL-ONLY (DR-53): nothing here references a cloud provider; the messages
// produced are consumed only by streamLocalChat, which is local-only by
// construction.

import type { OllamaChatMessage } from '@/lib/llm/types';
import type { ChatRetrievalRef, ChatRetrievalResult } from '@/lib/rag/chat-retrieve';
import type { ChatMessage } from '@/lib/types';

// Roles the local model accepts. chat_messages also persists 'system' turns in
// principle, but the live chat flow only writes user/assistant turns; a stored
// 'system' role would still map cleanly here.
const MODEL_ROLES = new Set(['system', 'user', 'assistant']);

// Base persona for the chat surface. Deliberately conservative about grounding:
// the DR-56 / SM-74 invariant is that the model must NOT make document/source
// claims when retrieval did not clear the relevance floor. We encode that as
// two distinct system prompts (grounded vs plain) selected by the retrieval
// reason, rather than trusting the model to infer it from an empty context
// block.
const BASE_PERSONA =
  'You are the on-device assistant for a MailBox One appliance. You run locally ' +
  'on the customer’s own hardware; no message ever leaves the box. Answer the ' +
  'operator’s questions directly and concisely.';

// Appended only when retrieval cleared the floor (reason === 'ok'). Tells the
// model it MAY ground its answer in the provided excerpts and cite them.
const GROUNDED_SUFFIX =
  ' Some of the operator’s own past email messages are provided below as ' +
  'context because they appear relevant to the question. Use them when they help, ' +
  'and make clear when an answer comes from that correspondence. If the context ' +
  'does not actually answer the question, say so rather than guessing.';

// Appended on every non-'ok' reason (below_floor | no_hits | embed_unavailable |
// qdrant_unavailable | empty_query). This is the SM-74 guard in prompt form: no
// context is attached, and the model is told not to claim it has any.
const PLAIN_SUFFIX =
  ' No relevant past messages were retrieved for this question, so answer from ' +
  'general knowledge only. Do NOT claim to be quoting or citing the operator’s ' +
  'email — you have no document context for this turn.';

// Per-snippet excerpt cap when rendering retrieved context into the prompt.
// retrieveForChat already truncates to RAG_RETRIEVE_EXCERPT_CHARS; this is a
// belt-and-suspenders bound so a misconfigured retriever can't blow the
// local-model context window (DR-18, 4096 ctx on Qwen3-4B).
const CONTEXT_EXCERPT_CAP = 600;

/** Build the system prompt for this turn, gated on the retrieval reason. */
export function buildSystemPrompt(reason: ChatRetrievalResult['reason']): string {
  return reason === 'ok' ? BASE_PERSONA + GROUNDED_SUFFIX : BASE_PERSONA + PLAIN_SUFFIX;
}

/**
 * Render retrieved refs into a single context block. Returns null when there is
 * nothing to attach (no refs OR reason !== 'ok'), so the caller never appends
 * an empty/grounding-implying block on a below-floor turn (SM-74).
 */
export function buildContextBlock(result: ChatRetrievalResult): string | null {
  if (result.reason !== 'ok' || result.refs.length === 0) return null;
  const lines = result.refs.map((ref: ChatRetrievalRef, i: number) => {
    const excerpt = (ref.excerpt ?? '').trim().slice(0, CONTEXT_EXCERPT_CAP);
    return `[${i + 1}] ${excerpt}`;
  });
  return `Relevant past messages:\n${lines.join('\n\n')}`;
}

/**
 * Map persisted history rows to model messages, in order, dropping any role the
 * model doesn't accept and any empty-content row (a never-finalized assistant
 * stub would be empty — never send that as priming).
 */
export function historyToModelMessages(history: readonly ChatMessage[]): OllamaChatMessage[] {
  const out: OllamaChatMessage[] = [];
  for (const m of history) {
    if (!MODEL_ROLES.has(m.role)) continue;
    const content = (m.content ?? '').trim();
    if (content.length === 0) continue;
    out.push({ role: m.role as OllamaChatMessage['role'], content: m.content });
  }
  return out;
}

export interface AssembleInput {
  /** Prior turns for this conversation, oldest-first (getConversationMessages). */
  history: readonly ChatMessage[];
  /** The new user message text for this turn. */
  userContent: string;
  /** Retrieval outcome for userContent (retrieveForChat / MBOX-283). */
  retrieval: ChatRetrievalResult;
}

/**
 * Assemble the full ordered message array for the local model:
 *
 *   [ system(gated) , ...priorHistory , (context block as a system turn)? , user ]
 *
 * The retrieved context is injected as a `system` message immediately before
 * the user turn (rather than concatenated onto the user content) so it reads as
 * out-of-band grounding, not as something the operator typed. On a non-'ok'
 * retrieval reason no context message is added and the system prompt forbids
 * document claims (SM-74 / DR-56).
 */
export function assembleChatMessages(input: AssembleInput): OllamaChatMessage[] {
  const messages: OllamaChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(input.retrieval.reason) },
    ...historyToModelMessages(input.history),
  ];

  const context = buildContextBlock(input.retrieval);
  if (context) {
    messages.push({ role: 'system', content: context });
  }

  messages.push({ role: 'user', content: input.userContent });
  return messages;
}
