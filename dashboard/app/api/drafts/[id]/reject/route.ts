import { type NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { parseJson, parseParams } from '@/lib/middleware/validate';
import { idParamSchema } from '@/lib/schemas/common';
import { rejectBodySchema } from '@/lib/schemas/drafts';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const p = parseParams(params, idParamSchema);
  if (!p.ok) return p.response;
  const { id } = p.data;

  // rejectBodySchema treats `reason` as optional, so missing body parses to
  // { reason: null }.
  const b = await parseJson(req, rejectBodySchema);
  if (!b.ok) return b.response;
  const { reason } = b.data;

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
      return NextResponse.json({ error: 'Draft not in pending or edited state' }, { status: 409 });
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
