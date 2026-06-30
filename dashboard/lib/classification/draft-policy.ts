// Spec 002 FR5 (Stage 2b-3) — bucket reply-policy → draft gating.
//
// WHY: "Gate reply-drafting so only reply-worthy buckets ever produce a draft"
// (spec.md Summary §3 / FR5). The `reply` policy for every bucket is declared
// in seed/buckets.yaml; this module encodes that policy as typed config so the
// draft-creation path can refuse to draft for a non-reply-worthy bucket.
//
// FR5 verbatim: only buckets whose reply policy is
//   `draft` / `often` / `light_draft` / `sometimes`
// may produce a draft; all others MUST NOT (receipts, marketplace_notification,
// marketing_promo, notification, review-class, spam, finance/admin FYI, etc.).
//
// Pure, no DB, no React — same /lib convention as drafting-flag.ts so vitest's
// resolver picks it up without the JSX import-analysis path.

import type { Category } from '@/lib/classification/prompt';

// The seven reply policies that appear in seed/buckets.yaml.
export type ReplyPolicy =
  | 'draft'
  | 'often'
  | 'light_draft'
  | 'sometimes'
  | 'after_scope_approval'
  | 'rarely'
  | 'none';

// FR5 — the ONLY reply-worthy policies. A bucket may draft iff its policy is in
// this set. `after_scope_approval` (proposal_request) and `rarely`/`none` are
// deliberately excluded: proposals wait for scope sign-off, and FYI/track/spam
// buckets never draft, even on-demand.
export const DRAFTABLE_POLICIES: ReadonlySet<ReplyPolicy> = new Set<ReplyPolicy>([
  'draft',
  'often',
  'light_draft',
  'sometimes',
]);

// Each Category's reply policy.
//   - Design-taxonomy buckets: verbatim from seed/buckets.yaml::buckets[].reply.
//   - Legacy-coarse categories (the 8 the live model still emits during the
//     transition): inherit the policy of the design bucket they map to via
//     seed/buckets.yaml::live_to_design_map, so on-demand Respond stays
//     consistent until the legacy labels are migrated out. `unknown` has no
//     reply policy → 'none' (fail-closed, never drafts).
export const BUCKET_REPLY_POLICY: Record<Category, ReplyPolicy> = {
  // --- legacy coarse (live_to_design_map) ---
  inquiry: 'draft', // -> client_request
  reorder: 'draft', // -> client_request
  scheduling: 'light_draft', // design bucket (shared key)
  follow_up: 'draft', // -> client_request
  internal: 'sometimes', // design bucket (shared key)
  spam_marketing: 'none', // -> spam / marketing_promo
  escalate: 'draft', // design bucket (shared key)
  unknown: 'none', // no reply policy — fail-closed, never drafts
  // --- design taxonomy (seed/buckets.yaml) ---
  client_request: 'draft',
  proposal_request: 'after_scope_approval',
  sales_lead: 'often',
  meeting_invite: 'none',
  meeting_notes: 'none',
  receipt: 'none',
  marketplace_notification: 'none',
  marketing_promo: 'none',
  vendor_partner: 'sometimes',
  finance_legal: 'rarely',
  admin_account: 'rarely',
  invoice_payable: 'rarely',
  contract_legal: 'sometimes',
  notification: 'none',
  spam: 'none',
};

// The reply policy for a bucket. Unknown/garbage strings fail closed to 'none'.
export function replyPolicyFor(bucket: Category): ReplyPolicy {
  return BUCKET_REPLY_POLICY[bucket] ?? 'none';
}

// FR5 — may this bucket ever produce a draft? Pure, total, fail-closed.
export function canDraft(bucket: Category): boolean {
  return DRAFTABLE_POLICIES.has(replyPolicyFor(bucket));
}

// Typed refusal returned by the draft-creation gate for a non-draftable bucket.
export interface DraftRefusal {
  draftable: false;
  bucket: Category;
  policy: ReplyPolicy;
  reason: string;
}

export type DraftGateResult = { draftable: true } | DraftRefusal;

// The gate decision. A clear, typed "not draftable for bucket X" when the
// bucket's reply policy is not reply-worthy — callers MUST NOT generate.
export function draftGate(bucket: Category): DraftGateResult {
  if (canDraft(bucket)) return { draftable: true };
  const policy = replyPolicyFor(bucket);
  return {
    draftable: false,
    bucket,
    policy,
    reason: `bucket "${bucket}" has reply policy "${policy}" — not draftable (Spec 002 FR5)`,
  };
}
