import { z } from 'zod';
import {
  DRAFT_STATUSES,
  type DraftStatus,
  REJECT_REASON_CODES,
  type RejectReasonCode,
} from '@/lib/types';

// Anchor the zod enum to the canonical DRAFT_STATUSES tuple so the schema
// can never drift from the rest of the codebase (STAQPRO-137).
const statusEnum = z.enum(DRAFT_STATUSES as readonly [DraftStatus, ...DraftStatus[]]);

// draft_feedback.reason_code enum anchor (STAQPRO-331 #1). Mirrors the
// Postgres CHECK constraint in migration 023.
const reasonCodeEnum = z.enum(
  REJECT_REASON_CODES as readonly [RejectReasonCode, ...RejectReasonCode[]],
);

// GET /api/drafts — query string `status=csv,of,statuses&limit=N`.
// Match existing behavior: no statuses given → default to `['pending']`.
// Invalid statuses are rejected with 400 (tighter than the previous silent
// filter, but matches the principle that callers should know when their input
// is malformed).
export const listDraftsQuerySchema = z.object({
  status: z
    .string()
    .optional()
    .transform((s) => {
      if (!s) return ['pending'] as DraftStatus[];
      return s
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
    })
    .pipe(z.array(statusEnum).min(1, 'at least one status required')),
  limit: z
    .string()
    .optional()
    .transform((s) => (s ? parseInt(s, 10) : 50))
    .pipe(z.number().int().positive().max(250)),
});

export type ListDraftsQuery = z.infer<typeof listDraftsQuerySchema>;

// POST /api/drafts/[id]/reject — STAQPRO-331 #1.
// Body shape: { reason_code: <enum>, free_text?: string }.
// reason_code is required and feeds the learning loop downstream
// (persona resolver, RAG eval, classifier eval re-labeling). free_text is
// required when reason_code === 'other'; optional context otherwise.
const FREE_TEXT_MAX = 2000;
export const rejectBodySchema = z
  .object({
    reason_code: reasonCodeEnum,
    free_text: z
      .string()
      .trim()
      .max(FREE_TEXT_MAX, `free_text must be <= ${FREE_TEXT_MAX} chars`)
      .optional()
      .nullable()
      .transform((v) => (v && v.length > 0 ? v : null)),
  })
  .superRefine((val, ctx) => {
    if (val.reason_code === 'other' && (val.free_text === null || val.free_text.length === 0)) {
      ctx.addIssue({
        code: 'custom',
        path: ['free_text'],
        message: "free_text is required when reason_code is 'other'",
      });
    }
  });

export type RejectBody = z.infer<typeof rejectBodySchema>;

// POST /api/drafts/[id]/edit — body { draft_body: string, draft_subject?: string }.
const MAX_BODY = 10_000;
export const editBodySchema = z.object({
  draft_body: z
    .string()
    .trim()
    .min(1, 'draft_body required')
    .max(MAX_BODY, `draft_body must be <= ${MAX_BODY} chars`),
  draft_subject: z
    .string()
    .trim()
    .min(1)
    .optional()
    .nullable()
    .transform((v) => v ?? null),
});

export type EditBody = z.infer<typeof editBodySchema>;
