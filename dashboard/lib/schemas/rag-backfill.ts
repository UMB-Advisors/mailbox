import { z } from 'zod';

// STAQPRO-194: batch shape posted by the MailBOX-RAG-Backfill n8n workflow.
//
// n8n's Gmail node returns a flat array of message objects with id, threadId,
// snippet, payload.headers, payload.body, internalDate. The workflow normalizes
// these into the rows below before POSTing — keeps the parsing logic out of
// the dashboard route. Operator email is needed to infer direction.

export const ragBackfillRowSchema = z.object({
  message_id: z.string().min(1),
  thread_id: z.string().nullable(),
  from_addr: z.string(),
  to_addr: z.string(),
  subject: z.string().nullable(),
  body: z.string(),
  sent_at: z.string().min(1), // ISO 8601
});

// Cap at 5000 — covers ~6 months of mail for a typical small-CPG operator
// (~30 msg/day × 180 days ≈ 5400; outliers get to chunk + re-run, idempotent
// via the deterministic point UUIDs in upsertEmailPoint).
export const ragBackfillBatchSchema = z.object({
  operator_email: z.string().email(),
  rows: z.array(ragBackfillRowSchema).min(0).max(5000),
});

export type RagBackfillRow = z.infer<typeof ragBackfillRowSchema>;
export type RagBackfillBatch = z.infer<typeof ragBackfillBatchSchema>;
