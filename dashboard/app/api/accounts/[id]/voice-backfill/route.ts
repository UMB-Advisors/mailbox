import { type NextRequest, NextResponse } from 'next/server';
import { runImapVoiceBackfill, VoiceBackfillError } from '@/lib/mail/imap-voice-backfill';
import { parseJson, parseParams } from '@/lib/middleware/validate';
import { extractPersona } from '@/lib/persona/extract';
import { listSentHistoryForExtraction, upsertPersona } from '@/lib/queries-persona';
import { accountIdParamSchema } from '@/lib/schemas/accounts';
import { voiceBackfillSchema } from '@/lib/schemas/persona';

// MBOX-373 (MBOX-162 V6 P2) — IMAP historical Sent-mail voice backfill, then
// immediately learn the voice. Closes the cold-start gap: a freshly connected
// IMAP inbox has no approved-draft history, so the account-scoped persona
// refresh (POST /api/persona/refresh) returns 409. This route first pulls the
// inbox's own Sent mailbox into mailbox.sent_history (runImapVoiceBackfill),
// then runs the SAME extract+upsert the refresh route does, in one call —
// so the "Learn voice" button on /settings/accounts works for IMAP day one.
//
// IMAP-only (Gmail's Sent history comes from the onboarding Gmail backfill;
// Microsoft is P2). Misconfig (not-found / wrong-provider / no credential) →
// 422; a still-empty sent_history after the pull → 409 (same shape as refresh).
//
// Privacy: extraction + ingest run entirely on-appliance — no sent-email
// content leaves Postgres during this call.

export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const p = parseParams(params, accountIdParamSchema);
  if (!p.ok) return p.response;
  const { id } = p.data;

  const parsed = await parseJson(request, voiceBackfillSchema);
  if (!parsed.ok) return parsed.response;

  try {
    const counts = await runImapVoiceBackfill(id, {
      lookbackHours: parsed.data.lookback_hours,
      maxMessages: parsed.data.max_messages,
    });

    // Same extract+upsert as POST /api/persona/refresh, account-scoped.
    const rows = await listSentHistoryForExtraction(undefined, id);
    if (rows.length === 0) {
      return NextResponse.json(
        {
          error:
            'No sent_history for this inbox after backfill — the Sent mailbox may be empty or unreachable',
          account_id: id,
        },
        { status: 409 },
      );
    }
    const result = extractPersona(rows);
    const persona = await upsertPersona(
      result.statistical_markers as unknown as Record<string, unknown>,
      result.category_exemplars as unknown as Record<string, unknown>,
      result.source_email_count,
      id,
    );

    return NextResponse.json({
      backfill: counts,
      persona,
      source_email_count: result.source_email_count,
    });
  } catch (error) {
    // A misconfigured account (not IMAP / not found / no credential) is a
    // caller/setup fault, not a server fault.
    if (error instanceof VoiceBackfillError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    // Full detail goes to the server log only — a raw imapflow/Kysely message
    // can carry host:port / server-banner internals, so the client gets an
    // opaque message (mirrors the connectImap 500 path).
    console.error(`POST /api/accounts/${id}/voice-backfill failed:`, error);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
