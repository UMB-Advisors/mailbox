import { NextResponse } from 'next/server';
import { listAccounts } from '@/lib/queries-accounts';

export const dynamic = 'force-dynamic';

// GET /api/accounts — MBOX-360 (MBOX-162 V3).
//
// Operator-facing (Caddy basic_auth gated, NOT /api/internal). Powers the
// queue's account filter/selector: the connected inboxes on this appliance.
// Single-account boxes return one row (the seeded default account); the
// selector renders inert until a 2nd inbox is connected.
export async function GET() {
  try {
    const accounts = await listAccounts();
    return NextResponse.json({ accounts });
  } catch (error) {
    console.error('GET /api/accounts failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
