import { z } from 'zod';

// STAQPRO-149: persona update via PUT /api/persona. The JSON fields are open-
// shape (the extraction in 02-06 / STAQPRO-153 will define the canonical
// statistical_markers + category_exemplars schemas). For now we accept any
// valid JSON object so operators can manually tune the persona before the
// extraction pipeline lands.
export const personaUpdateSchema = z.object({
  statistical_markers: z.record(z.string(), z.unknown()),
  category_exemplars: z.record(z.string(), z.unknown()),
});

export type PersonaUpdate = z.infer<typeof personaUpdateSchema>;

// MBOX-373 (MBOX-162 V6 P1): POST /api/persona/refresh body. `account_id` is
// optional — omitted = the default account (the legacy single-account behavior
// the PersonaSettings button relies on); supplied = extract + write THAT
// account's persona row (the per-account "Learn voice" trigger from
// /settings/accounts). The body may be empty ({} → account_id undefined).
export const personaRefreshSchema = z.object({
  account_id: z.coerce.number().int().positive('account_id must be a positive integer').optional(),
});

export type PersonaRefresh = z.infer<typeof personaRefreshSchema>;
