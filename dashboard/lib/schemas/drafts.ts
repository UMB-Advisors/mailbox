import { z } from 'zod';
import { DRAFT_STATUSES, type DraftStatus } from '@/lib/types';

// Anchor the zod enum to the canonical DRAFT_STATUSES tuple so the schema
// can never drift from the rest of the codebase (STAQPRO-137).
const statusEnum = z.enum(DRAFT_STATUSES as readonly [DraftStatus, ...DraftStatus[]]);

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

// POST /api/drafts/[id]/reject — body { reason?: string }.
// Empty body is allowed (matches existing behavior).
export const rejectBodySchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1)
    .optional()
    .nullable()
    .transform((v) => v ?? null),
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
