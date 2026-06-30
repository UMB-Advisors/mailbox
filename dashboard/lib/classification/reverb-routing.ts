// Spec 002 FR7 (Stage 2b-2) — Reverb subject routing (the multi-intent case 2b-1
// deferred).
//
// MECHANISM CHOICE (see MANIFEST): a dedicated PURE content matcher invoked in
// the classify path — NOT a `sender_rules` row and NOT a new `subject_pattern`
// column. Reasoning:
//   - Reverb sends 4 distinct message types from one domain, so it MUST NOT be a
//     single `force` sender rule (the MBOX-370 lesson — a forced category
//     mis-files the other 3 types). The seed (scripts/seed-sender-rules.ts)
//     deliberately omits Reverb for exactly this reason.
//   - The spec calls this "Reverb BY SUBJECT … a content rule". A pure matcher
//     is DB-light (zero migration, zero schema churn, zero query per message),
//     fully unit-testable, and keeps the sender_rules apply-precedence logic
//     simple. A `subject_pattern` column would force regex semantics into the DB
//     + a new precedence tier in senderRule — more surface for no benefit here.
//   - The patterns ARE the seed: they live here as code constants, so they are
//     inherently idempotent (no DML to re-run, nothing to drift). Editing one
//     pattern is a one-line code change reviewed in the diff.
//
// Reverb's templated subjects map cleanly (spec.md "High-value deterministic
// sender rules"):
//   - "Message about …"                         → sales_lead              (a buyer inquiry on a listing)
//   - payment / earnings / "you got paid" / payout → receipt             (already paid; track only)
//   - feed / "saved search" / matches / "we found" → marketing_promo     (bulk discovery mail)
//   - offers / "has an offer"                   → marketplace_notification (a real offer to action)
//
// On a Reverb sender whose subject matches NO pattern, this returns null and the
// message falls through to the normal LLM classify path (safe default — we only
// hard-route when a templated subject is unambiguous).

import { extractAddress } from './preclass';
import type { Category } from './prompt';

// Reverb's sending domain. Matches the bare domain and any subdomain
// (mail.reverb.com, marketplace.reverb.com, …) via suffix compare — same
// no-regex domain-suffix style as vip_senders / sender_rules.
const REVERB_DOMAINS = ['reverb.com'] as const;

function domainOf(email: string): string | null {
  const at = email.lastIndexOf('@');
  return at >= 0 && at < email.length - 1 ? email.slice(at + 1).toLowerCase() : null;
}

/** True when the sender is Reverb (exact domain or any subdomain of it). */
export function isReverbSender(rawFrom: string | undefined): boolean {
  const email = extractAddress(rawFrom);
  if (!email) return false;
  const domain = domainOf(email);
  if (!domain) return false;
  return REVERB_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}

// Ordered subject patterns. First match wins; ordered most-specific →
// least-specific so a transactional subject can't be swallowed by the broad
// "message about" buyer-inquiry catch.
interface ReverbPattern {
  bucket: Category;
  test: RegExp;
}
export const REVERB_SUBJECT_PATTERNS: ReverbPattern[] = [
  // payouts / earnings — money already moved → a receipt to track.
  {
    bucket: 'receipt',
    test: /\b(you got paid|you've been paid|payment|payout|earnings|deposit)\b/i,
  },
  // an offer to act on → a marketplace notification.
  {
    bucket: 'marketplace_notification',
    test: /\b(offer|has an offer|made an offer|counteroffer|counter-offer)\b/i,
  },
  // discovery / feed / saved-search blasts → marketing.
  {
    bucket: 'marketing_promo',
    test: /\b(saved search|we found|matches|new listings?|in your feed|price drop|just listed)\b/i,
  },
  // a buyer asking about a listing → a sales lead (win-the-job).
  { bucket: 'sales_lead', test: /\bmessage about\b/i },
];

/**
 * PURE Reverb subject route. Returns the hard-route bucket for a Reverb sender
 * whose subject matches a templated pattern, or null (not Reverb, or no pattern
 * matched → fall through to the LLM). Never throws; no DB; no side effects.
 */
export function reverbRoute(
  rawFrom: string | undefined,
  subject: string | null | undefined,
): Category | null {
  if (!isReverbSender(rawFrom)) return null;
  const subj = subject ?? '';
  for (const p of REVERB_SUBJECT_PATTERNS) {
    if (p.test.test(subj)) return p.bucket;
  }
  return null;
}
