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
