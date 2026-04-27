import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';

export const dynamic = 'force-dynamic';
const MAX_BODY = 10_000;

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const id = parseInt(params.id, 10);
  if (Number.isNaN(id)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const draftBody =
    typeof body.draft_body === 'string' ? body.draft_body : '';
  const draftSubject =
    typeof body.draft_subject === 'string' && body.draft_subject.trim()
      ? body.draft_subject
      : null;

  if (!draftBody.trim()) {
    return NextResponse.json({ error: 'Body required' }, { status: 400 });
  }
  if (draftBody.length > MAX_BODY) {
    return NextResponse.json(
      { error: `Body exceeds ${MAX_BODY} characters` },
      { status: 400 },
    );
  }

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
      [draftBody, draftSubject, id],
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
