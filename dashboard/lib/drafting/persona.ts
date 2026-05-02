// STAQPRO-195: replace persona-stub with reads from mailbox.persona.
//
// Same getPersonaContext() signature as the 2026-04-30 stub so the drafting
// pipeline (lib/drafting/prompt.ts + app/api/internal/draft-prompt/route.ts)
// keeps working unchanged. New behavior:
//   1. Load the persona row via getPersona() (kysely-typed)
//   2. Resolve each PersonaContext field with this fallback chain:
//      operator-override → extraction-derived → hardcoded fallback
//   3. Hardcoded fallback values match the original stub so the drafting
//      output is byte-identical until a real persona row is populated.

import { getPersona } from '@/lib/queries-persona';

export interface PersonaContext {
  tone: string;
  signoff: string;
  operator_first_name: string;
  operator_brand: string;
}

// Hardcoded fallback — same values the 2026-04-30 stub shipped with. These
// remain the customer-#1 baseline until either the extraction populates
// mailbox.persona (STAQPRO-153) or the operator sets explicit overrides via
// the settings UI (STAQPRO-149).
const FALLBACK: PersonaContext = {
  tone: 'concise, direct, warm — short paragraphs, no corporate hedging',
  signoff: '— Heron Labs',
  operator_first_name: 'Heron Labs team',
  operator_brand: 'Heron Labs (small-batch CPG)',
};

export async function getPersonaContext(customerKey = 'default'): Promise<PersonaContext> {
  const row = await getPersona(customerKey);
  const markers = (row?.statistical_markers ?? {}) as Record<string, unknown>;
  return resolvePersonaContext(markers);
}

// Pure resolver, exported for testing without a DB roundtrip.
export function resolvePersonaContext(markers: Record<string, unknown>): PersonaContext {
  return {
    tone: stringOr(
      markers.tone,
      deriveToneFromFormality(numberOr(markers.formality_score, null)) ?? FALLBACK.tone,
    ),
    signoff: stringOr(markers.signoff, firstNonEmpty(markers.sign_off_top) ?? FALLBACK.signoff),
    operator_first_name: stringOr(markers.operator_first_name, FALLBACK.operator_first_name),
    operator_brand: stringOr(markers.operator_brand, FALLBACK.operator_brand),
  };
}

// formality_score lives in [0, 1] per lib/persona/extract.ts. Map to tone:
//   ≥ 0.7  → formal, deliberate
//   0.4..0.7 → concise, direct, warm  (matches the legacy Heron Labs default)
//   < 0.4  → casual, conversational
// Returns null when no formality_score exists yet (caller falls through to FALLBACK).
function deriveToneFromFormality(score: number | null): string | null {
  if (score == null) return null;
  if (score >= 0.7) return 'formal, deliberate — full sentences, professional register';
  if (score >= 0.4) return 'concise, direct, warm — short paragraphs, no corporate hedging';
  return 'casual, conversational — first-name basis, contractions OK';
}

function stringOr(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.trim().length > 0 ? v : fallback;
}

function numberOr(v: unknown, fallback: number | null): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function firstNonEmpty(v: unknown): string | null {
  if (!Array.isArray(v)) return null;
  for (const item of v) {
    if (typeof item === 'string' && item.trim().length > 0) return item;
  }
  return null;
}
