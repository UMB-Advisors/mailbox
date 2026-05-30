import { z } from 'zod';
import { extractAddress } from '@/lib/classification/preclass';
import { CATEGORIES, type Category } from '@/lib/classification/prompt';

// POST /api/classifications/reclassify-sender — MBOX-368 sender-level override.
// Body shape: { email: string, category: <enum>, reason?: string }.
//
// `email` accepts either a bare address or a full "Name <addr>" header and is
// normalized through extractAddress() (the SAME helper the classify-time
// preclass uses) so the value we store and the value the classifier looks up
// are byte-identical lowercased addresses. Anything without an `@` after
// extraction is rejected 400.
//
// `category` is anchored to the canonical CATEGORIES tuple from
// lib/classification/prompt.ts (same 8-category set as the live
// sender_classification_overrides / classification_log / drafts CHECK
// constraints — asserted by test/schema-invariants.test.ts).
//
// `reason` is an optional free-text operator note; it lands in each appended
// classification_log.raw_output as the audit trail for why the relabel
// happened. Cap mirrors the MBOX-123 override reason cap.
const RECLASSIFY_REASON_MAX = 2000;
const categoryEnum = z.enum(CATEGORIES as readonly [Category, ...Category[]]);

export const reclassifyBySenderBodySchema = z.object({
  email: z
    .string()
    .min(1, 'email required')
    .transform((s) => extractAddress(s))
    .pipe(z.string().min(3).regex(/.+@.+/, 'must be an email address')),
  category: categoryEnum,
  reason: z
    .string()
    .trim()
    .max(RECLASSIFY_REASON_MAX, `reason must be <= ${RECLASSIFY_REASON_MAX} chars`)
    .optional()
    .nullable()
    .transform((v) => (v && v.length > 0 ? v : null)),
});

export type ReclassifyBySenderBody = z.infer<typeof reclassifyBySenderBodySchema>;
