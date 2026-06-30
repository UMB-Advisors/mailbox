// Spec 002 FR7 (Stage 2b-1) — Train sender-rules lookup + apply decision.
//
// A sender_rule maps a sender (exact email OR whole domain) to a target bucket
// in one of two modes (the MBOX-370 / MBOX-368 fix — see migration 049):
//   - 'force' = a HARD pre-LLM route. Highest precedence. Allowed ONLY for
//     single-purpose automated senders that emit exactly one type
//     (gemini-notes@google.com→meeting_notes, Gusto payroll→notification, …).
//   - 'bias'  = a strong PRIOR the classifier still reconciles. Does NOT
//     short-circuit; it emits a suggested bucket the prompt layer consumes as a
//     hint (buildPrompt senderPrior). Content can still override. The default,
//     and the only safe mode for MULTI-INTENT senders (clients, colleagues,
//     Reverb).
//
// This module copies the `sender_never_spam` safety envelope verbatim
// (lib/classification/sender-allowlist.ts): a thin "does this sender match a
// rule?" lookup, account-scoped, FAIL-OPEN on any DB error (a transient Postgres
// hiccup degrades to the normal classify path, never mis-routes), and an env
// KILL SWITCH (SENDER_RULES_DISABLE=1). The DB access is invoked by the classify
// path (classify-one via the injected `senderRuleLookup` dep) — keeping classifyOne
// itself Postgres-free and unit-testable.

import { getKysely } from '@/lib/db';
import { getDefaultAccountId } from '@/lib/queries-accounts';
import { extractAddress } from './preclass';
import type { Category } from './prompt';

export const SENDER_RULE_KINDS = ['email', 'domain'] as const;
export type SenderRuleKind = (typeof SENDER_RULE_KINDS)[number];

export const SENDER_RULE_MODES = ['force', 'bias'] as const;
export type SenderRuleMode = (typeof SENDER_RULE_MODES)[number];

export interface SenderRuleHit {
  match: string;
  kind: SenderRuleKind;
  target_bucket: Category;
  mode: SenderRuleMode;
}

function senderRulesEnabled(): boolean {
  return process.env.SENDER_RULES_DISABLE !== '1';
}

function domainOf(email: string): string | null {
  const at = email.lastIndexOf('@');
  return at >= 0 && at < email.length - 1 ? email.slice(at + 1) : null;
}

// Precedence rank (lowest wins): an exact-email rule beats a domain rule, and
// within the same kind a force rule beats a bias rule. So the most specific,
// strongest rule for a sender is the one that fires.
function rank(r: { kind: SenderRuleKind; mode: SenderRuleMode }): number {
  return (r.kind === 'email' ? 0 : 2) + (r.mode === 'force' ? 0 : 1);
}

/**
 * Find the highest-precedence enabled Train rule for a sender, or null.
 * Single account-scoped lookup on the exact (lowercased) address and its bare
 * domain. Fail-open: any DB error is swallowed and treated as "no rule" so a
 * transient Postgres hiccup degrades to the normal classify path. Kill switch
 * SENDER_RULES_DISABLE=1.
 */
export async function senderRule(rawFrom: string | undefined): Promise<SenderRuleHit | null> {
  if (!senderRulesEnabled()) return null;

  const email = extractAddress(rawFrom);
  if (!email) return null;
  const domain = domainOf(email);

  try {
    const accountId = await getDefaultAccountId();
    const matches = domain ? [email, domain] : [email];

    const rows = await getKysely()
      .selectFrom('sender_rules')
      .select(['match', 'kind', 'target_bucket', 'mode'])
      .where('account_id', '=', accountId)
      .where('enabled', '=', true)
      .where('match', 'in', matches)
      .execute();

    // Keep only rows whose kind matches the value they matched on (a domain-kind
    // row must have matched the domain, an email-kind row the full address).
    const valid = rows
      .map((r) => ({
        match: r.match,
        kind: r.kind as SenderRuleKind,
        target_bucket: r.target_bucket as Category,
        mode: r.mode as SenderRuleMode,
      }))
      .filter(
        (r) =>
          (r.kind === 'email' && r.match === email) ||
          (r.kind === 'domain' && r.match === domain),
      );

    if (valid.length === 0) return null;
    valid.sort((a, b) => rank(a) - rank(b));
    return valid[0];
  } catch (error) {
    console.error(`[sender-rules] lookup failed for ${email} — failing open:`, error);
    return null;
  }
}

export type SenderRuleAction =
  // hard pre-LLM route — skip the model, classify as `category`.
  | { kind: 'force'; category: Category }
  // a prior the classifier reconciles — inject `prior` as a buildPrompt hint.
  | { kind: 'bias'; prior: Category }
  | { kind: 'none' };

/**
 * Pure decision over a rule hit. Documents the force > bias > none precedence
 * and keeps the classify-path branching trivial + unit-testable. `force`
 * short-circuits the LLM; `bias` only seeds a prompt hint (content can override).
 */
export function senderRuleAction(hit: SenderRuleHit | null): SenderRuleAction {
  if (!hit) return { kind: 'none' };
  if (hit.mode === 'force') return { kind: 'force', category: hit.target_bucket };
  return { kind: 'bias', prior: hit.target_bucket };
}
