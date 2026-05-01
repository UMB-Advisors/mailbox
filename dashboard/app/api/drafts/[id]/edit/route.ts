import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { parseJson, parseParams } from '@/lib/middleware/validate';
import { idParamSchema } from '@/lib/schemas/common';
import { editBodySchema } from '@/lib/schemas/drafts';

export const dynamic = 'force-dynamic';

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const p = parseParams(params, idParamSchema);
  if (!p.ok) return p.response;
  const { id } = p.data;

  const b = await parseJson(req, editBodySchema);
  if (!b.ok) return b.response;
  const { draft_body, draft_subject } = b.data;

  try {
    const pool = getPool();
    const result = await pool.query(
      `UPDATE mailbox.drafts
          SET draft_body = $1,
              draft_subject = $2,
              status = 'edited',
              updated_at = now()
        WHERE id = $3
          AND status IN ('pending', 'edited')
        RETURNING id, status, draft_body, draft_subject, updated_at`,
      [draft_body, draft_subject, id],
    );
    if (result.rowCount === 0) {
      return NextResponse.json(
        { error: 'Draft not in pending or edited state' },
        { status: 409 },
      );
    }
    return NextResponse.json({ success: true, draft: result.rows[0] });
  } catch (error) {
    console.error(`POST /api/drafts/${id}/edit failed:`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
