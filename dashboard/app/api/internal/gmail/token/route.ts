import { type NextRequest, NextResponse } from 'next/server';
import { GmailIngestError, mintGmailAccessToken } from '@/lib/oauth/gmail-ingest';

export const dynamic = 'force-dynamic';

// Account-agnostic Gmail ingestion — step 2 of the n8n loop.
//
// Mints a fresh, short-lived Gmail access token for one connected account from
// its stored refresh token (the dashboard single source of truth, reflected into
// mailbox.oauth_tokens). n8n calls this per account inside the loop, then uses
// the returned bearer token against the Gmail REST API. The credential never
// lives in n8n — only this short-lived access token crosses the wire.
//
//   GET /api/internal/gmail/token?account_id=2
//   -> { account_id, account_email, access_token, expiry_date }
export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get('account_id');
  const accountId = Number(raw);
  if (!raw || !Number.isInteger(accountId) || accountId <= 0) {
    return NextResponse.json({ error: 'account_id (positive integer) is required' }, { status: 400 });
  }
  try {
    const t = await mintGmailAccessToken(accountId);
    return NextResponse.json(t);
  } catch (err) {
    if (err instanceof GmailIngestError) {
      const status = err.kind === 'not_connected' ? 404 : err.kind === 'transient' ? 503 : 401;
      return NextResponse.json({ error: err.message, kind: err.kind }, { status });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to mint token' },
      { status: 500 },
    );
  }
}
