import { z } from 'zod';

// Shared schema building blocks for STAQPRO-138.

// Path param `[id]` — Next.js gives us a string from the URL; coerce + assert
// it's a positive integer. Rejects non-numeric strings, floats, negatives.
export const idParamSchema = z.object({
  id: z
    .string()
    .regex(/^\d+$/, 'id must be a non-negative integer')
    .transform((s) => parseInt(s, 10))
    .refine((n) => n > 0, 'id must be > 0'),
});

export type IdParam = z.infer<typeof idParamSchema>;
