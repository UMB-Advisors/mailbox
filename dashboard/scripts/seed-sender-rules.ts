// dashboard/scripts/seed-sender-rules.ts
//
// Spec 002 FR7 (Stage 2b-1) — seed the evidence-backed "High-value deterministic
// sender rules" from specs/002-bucket-routing/spec.md into mailbox.sender_rules.
//
// IDEMPOTENT: each rule goes through upsertSenderRule (idempotent on
// (account_id, match, kind)) — re-running updates in place, never duplicates.
//
// Run from the dashboard container:
//   docker exec mailbox-dashboard npx tsx scripts/seed-sender-rules.ts
//
// MODE policy (the MBOX-370 safety lesson): `force` is allowed ONLY for the
// genuinely single-purpose AUTOMATED senders that emit exactly one type. Every
// multi-intent / human sender is `bias` (a prior the classifier reconciles).
//   - your own company domain  → internal  (BIAS — colleagues are multi-intent;
//                                add a per-deployment rule, see the commented
//                                EXAMPLE in the bias section below)
//   - Reverb                   → NOT SEEDED here — Reverb is multi-intent; routed
//                                by SUBJECT pattern (a content rule), per spec.md.
//                                Implemented in Stage 2b-2 as the pure matcher
//                                lib/classification/reverb-routing.ts (the patterns
//                                are code constants — inherently idempotent, no DML).

import {
  type UpsertSenderRuleInput,
  upsertSenderRule,
} from '@/lib/queries-sender-rules';
import { getDefaultAccountId } from '@/lib/queries-accounts';

type SeedRule = Omit<UpsertSenderRuleInput, 'account_id' | 'created_by'>;

export const SEED_SENDER_RULES: SeedRule[] = [
  // ── force: single-purpose automated senders (one type only) ──────────────
  {
    match: 'gemini-notes@google.com',
    kind: 'email',
    target_bucket: 'meeting_notes',
    mode: 'force',
    reason: 'Gemini meeting-notes bot — only ever emits meeting recaps (spec.md).',
  },
  {
    match: 'gusto.com',
    kind: 'domain',
    target_bucket: 'notification',
    mode: 'force',
    reason: 'Gusto payroll — automated finance/payroll alerts (spec.md).',
  },
  {
    match: 'accounts@1password.com',
    kind: 'email',
    target_bucket: 'admin_account',
    mode: 'force',
    reason: '1Password account/admin notices (spec.md).',
  },
  {
    match: 'no-reply@accounts.google.com',
    kind: 'email',
    target_bucket: 'admin_account',
    mode: 'force',
    reason: 'Google Accounts admin/security notices (spec.md).',
  },
  // marketing-blast domains → marketing_promo (spec.md evidence-backed list)
  {
    match: 'e.fender.com',
    kind: 'domain',
    target_bucket: 'marketing_promo',
    mode: 'force',
    reason: 'Fender marketing subdomain — bulk campaigns (spec.md).',
  },
  {
    match: 'on1.com',
    kind: 'domain',
    target_bucket: 'marketing_promo',
    mode: 'force',
    reason: 'ON1 marketing blasts (spec.md).',
  },
  {
    match: 'tailscale.com',
    kind: 'domain',
    target_bucket: 'marketing_promo',
    mode: 'force',
    reason: 'Tailscale marketing domain (spec.md evidence list).',
  },
  {
    match: 'alignable.com',
    kind: 'domain',
    target_bucket: 'marketing_promo',
    mode: 'force',
    reason: 'Alignable networking blasts (spec.md).',
  },
  {
    match: 'workspace-noreply@google.com',
    kind: 'email',
    target_bucket: 'marketing_promo',
    mode: 'force',
    reason: 'Google Workspace promotional no-reply (spec.md).',
  },
  {
    match: 'ads-noreply@google.com',
    kind: 'email',
    target_bucket: 'marketing_promo',
    mode: 'force',
    reason: 'Google Ads promotional no-reply (spec.md).',
  },
  // ── bias: multi-intent senders (a prior the classifier reconciles) ───────
  // EXAMPLE (per-deployment): bias your own company domain toward `internal`.
  // Colleagues are multi-intent, so this is a `bias` prior, never a `force`.
  // Uncomment and replace with your domain:
  // {
  //   match: 'your-company.com',     // e.g. "@your-company.com" → internal
  //   kind: 'domain',
  //   target_bucket: 'internal',
  //   mode: 'bias',
  //   reason: 'Own company domain — internal, but multi-intent → bias, not force (spec.md).',
  // },
  // NOTE: Reverb is intentionally omitted — it is multi-intent (buyer messages →
  // sales_lead, payouts → receipt, saved-search → marketing_promo, offers →
  // marketplace_notification). Reverb is routed by SUBJECT pattern (Stage 2b-2,
  // lib/classification/reverb-routing.ts), never as a single force rule (spec.md
  // + MBOX-370 lesson).
];

export async function seedSenderRules(): Promise<{ seeded: number }> {
  const accountId = await getDefaultAccountId();
  let seeded = 0;
  for (const rule of SEED_SENDER_RULES) {
    await upsertSenderRule({ ...rule, account_id: accountId, created_by: 'seed-sender-rules' });
    seeded += 1;
    console.log(`  [seed] ${rule.mode.padEnd(5)} ${rule.kind.padEnd(6)} ${rule.match} -> ${rule.target_bucket}`);
  }
  return { seeded };
}

// Run directly (tsx) — guard so importing the SEED_SENDER_RULES table in tests
// doesn't execute the seed.
if (process.argv[1] && process.argv[1].includes('seed-sender-rules')) {
  seedSenderRules()
    .then(({ seeded }) => {
      console.log(`[seed-sender-rules] done: ${seeded} rules upserted (idempotent).`);
      process.exit(0);
    })
    .catch((e: unknown) => {
      console.error('[seed-sender-rules] fatal:', e);
      process.exit(1);
    });
}
