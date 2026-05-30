import { type NextRequest, NextResponse } from 'next/server';
import { parseJson } from '@/lib/middleware/validate';
import { extractPersona } from '@/lib/persona/extract';
import { listSentHistoryForExtraction, upsertPersona } from '@/lib/queries-persona';
import { personaRefreshSchema } from '@/lib/schemas/persona';

// STAQPRO-153 — on-demand persona extraction. MBOX-373 (MBOX-162 V6 P1) — now
// account-scoped: `{ account_id }` in the body targets a specific inbox's
// persona; omitted = the default account (unchanged legacy behavior).
//
// Privacy: extraction runs entirely on-appliance — no sent-email content
// leaves Postgres during this call. Heuristics live in lib/persona/extract.ts.
//
// Trigger surfaces:
//   - PersonaSettings UI button (default account, no body)
//   - "Learn voice" per-account button in /settings/accounts (MBOX-373) → body { account_id }
// Future surfaces (deferred): n8n weekly scheduled workflow; onboarding hook.
//
// Returns the new persona row + the source row count.

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const parsed = await parseJson(request, personaRefreshSchema);
  if (!parsed.ok) return parsed.response;
  const accountId = parsed.data.account_id;

  try {
    const rows = await listSentHistoryForExtraction(undefined, accountId);
    if (rows.length === 0) {
      return NextResponse.json(
        {
          error:
            'No sent_history for this inbox yet — approve at least one of its drafts (or run a Sent-history backfill) before learning its voice',
          account_id: accountId ?? null,
        },
        { status: 409 },
      );
    }
    const result = extractPersona(rows);
    const persona = await upsertPersona(
      result.statistical_markers as unknown as Record<string, unknown>,
      result.category_exemplars as unknown as Record<string, unknown>,
      result.source_email_count,
      accountId,
    );
    return NextResponse.json({ persona, source_email_count: result.source_email_count });
  } catch (error) {
    console.error('POST /api/persona/refresh failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
