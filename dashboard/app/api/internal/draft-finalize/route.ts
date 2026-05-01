import { type NextRequest, NextResponse } from 'next/server';
import { getPool, normalizeDraftBody } from '@/lib/db';
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

const FINALIZE_SQL = `
  UPDATE mailbox.drafts
     SET draft_body    = $2,
         draft_source  = $3,
         model         = $4,
         input_tokens  = $5,
         output_tokens = $6,
         cost_usd      = $7,
         updated_at    = NOW()
   WHERE id = $1
   RETURNING id, status, draft_source, model, input_tokens, output_tokens, cost_usd
`;

export async function POST(req: NextRequest) {
  const b = await parseJson(req, draftFinalizeBodySchema);
  if (!b.ok) return b.response;
  const { draft_id, body, source, model, input_tokens, output_tokens } = b.data;

  try {
    const cost_usd = computeCost(model, input_tokens, output_tokens);
    const cleanBody = normalizeDraftBody(body);

    const pool = getPool();
    const r = await pool.query(FINALIZE_SQL, [
      draft_id,
      cleanBody,
      source,
      model,
      input_tokens,
      output_tokens,
      cost_usd,
    ]);

    if (r.rowCount === 0) {
      return NextResponse.json({ error: `draft ${draft_id} not found` }, { status: 404 });
    }

    return NextResponse.json({
      ok: true,
      draft_id,
      cost_usd,
      ...r.rows[0],
    });
  } catch (error) {
    console.error('POST /api/internal/draft-finalize failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
