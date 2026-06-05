import { NextResponse } from 'next/server';
import { listIngestAccounts } from '@/lib/oauth/gmail-ingest';

export const dynamic = 'force-dynamic';

// Account-agnostic Gmail ingestion — step 1 of the n8n loop.
//
// Returns every connected mailbox the loop should poll this cycle. Internal
// route (compose network only, not exposed via Caddy), mirroring
// /api/internal/inbox-messages. n8n hits this once per Schedule tick, then loops
// the result through /api/internal/gmail/token + the Gmail API. Connecting a new
// account in the dashboard makes it appear here automatically — no n8n change.
//
//   { accounts: [{ account_id: number, account_email: string }] }
export async function GET() {
  try {
    const accounts = await listIngestAccounts();
    return NextResponse.json({ accounts });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to list ingest accounts' },
      { status: 500 },
    );
  }
}
