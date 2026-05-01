import { sql } from 'kysely';
import { type NextRequest, NextResponse } from 'next/server';
import { getKysely, normalizeDraftBody } from '@/lib/db';
import { computeCost } from '@/lib/drafting/cost';
import { parseJson } from '@/lib/middleware/validate';
import { draftFinalizeBodySchema } from '@/lib/schemas/internal';

export const dynamic = 'force-dynamic';

// Single write path for the new draft-generation pipeline (Linus + Neo's
// API-boundary recommendation, 2026-04-30).
//
// n8n 04-draft-sub calls this AFTER the Ollama HTTP call returns. It hands us
// the body + token counts; we compute cost via PRICING (not n8n's job),
// validate, and persist. n8n never writes to mailbox.drafts directly for the
// new path.

export async function POST(req: NextRequest) {
  const b = await parseJson(req, draftFinalizeBodySchema);
  if (!b.ok) return b.response;
  const { draft_id, body, source, model, input_tokens, output_tokens } = b.data;

  try {
    const cost_usd = computeCost(model, input_tokens, output_tokens);
    const cleanBody = normalizeDraftBody(body);

    const db = getKysely();
    const rows = await db
      .updateTable('drafts')
      .set({
        draft_body: cleanBody,
        draft_source: source,
        model,
        input_tokens,
        output_tokens,
        cost_usd,
        updated_at: sql<string>`NOW()`,
      })
      .where('id', '=', draft_id)
      .returning([
        'id',
        'status',
        'draft_source',
        'model',
        'input_tokens',
        'output_tokens',
        'cost_usd',
      ])
      .execute();

    if (rows.length === 0) {
      return NextResponse.json({ error: `draft ${draft_id} not found` }, { status: 404 });
    }

    // rows[0].cost_usd is the persisted NUMERIC-as-string value — same shape
    // n8n's HTTP node previously consumed. computeCost(...) above is the
    // source-of-truth calculation; rows[0] echoes what was just written.
    return NextResponse.json({
      ok: true,
      draft_id,
      ...rows[0],
    });
  } catch (error) {
    console.error('POST /api/internal/draft-finalize failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
