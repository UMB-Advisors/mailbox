import { NextRequest, NextResponse } from 'next/server';
import { normalizeClassifierOutput } from '@/lib/classification/normalize';

export const dynamic = 'force-dynamic';

// D-06 / MAIL-07 — strip <think> tokens, parse JSON, fall back to
// {category: 'unknown', confidence: 0} on any parse failure. Exposed for the
// n8n classify sub-workflow so normalization logic stays in code, not in JSON.
export async function POST(req: NextRequest) {
  try {
    const { raw } = (await req.json()) as { raw?: string };
    const result = normalizeClassifierOutput(raw ?? '');
    return NextResponse.json(result);
  } catch (error) {
    console.error('POST /api/internal/classification-normalize failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
