// dashboard/app/api/internal/ota/update-now/route.ts
//
// MBOX-349 — customer-initiated OTA "Update now" execute path. The HTTP
// surface for the orchestration in lib/ota/update.ts (pull → recreate →
// migrate → smoke → commit-or-rollback), with a per-update audit row written
// by that module at each transition.
//
// ── GUARDS (mirror lib/transitions.ts) ──────────────────────────────────────
// An OTA update recreates the whole compose stack — it MUST NOT run while:
//   1. Gmail is in a rate-limit cooldown (a recreate mid-cooldown loses the
//      in-memory state n8n holds and can re-trigger sends — block like the
//      approve/retry path does, returning 409 BEFORE any audit row / shell).
//   2. A draft is genuinely in flight (the pipeline is mid-draft; tearing the
//      stack down would orphan it). Reuse the honest in-flight flag from
//      MBOX-288 (getDraftingFlag) — same source of truth the chat UI uses.
// Guarding here (not in lib/ota/update.ts) keeps the state machine pure and
// the audit log clean: a refused update never writes a 'started' row.
//
// Lives under /api/internal/* so it is reachable from the docker network and
// is NOT Caddy basic_auth gated; the operator-facing button calls it through
// the dashboard basePath. Treated as a trust-boundary input regardless —
// zod-validated per STAQPRO-138.

import { type NextRequest, NextResponse } from 'next/server';
import { parseJson } from '@/lib/middleware/validate';
import { makeDefaultShell, runOtaUpdate } from '@/lib/ota/update';
import { getDraftingFlag } from '@/lib/queries-drafting-flag';
import { getGmailCooldown } from '@/lib/queries-system-state';
import { otaUpdateNowBodySchema } from '@/lib/schemas/internal';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<NextResponse> {
  const b = await parseJson(req, otaUpdateNowBodySchema);
  if (!b.ok) return b.response;

  // Guard 1 — Gmail cooldown. Same gate as approve/retry (transitions.ts
  // STAQPRO-231). 409 BEFORE any audit row or shell call so a refused update
  // leaves no 'started' ghost in the audit log.
  const cooldown = await getGmailCooldown();
  if (cooldown.isActive && cooldown.until) {
    return NextResponse.json(
      {
        error: 'gmail_rate_limit_active',
        message: 'Gmail is rate-limited. Update paused — recreating the stack now could lose send state.',
        next_safe_at: cooldown.recommended_safe_at?.toISOString() ?? cooldown.until.toISOString(),
      },
      { status: 409 },
    );
  }

  // Guard 2 — in-flight draft. Honest flag from MBOX-288; refuse so a recreate
  // doesn't orphan an active draft mid-pipeline.
  const flag = await getDraftingFlag();
  if (flag.drafting) {
    return NextResponse.json(
      {
        error: 'draft_in_flight',
        message: 'A draft is being generated right now. Wait for it to finish before updating.',
        draft_id: flag.draft_id,
      },
      { status: 409 },
    );
  }

  // Guards clear — run the orchestration. The state machine is total-failure-
  // safe and writes its own audit rows; we just shape the HTTP response from
  // its outcome. A 'succeeded'/'rolled_back' outcome is a 200 (the update path
  // ran to a clean terminal state); a 'failed' outcome (rollback itself threw)
  // is a 500 so the operator escalates.
  const outcome = await runOtaUpdate(makeDefaultShell(), {
    fromDigest: b.data.from_digest ?? null,
    toDigest: b.data.to_digest ?? null,
  });

  const httpStatus = outcome.result === 'failed' ? 500 : 200;
  return NextResponse.json(outcome, { status: httpStatus });
}
