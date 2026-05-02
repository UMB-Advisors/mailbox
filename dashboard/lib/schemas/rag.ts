import { z } from 'zod';

// STAQPRO-190 — schemas for the dashboard's RAG embed/search internal routes.
// These are called from n8n's Classify and Send sub-workflows (and from the
// rag-backfill.ts script). Field shapes mirror what's already in
// `inbox_messages` / `sent_history` rows.

export const embedRequestBodySchema = z.object({
  message_id: z.string().min(1, 'message_id required'),
  thread_id: z.string().nullable().optional(),
  sender: z.string().min(1, 'sender required'),
  recipient: z.string().default(''),
  subject: z.string().nullable().optional(),
  body: z.string().default(''),
  // ISO 8601 string. Required because Qdrant indexes payload.sent_at as
  // datetime; passing 'now' here for missing values would muddle the
  // recency semantics.
  sent_at: z.string().min(1, 'sent_at (ISO 8601) required'),
  direction: z.enum(['inbound', 'outbound']),
  classification_category: z.string().nullable().optional(),
});

export type EmbedRequestBody = z.infer<typeof embedRequestBodySchema>;
