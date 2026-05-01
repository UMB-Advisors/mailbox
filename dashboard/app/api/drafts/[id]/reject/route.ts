import { sql } from 'kysely';
import { type NextRequest, NextResponse } from 'next/server';
import { getKysely } from '@/lib/db';
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
    const db = getKysely();
    const rows = await db
      .updateTable('drafts')
      .set({
        status: 'rejected',
        updated_at: sql<string>`NOW()`,
        error_message: reason,
      })
      .where('id', '=', id)
      .where('status', 'in', ['pending', 'edited'])
      .returning(['id', 'status'])
      .execute();
    if (rows.length === 0) {
      return NextResponse.json({ error: 'Draft not in pending or edited state' }, { status: 409 });
    }
    return NextResponse.json({ success: true, draft: rows[0] });
  } catch (error) {
    console.error(`POST /api/drafts/${id}/reject failed:`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
