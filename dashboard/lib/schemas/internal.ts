import { z } from 'zod';

// Schemas for the n8n-facing internal routes. These accept the exact shapes
// n8n already sends today; tightening here would break the live pipeline.

// POST /api/internal/draft-prompt — { draft_id: number }
export const draftPromptBodySchema = z.object({
  draft_id: z.coerce.number().int().positive(),
});

export type DraftPromptBody = z.infer<typeof draftPromptBodySchema>;

// POST /api/internal/draft-finalize — full payload from n8n's draft sub-workflow.
// `source` mirrors the live drafts.draft_source CHECK constraint values that
// the live code actually writes (the broader CHECK also permits legacy
// `local_qwen3` / `cloud_haiku`, but neither is written by the live path).
export const draftFinalizeBodySchema = z.object({
  draft_id: z.coerce.number().int().positive(),
  body: z.string().min(1, 'body (non-empty string) required'),
  source: z.enum(['local', 'cloud']),
  model: z.string().trim().min(1, 'model (non-empty string) required'),
  input_tokens: z.coerce.number().int().nonnegative().default(0),
  output_tokens: z.coerce.number().int().nonnegative().default(0),
});

export type DraftFinalizeBody = z.infer<typeof draftFinalizeBodySchema>;

// POST /api/internal/classification-prompt — all fields optional (route falls
// back to '' on missing).
export const classificationPromptBodySchema = z.object({
  from: z.string().optional().default(''),
  subject: z.string().optional().default(''),
  body: z.string().optional().default(''),
});

export type ClassificationPromptBody = z.infer<
  typeof classificationPromptBodySchema
>;

// POST /api/internal/classification-normalize — { raw?, from?, to? }.
// `from` / `to` feed the deterministic operator-domain preclass (DR-50).
export const classificationNormalizeBodySchema = z.object({
  raw: z.string().optional().default(''),
  from: z.string().optional(),
  to: z.string().optional(),
});

export type ClassificationNormalizeBody = z.infer<
  typeof classificationNormalizeBodySchema
>;
