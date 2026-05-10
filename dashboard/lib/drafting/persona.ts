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
  /**
   * What the operator's business actually does — captured during onboarding
   * (e.g., "small-batch CPG operator", "B2B tech / dev tools company",
   * "veterinary clinic", "freelance illustrator"). Templated into both
   * classification and drafting prompts so the LLM gets industry-grounded
   * framing instead of a hardcoded vertical.
   *
   * Empty string means onboarding hasn't populated it yet; prompt builders
   * fall back to a generic "small business operator" framing.
   */
  business_description: string;
  /**
   * Public booking link the operator wants the AI to share for scheduling
   * emails — Calendly URL, Google Appointment Schedules link
   * (calendar.app.google/...), Cal.com, whatever the operator uses.
   *
   * When set, the drafting system prompt includes an instruction telling the
   * model to share this link if the inbound email is asking to schedule.
   * Empty string ⇒ no link injected; the model proposes scheduling in prose
   * but doesn't fabricate a URL.
   */
  appointment_url: string;
}

// Industry-neutral hardcoded fallback (Phase 1 of the CPG-scrub, 2026-05-08).
// Pre-2026-05-08 the FALLBACK was Heron Labs / small-batch CPG specific —
// fine for customer #1, wrong for any non-CPG appliance (M2 = Staqs.io tech
// dev). New boxes ship with neutral defaults; the operator sets overrides
// during onboarding via the persona settings UI (STAQPRO-149) or via direct
// SQL during install. Live-gate flip should be blocked until at least
// `business_description` is populated, but that gate is owned by 02-08.
const FALLBACK: PersonaContext = {
  tone: 'concise, direct, warm — short paragraphs, no corporate hedging',
  signoff: 'Best,\n[operator name]',
  operator_first_name: 'the operator',
  operator_brand: "the operator's business",
  business_description: '',
  appointment_url: '',
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
    business_description: stringOr(markers.business_description, FALLBACK.business_description),
    appointment_url: stringOr(markers.appointment_url, FALLBACK.appointment_url),
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
