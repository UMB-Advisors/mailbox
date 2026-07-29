import { type NextRequest, NextResponse } from 'next/server';
import { ingestBatch } from '@/lib/oauth/gmail-ingest';

export const dynamic = 'force-dynamic';

// Account-agnostic Gmail ingestion — the single call the n8n loop makes.
//
// Server-side fetches every connected account's recent-unread mail (same tight
// query the legacy single-account Gmail node used) and returns a FLAT, normalized,
// account-tagged array. n8n then just splits this into items and POSTs each to
// /api/internal/inbox-messages (account_email already on the item) → classify.
// No Gmail credential, no MIME parsing, and no loop logic live in n8n — so adding
// a client account in the dashboard needs zero n8n changes.
//
//   GET /api/internal/gmail/ingest-batch?limit=25
//   -> { messages: NormalizedMessage[], per_account: [{account_id, account_email, count, error?}] }
export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get('limit');
  const limit = raw ? Number(raw) : 25;
  try {
    const result = await ingestBatch(Number.isFinite(limit) ? limit : 25);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'ingest batch failed' },
      { status: 500 },
    );
  }
}
