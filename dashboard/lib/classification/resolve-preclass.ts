// Spec 002 FR7/FR7 (Stage 2b-1/2b-2) — shared force/reverb preclass precedence.
//
// Both `classifyOne()` (the backlog/sweeper chain) and the live n8n-called
// routes (`classification-prompt`, `classification-normalize`) need to run the
// EXACT same "does a Train sender-rule or a Reverb subject hard-route this
// message?" check, in the same precedence: sender-rule `force` > Reverb
// subject match > sender-rule `bias` prior > (fall through to the LLM).
//
// This module exists so that precedence lives in exactly ONE place —
// `classify-one.ts` calls it instead of inlining the check, and the two
// internal routes call it directly (n8n's fixed node chain can't thread data
// between non-adjacent nodes, so `classification-normalize` re-runs this
// independently rather than trusting anything from `classification-prompt`).
//
// Kill switches (unchanged, enforced inside the callees):
//   - SENDER_RULES_DISABLE=1   — inside the injected senderRuleLookup dep
//   - REVERB_ROUTING_DISABLE=1 — checked here, mirrors classify-one.ts

import type { Category } from './prompt';
import { reverbRoute } from './reverb-routing';
import { type SenderRuleHit, senderRuleAction } from './sender-rules';

export interface ResolvePreclassDeps {
  /**
   * Injectable DB-backed Train sender-rule resolver — keeps this module
   * Postgres-free and unit-testable. Live callers pass
   * `lib/classification/sender-rules.ts:senderRule` (account-scoped,
   * fail-open, kill switch SENDER_RULES_DISABLE=1). Omitted → no Train rules
   * apply (the unchanged default).
   */
  senderRuleLookup?: (rawFrom: string | undefined) => Promise<SenderRuleHit | null>;
}

export interface ResolvePreclassResult {
  // Non-null when a `force`-mode sender rule OR a Reverb subject match
  // hard-routes this message. The caller should short-circuit the LLM (or,
  // for classification-normalize, override the model's verdict) to this
  // category.
  forced: Category | null;
  // Set when a `bias`-mode sender rule applies (and no force/reverb match
  // fired) — a prompt prior the LLM reconciles, not a hard route.
  senderPrior: Category | undefined;
  // Provenance, matching ClassificationResult['preclass_source'] /
  // ClassifyOneResult['preclass_source'] naming exactly.
  preclass_source: 'sender-rule-force' | 'reverb-subject' | null;
}

/**
 * Force > reverb > bias-prior precedence, shared by classifyOne() and the two
 * n8n-facing routes. Pure orchestration — the actual DB lookup lives in the
 * injected `senderRuleLookup`; the reverb matcher is a pure subject-pattern
 * check with no DB.
 */
export async function resolvePreclass(
  from: string | undefined,
  subject: string | null | undefined,
  deps: ResolvePreclassDeps = {},
): Promise<ResolvePreclassResult> {
  const ruleHit = deps.senderRuleLookup ? await deps.senderRuleLookup(from) : null;
  const action = senderRuleAction(ruleHit);

  if (action.kind === 'force') {
    return {
      forced: action.category,
      senderPrior: undefined,
      preclass_source: 'sender-rule-force',
    };
  }

  if (process.env.REVERB_ROUTING_DISABLE !== '1') {
    const reverbBucket = reverbRoute(from, subject);
    if (reverbBucket) {
      return { forced: reverbBucket, senderPrior: undefined, preclass_source: 'reverb-subject' };
    }
  }

  return {
    forced: null,
    senderPrior: action.kind === 'bias' ? action.prior : undefined,
    preclass_source: null,
  };
}
