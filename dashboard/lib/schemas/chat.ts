import { z } from 'zod';
import { CHAT_MESSAGE_ROLES } from '@/lib/types';

// MBOX-285 — schemas for the internal chat-history persistence routes
// (POST /api/internal/chat/conversations, POST /api/internal/chat/messages,
// GET .../messages). Called from the dashboard's own /dashboard/chat route
// (MBOX-287) inside the docker network — not from n8n. History is local-only
// (NFR-7) and auth-gated by Caddy on the public surface (FR-26).

// POST /api/internal/chat/conversations — start a session. Title is optional;
// the chat route may backfill it from a first-message summary later.
export const chatConversationCreateSchema = z.object({
  title: z.string().trim().min(1).max(200).nullish(),
});

export type ChatConversationCreate = z.infer<typeof chatConversationCreateSchema>;

// POST /api/internal/chat/messages — append a turn. model/tokens/rag_* are
// assistant-turn metadata; user/system turns omit them. rag_context_refs is an
// array of Qdrant point UUIDs (RFC 4122) mirroring the drafts pattern — the
// route persists it verbatim; the relevance-floor outcome lands in
// rag_retrieval_reason (MBOX-283).
export const chatMessageCreateSchema = z.object({
  conversation_id: z.coerce.number().int().positive(),
  role: z.enum(CHAT_MESSAGE_ROLES),
  content: z.string().trim().min(1, 'content (non-empty string) required'),
  model: z.string().trim().min(1).nullish(),
  input_tokens: z.coerce.number().int().nonnegative().nullish(),
  output_tokens: z.coerce.number().int().nonnegative().nullish(),
  rag_context_refs: z.array(z.string().uuid()).default([]),
  rag_retrieval_reason: z.string().trim().min(1).default('none'),
});

export type ChatMessageCreate = z.infer<typeof chatMessageCreateSchema>;

// GET /api/internal/chat/messages?conversation_id=N — load a conversation's
// turns in order.
export const chatMessagesQuerySchema = z.object({
  conversation_id: z.coerce.number().int().positive(),
});

export type ChatMessagesQuery = z.infer<typeof chatMessagesQuerySchema>;
