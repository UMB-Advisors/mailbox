import { NextRequest, NextResponse } from 'next/server';
import { listDrafts, VALID_STATUSES } from '@/lib/queries';
import type { DraftStatus } from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const statusParam = searchParams.get('status') ?? 'pending';
  const limitParam = searchParams.get('limit') ?? '50';

  const requested = statusParam
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const validStatuses = requested.filter((s): s is DraftStatus =>
    VALID_STATUSES.includes(s as DraftStatus),
  );
  const statuses: DraftStatus[] =
    validStatuses.length > 0 ? validStatuses : ['pending'];
  const limit = parseInt(limitParam, 10) || 50;

  try {
    const drafts = await listDrafts(statuses, limit);
    return NextResponse.json({ drafts, total: drafts.length });
  } catch (error) {
    console.error('GET /api/drafts failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
