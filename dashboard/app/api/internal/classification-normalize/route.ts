import { type NextRequest, NextResponse } from 'next/server';
import { normalizeClassifierOutput } from '@/lib/classification/normalize';
import {
  isHeuristicSpamDrop,
  isNeverSpamSender,
  neverSpamSurface,
} from '@/lib/classification/sender-allowlist';
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
// MBOX-370 — never-spam allowlist. After the sync verdict, if it's a heuristic
// spam drop (model or noreply heuristic — NOT a self-loop / owns-thread, which
// are about the conversation) AND the operator allowlisted this sender via
// /classifications, surface it (unknown→cloud) instead of dropping, so a sender
// they care about is never silently binned. The DB lookup runs ONLY on the
// spam path, so the common non-spam classify stays query-free. raw_output (the
// model's original JSON) is preserved for forensics.
export async function POST(req: NextRequest) {
  const b = await parseJson(req, classificationNormalizeBodySchema);
  if (!b.ok) return b.response;
  const { raw, from, to, thread_id } = b.data;

  try {
    const result = normalizeClassifierOutput(raw, { from, to });

    // MBOX-370: never-spam surface. Gate the DB lookup behind the spam-drop
    // check so non-spam classifies pay nothing; isNeverSpamSender fails open.
    if (
      isHeuristicSpamDrop(result.category, result.preclass_source) &&
      (await isNeverSpamSender(from))
    ) {
      const surfaced = {
        ...result,
        ...neverSpamSurface(result.confidence),
        preclass_applied: true,
        suppression_reason: null,
      };
      console.log(
        `[classify] never-spam surfaced from=${from ?? ''} was=spam_marketing -> ${surfaced.category}/${surfaced.route}`,
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

    return NextResponse.json(result);
  } catch (error) {
    console.error('POST /api/internal/classification-normalize failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
