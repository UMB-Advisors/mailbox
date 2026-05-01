// Persona stub for 02-07 ship (2026-04-30).
//
// 02-06 will replace this with real persona extraction from sent history,
// reading from `mailbox.persona`. The function signature stays the same so
// 02-06 lands as a single-file delta — every consumer (drafting/prompt.ts,
// future tuning UI) keeps working unchanged.

export interface PersonaContext {
  // Voice descriptors (free-form; the prompt formats them inline).
  tone: string;
  signoff: string;
  // Operator identity, used in the system prompt.
  operator_first_name: string;
  operator_brand: string;
}

// Hardcoded for the customer-#1 operator (Heron Labs). Customer #2 will need
// either an env-var override or a row in mailbox.persona that this function
// loads from instead. Kept in code, not env, so the prompt diffs cleanly in
// PRs while we're still tuning.
const HERON_LABS_PERSONA: PersonaContext = {
  tone: 'concise, direct, warm — short paragraphs, no corporate hedging',
  signoff: '— Heron Labs',
  operator_first_name: 'Heron Labs team',
  operator_brand: 'Heron Labs (small-batch CPG)',
};

export async function getPersonaContext(
  // Future: customerKey will route to mailbox.persona row.
  _customerKey = 'default',
): Promise<PersonaContext> {
  return HERON_LABS_PERSONA;
}
