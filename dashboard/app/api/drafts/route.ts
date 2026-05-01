import { type NextRequest, NextResponse } from 'next/server';
import { parseQuery } from '@/lib/middleware/validate';
import { listDrafts } from '@/lib/queries';
import { listDraftsQuerySchema } from '@/lib/schemas/drafts';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const q = parseQuery(req, listDraftsQuerySchema);
  if (!q.ok) return q.response;

  try {
    const drafts = await listDrafts(q.data.status, q.data.limit);
    return NextResponse.json({ drafts, total: drafts.length });
  } catch (error) {
    console.error('GET /api/drafts failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
