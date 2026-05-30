import { type NextRequest, NextResponse } from 'next/server';
import { parseParams } from '@/lib/middleware/validate';
import { extractPersona } from '@/lib/persona/extract';
import { listSentHistoryForExtraction, upsertPersona } from '@/lib/queries-persona';
import { accountIdParamSchema } from '@/lib/schemas/accounts';
import { runImapVoiceBackfill, VoiceBackfillError } from '@/lib/voice/imap-backfill';

// MBOX-373 (MBOX-162 V6 P2) — IMAP voice bootstrap for one inbox: pull its
// historical Sent mail into sent_history, then run the account-scoped persona
// extraction. One operator action ("Learn voice" on an IMAP inbox) = full cold
// start. Caddy basic_auth gated.
//
// POST /api/accounts/[id]/voice-backfill
//   200 { account_id, fetched, inserted, source_email_count, learned }
//   400 not an IMAP inbox · 404 unknown · 409 no credential / no Sent mail found
//   422 bad provider_config · 502 IMAP connection/fetch failed

export const dynamic = 'force-dynamic';

const ERROR_STATUS: Record<VoiceBackfillError['code'], number> = {
  not_found: 404,
  not_imap: 400,
  no_credential: 409,
  bad_config: 422,
};

export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const p = parseParams(params, accountIdParamSchema);
  if (!p.ok) return p.response;
  const { id } = p.data;

  let fetched = 0;
  let inserted = 0;
  try {
    const res = await runImapVoiceBackfill(id);
    fetched = res.fetched;
    inserted = res.inserted;
  } catch (error) {
    if (error instanceof VoiceBackfillError) {
      return NextResponse.json(
        { error: error.code, message: error.message },
        { status: ERROR_STATUS[error.code] },
      );
    }
    // imapflow / network / auth failures bubble up here — the inbox is connected
    // in the registry but its credential/host didn't accept the read connection.
    console.error(`POST /api/accounts/${id}/voice-backfill — IMAP fetch failed:`, error);
    return NextResponse.json(
      {
        error: 'imap_fetch_failed',
        message: error instanceof Error ? error.message : 'IMAP connection failed',
      },
      { status: 502 },
    );
  }

  try {
    // Now extract this inbox's persona from everything in its sent_history
    // (the just-backfilled rows + anything it had already accumulated).
    const rows = await listSentHistoryForExtraction(undefined, id);
    if (rows.length === 0) {
      return NextResponse.json(
        {
          error: 'no_sent_mail',
          message: 'No Sent mail found for this inbox to learn from',
          account_id: id,
          fetched,
          inserted,
        },
        { status: 409 },
      );
    }
    const result = extractPersona(rows);
    await upsertPersona(
      result.statistical_markers as unknown as Record<string, unknown>,
      result.category_exemplars as unknown as Record<string, unknown>,
      result.source_email_count,
      id,
    );
    return NextResponse.json({
      account_id: id,
      fetched,
      inserted,
      source_email_count: result.source_email_count,
      learned: true,
    });
  } catch (error) {
    console.error(`POST /api/accounts/${id}/voice-backfill — persona extract failed:`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
