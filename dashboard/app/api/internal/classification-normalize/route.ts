import { type NextRequest, NextResponse } from 'next/server';
import { normalizeClassifierOutput } from '@/lib/classification/normalize';
import { parseJson } from '@/lib/middleware/validate';
import { classificationNormalizeBodySchema } from '@/lib/schemas/internal';

export const dynamic = 'force-dynamic';

// D-06 / MAIL-07 — strip <think> tokens, parse JSON, fall back to
// {category: 'unknown', confidence: 0} on any parse failure. Exposed for the
// n8n classify sub-workflow so normalization logic stays in code, not in JSON.
//
// D-50 — accept optional `from` / `to` so the deterministic operator-identity
// preclass in lib/classification/preclass.ts can override the LLM verdict.
export async function POST(req: NextRequest) {
  const b = await parseJson(req, classificationNormalizeBodySchema);
  if (!b.ok) return b.response;
  const { raw, from, to } = b.data;

  try {
    const result = normalizeClassifierOutput(raw, { from, to });
    return NextResponse.json(result);
  } catch (error) {
    console.error('POST /api/internal/classification-normalize failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
