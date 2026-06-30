// Spec 002 FR4 (Stage 2b-1) — escalation-promotion + review-subtype flag.
//
// A pure, DB-free, unit-testable post-classify step. Runs ONLY on a
// `notification` verdict (the new 2a bucket for automated software/system
// alerts, which otherwise collapses to the FYI/Notif tab):
//
//   1. If the notification matches an `escalation_signal`
//      (seed/buckets.yaml::escalation_signals — payment_failed, account_suspension,
//      filing_or_tax_due, legal_or_compliance, security_breach, commerce_dispute)
//      by INTENT → PROMOTE to `escalate` so it stays in the main queue (money /
//      risk / deadline). (FR4)
//   2. Else if it's a `review` subtype (Yelp / Google business-profile /
//      marketplace review) → KEEP `notification` but flag it `important` so the
//      triage UI surfaces it in the FYI/Notif tab instead of collapsing it. (FR4)
//
// Intent, not literal keywords (buckets.yaml note): a routine "new sign-in" is
// NOT a breach; a "payroll ran" is NOT a payment failure. The matchers below are
// deliberately conservative keyword/intent heuristics (the spec allows "a light
// intent check, your call, keep it simple + testable"); the few-shot/LLM intent
// path is Stage 2b-2. The signal exemplars stay trainable via the same path.

import type { Category } from './prompt';

export const ESCALATION_SIGNALS = [
  'payment_failed',
  'account_suspension',
  'filing_or_tax_due',
  'legal_or_compliance',
  'security_breach',
  'commerce_dispute',
] as const;
export type EscalationSignal = (typeof ESCALATION_SIGNALS)[number];

export interface EscalationPromotionInput {
  category: Category;
  subject?: string | null;
  body?: string | null;
}

export interface EscalationPromotionResult {
  // The (possibly promoted) bucket. `notification` → `escalate` on a signal match.
  category: Category;
  // True when a notification was promoted to escalate.
  promoted: boolean;
  // Which signal fired (for audit / the urgency badge), or null.
  escalation_signal: EscalationSignal | null;
  // True when this is a review-subtype notification kept surfaced + flagged.
  review_subtype: boolean;
  // Surfaced/important flag: set for review subtypes (and promotions are inherently
  // visible via the `escalate` bucket). The triage UI (Spec 003) reads this to keep
  // the row out of the collapsed FYI list.
  important: boolean;
}

// Intent matchers — conservative, ordered. Each guards against the obvious
// false-positive the buckets.yaml note calls out.
const SIGNAL_MATCHERS: Array<{ signal: EscalationSignal; test: (t: string) => boolean }> = [
  {
    signal: 'payment_failed',
    test: (t) =>
      /\bpayment (failed|declined|was declined|could not be|unsuccessful)\b/.test(t) ||
      /\bcard (was )?declined\b/.test(t) ||
      /\b(auto-?pay|autopay|direct debit) (failed|could not|couldn'?t|was declined)\b/.test(t) ||
      /\b(unable|failed) to (process|charge|collect) (your )?payment\b/.test(t) ||
      /\bpast due\b/.test(t),
  },
  {
    signal: 'account_suspension',
    test: (t) =>
      /\baccount (has been |is being |will be |may be )?(suspend|suspended|closed|locked|deactivat|disabled|terminat)/.test(
        t,
      ) ||
      /\b(suspend|deactivat|terminat|disabl)\w*\s+your account\b/.test(t) ||
      /\baction required to (keep|avoid losing)\b/.test(t),
  },
  {
    signal: 'filing_or_tax_due',
    test: (t) =>
      /\b(sales tax|tax|filing|return|1099|w-?2|quarterly)\b[^.]{0,40}\b(due|deadline|past due|owed)\b/.test(
        t,
      ) ||
      /\b(filing|return) (is )?due\b/.test(t) ||
      /\bdeadline to file\b/.test(t),
  },
  {
    signal: 'legal_or_compliance',
    test: (t) =>
      /\b(subpoena|cease[- ]and[- ]desist|demand letter|audit notice|notice of (default|violation)|cease and desist|legal action|litigation|compliance violation)\b/.test(
        t,
      ),
  },
  {
    signal: 'security_breach',
    // NOT a routine sign-in — require breach/unauthorized intent explicitly.
    test: (t) =>
      /\b(data breach|security breach|breached|unauthor(i[sz]ed) (access|login|transaction)|your (account|data) (was|has been) compromised|we detected unauthorized)\b/.test(
        t,
      ),
  },
  {
    signal: 'commerce_dispute',
    // returns / refunds / chargebacks / disputes — time-sensitive $$ (Shopify live).
    test: (t) =>
      /\b(chargeback|charge ?back|dispute(d|s)?|refund request|requested a refund|return request|item not (as )?described|opened a (case|dispute)|a-?to-?z claim)\b/.test(
        t,
      ),
  },
];

const REVIEW_MATCHER =
  /\b(left (you )?a (new )?review|new review|wrote a review|posted a review|review of your|rate your experience|how was your|business profile.*review|yelp|trustpilot|google (business|review))\b/;

function haystack(input: EscalationPromotionInput): string {
  return `${input.subject ?? ''}\n${input.body ?? ''}`.toLowerCase();
}

/** Which escalation signal (if any) the message's intent matches. Exported for tests. */
export function detectEscalationSignal(input: EscalationPromotionInput): EscalationSignal | null {
  const t = haystack(input);
  for (const m of SIGNAL_MATCHERS) {
    if (m.test(t)) return m.signal;
  }
  return null;
}

/** Is this notification a review-subtype (kept surfaced, not promoted)? Exported for tests. */
export function isReviewSubtype(input: EscalationPromotionInput): boolean {
  return REVIEW_MATCHER.test(haystack(input));
}

/**
 * FR4 post-classify promotion. Pure. Only touches `notification` verdicts; every
 * other category passes through unchanged.
 */
export function promoteEscalation(input: EscalationPromotionInput): EscalationPromotionResult {
  const base: EscalationPromotionResult = {
    category: input.category,
    promoted: false,
    escalation_signal: null,
    review_subtype: false,
    important: false,
  };

  if (input.category !== 'notification') return base;

  const signal = detectEscalationSignal(input);
  if (signal) {
    return {
      category: 'escalate',
      promoted: true,
      escalation_signal: signal,
      review_subtype: false,
      important: true,
    };
  }

  if (isReviewSubtype(input)) {
    return { ...base, review_subtype: true, important: true };
  }

  return base;
}
