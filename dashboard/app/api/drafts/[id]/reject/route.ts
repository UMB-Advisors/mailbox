import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const id = parseInt(params.id, 10);
  if (Number.isNaN(id)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }

  let reason: string | null = null;
  const body = await req.json().catch(() => null);
  if (body && typeof body.reason === 'string' && body.reason.trim()) {
    reason = body.reason.trim();
  }

  try {
    const pool = getPool();
    const result = await pool.query(
      `UPDATE mailbox.drafts
          SET status = 'rejected',
              updated_at = now(),
              error_message = $2
        WHERE id = $1
          AND status IN ('pending', 'edited')
        RETURNING id, status`,
      [id, reason],
    );
    if (result.rowCount === 0) {
      return NextResponse.json(
        { error: 'Draft not in pending or edited state' },
        { status: 409 },
      );
    }
    return NextResponse.json({ success: true, draft: result.rows[0] });
  } catch (error) {
    console.error(`POST /api/drafts/${id}/reject failed:`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
