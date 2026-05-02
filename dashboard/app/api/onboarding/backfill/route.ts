import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getKysely } from '@/lib/db';
import { parseJson } from '@/lib/middleware/validate';
import { runGmailHistoryBackfill } from '@/lib/onboarding/gmail-history-backfill';
import { onboardingBackfillRequestSchema } from '@/lib/schemas/onboarding';

export const dynamic = 'force-dynamic';
// Backfill can run for several minutes against larger mailboxes; explicit
// long timeout so the App Router default doesn't 504 on us.
export const maxDuration = 600;

// STAQPRO-193 — Gmail Sent backfill HTTP entry point. Operator-facing,
// inherits Caddy basic_auth via the existing /api/* matcher. Per Locked
// Decision #3, the CLI (`npm run onboarding:backfill`) is the canonical
// production surface — this route is the thin hook so the M4 onboarding
// wizard can fire backfill in one call without re-implementing the
// orchestration.
//
// Body: { days_lookback?: number = 180, max_messages?: number }
// Response: { ok: true, counts: BackfillCounts } on success.
//
// MAILBOX_OPERATOR_EMAIL must be set in the environment — it identifies
// which messages in each thread are "my reply". A missing env returns 500
// with a structured error so the wizard can surface a clear failure.

export async function POST(req: NextRequest): Promise<Response> {
  const parsed = await parseJson(req, onboardingBackfillRequestSchema);
  if (!parsed.ok) return parsed.response;

  const operatorEmail = process.env.MAILBOX_OPERATOR_EMAIL;
  if (!operatorEmail) {
    return NextResponse.json(
      {
        ok: false,
        error: 'misconfigured',
        message: 'MAILBOX_OPERATOR_EMAIL must be set in the dashboard service env',
      },
      { status: 500 },
    );
  }

  const fetchHistoryUrl =
    process.env.MAILBOX_FETCH_HISTORY_URL ?? 'http://n8n:5678/webhook/mailbox-fetch-history';
  const envMax = Number(process.env.RAG_BACKFILL_MAX_MESSAGES ?? 5000);
  const max_messages = parsed.data.max_messages ?? envMax;

  const startedAt = Date.now();
  try {
    const counts = await runGmailHistoryBackfill(
      {
        days_lookback: parsed.data.days_lookback,
        max_messages,
        operator_email: operatorEmail,
        fetch_history_url: fetchHistoryUrl,
      },
      { db: getKysely() },
    );
    return NextResponse.json({
      ok: true,
      days_lookback: parsed.data.days_lookback,
      max_messages,
      elapsed_ms: Date.now() - startedAt,
      counts,
    });
  } catch (err) {
    console.error('POST /api/onboarding/backfill failed:', err);
    return NextResponse.json(
      {
        ok: false,
        error: 'backfill_failed',
        message: err instanceof Error ? err.message : 'unknown',
        elapsed_ms: Date.now() - startedAt,
      },
      { status: 502 },
    );
  }
}
