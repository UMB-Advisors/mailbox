import { type NextRequest, NextResponse } from 'next/server';
import { promoteEscalation } from '@/lib/classification/escalation-promotion';
import { normalizeClassifierOutput } from '@/lib/classification/normalize';
import { routeFor } from '@/lib/classification/prompt';
import { resolvePreclass } from '@/lib/classification/resolve-preclass';
import { isNeverSpamSender } from '@/lib/classification/sender-allowlist';
import { senderRule } from '@/lib/classification/sender-rules';
import { operatorOwnsThread } from '@/lib/classification/thread-ownership';
import { parseJson } from '@/lib/middleware/validate';
import { classificationNormalizeBodySchema } from '@/lib/schemas/internal';

export const dynamic = 'force-dynamic';

// D-06 / MAIL-07 — strip <think> tokens, parse JSON, fall back to
// {category: 'unknown', confidence: 0} on any parse failure. Exposed for the
// n8n classify sub-workflow so normalization logic stays in code, not in JSON.
//
// D-50 — accept optional `from` / `to` so the deterministic operator-identity
// preclass in lib/classification/preclass.ts can override the LLM verdict.
//
// UMB-153 — precheckSelfLoop fires inside normalizeClassifierOutput (sync).
//
// UMB-154 — after sync normalize, if result is not already dropped and
// thread_id is present, run the async operatorOwnsThread guard. If the
// operator owns the thread (replied within the active window), override to
// spam_marketing/drop with suppression_reason='operator_owns_thread'. The
// n8n Normalize node jsonBody needs a `thread_id` line for this to fire in
// production (see deploy note in SUMMARY).
//
// MBOX-370 — never-spam allowlist. If the verdict would otherwise be suppressed
// (a spam_marketing drop from the model/noreply/self-loop, OR a non-drop that the
// owns-thread guard could still suppress) AND the operator allowlisted this sender
// via /classifications, RE-RUN normalize with `neverSpam` (heuristic suppressions
// disabled → operator-domain `internal` / the model's real category; a genuine
// model spam verdict surfaced to `unknown`) and SKIP the owns-thread guard. The DB
// lookup is gated to the could-be-suppressed path, so a normal non-spam classify
// (no thread_id, non-spam) stays query-free.
//
// Spec 002 FR7/FR7b/FR4 — `subject` / `body` are OPTIONAL (backward compatible
// with old callers that omit them). When present, immediately before the
// final response:
//   (a) independently re-run the SAME force/reverb precedence check
//       (resolve-preclass.ts, shared with classify-one.ts and the prompt
//       route) using `from` + `subject`. This is a SECOND, independent
//       recompute — n8n's fixed node chain can't thread data between
//       non-adjacent nodes, so classification-prompt's resolution can't be
//       passed here. A forced hit overrides `result.category` regardless of
//       what the LLM said.
//   (b) run promoteEscalation() on the (possibly force/reverb-overridden)
//       category — only when both subject+body were supplied. A
//       notification→escalate promotion overrides the category again.
// Both steps respect their existing kill switches (SENDER_RULES_DISABLE,
// REVERB_ROUTING_DISABLE inside resolvePreclass; ESCALATION_PROMOTE_DISABLE
// here, same check classify-one.ts uses).
export async function POST(req: NextRequest) {
  const b = await parseJson(req, classificationNormalizeBodySchema);
  if (!b.ok) return b.response;
  const { raw, from, to, thread_id, subject, body } = b.data;

  try {
    const result = normalizeClassifierOutput(raw, { from, to });

    const couldSuppress =
      result.category === 'spam_marketing' || (result.route !== 'drop' && Boolean(thread_id));
    if (couldSuppress && (await isNeverSpamSender(from))) {
      const surfaced = normalizeClassifierOutput(raw, { from, to, neverSpam: true });
      console.log(
        `[classify] never-spam from=${from ?? ''} -> ${surfaced.category}/${surfaced.route} (owns-thread skipped)`,
      );
      return NextResponse.json(surfaced);
    }

    // UMB-154: async thread-ownership check. Short-circuit if already dropped
    // (saves a DB query on every spam/noreply/self-loop path) or if no
    // thread_id was provided (can't prove ownership without it → fail open).
    if (result.route !== 'drop' && thread_id) {
      const ownership = await operatorOwnsThread({ thread_id });
      if (ownership.owned) {
        const suppressed = {
          ...result,
          category: 'spam_marketing' as const,
          route: 'drop' as const,
          preclass_applied: true,
          preclass_source: 'operator-owns-thread' as const,
          suppression_reason: 'operator_owns_thread' as const,
        };
        console.log(
          `[classify] suppressed draft reason=operator_owns_thread from=${from ?? ''} thread=${thread_id} last_op_reply=${ownership.last_operator_reply_at ?? 'unknown'}`,
        );
        return NextResponse.json(suppressed);
      }
    }

    // Log self-loop suppressions too (set by precheckSelfLoop in normalize).
    if (result.suppression_reason === 'self_loop') {
      console.log(
        `[classify] suppressed draft reason=self_loop from=${from ?? ''} to=${to ?? ''} thread=${thread_id ?? ''}`,
      );
    }

    // Spec 002 FR7/FR7b (a) — SECOND, independent force/reverb precheck. Only
    // meaningful when `subject` is present (a force-mode sender rule doesn't
    // need it, but reverbRoute does); a `from` with no `subject` still runs a
    // force-mode sender-rule check (subject is simply ignored by reverbRoute).
    const preclass = await resolvePreclass(from, subject, { senderRuleLookup: senderRule });
    if (preclass.forced) {
      result.category = preclass.forced;
      result.confidence = 1;
      result.preclass_applied = true;
      result.preclass_source = preclass.preclass_source;
      result.route = routeFor(preclass.forced, 1);
    }

    // Spec 002 FR4 (b) — escalation-promotion, run on the (possibly
    // force/reverb-overridden) category above. Only when both subject+body
    // were supplied (optional-field backward compat — old callers omitting
    // either get a no-op here). Mirrors classify-one.ts's application of the
    // promotion result exactly (category override + escalation_signal +
    // important), gated by the same ESCALATION_PROMOTE_DISABLE kill switch.
    if (
      subject !== undefined &&
      body !== undefined &&
      process.env.ESCALATION_PROMOTE_DISABLE !== '1'
    ) {
      const promoted = promoteEscalation({ category: result.category, subject, body });
      if (promoted.promoted) {
        result.category = promoted.category;
        result.route = routeFor(promoted.category, result.confidence);
      }
      result.escalation_signal = promoted.escalation_signal;
      result.important = promoted.important;
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error('POST /api/internal/classification-normalize failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
