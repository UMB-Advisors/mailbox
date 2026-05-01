import { NextRequest, NextResponse } from 'next/server';
import { buildPrompt, MODEL_VERSION } from '@/lib/classification/prompt';
import { parseJson } from '@/lib/middleware/validate';
import { classificationPromptBodySchema } from '@/lib/schemas/internal';

export const dynamic = 'force-dynamic';

// D-29 — single source of truth for classification prompt. Consumed by n8n
// classify sub-workflow at run time so the prompt cannot drift between live
// pipeline and scoring script.
//
// POST (not GET, per D-29 letter) because email bodies are too large for a
// query string. Behavior is still pure & read-only.
export async function POST(req: NextRequest) {
  const b = await parseJson(req, classificationPromptBodySchema);
  if (!b.ok) return b.response;

  try {
    const prompt = buildPrompt(b.data);
    return NextResponse.json({ prompt, model: MODEL_VERSION });
  } catch (error) {
    console.error('POST /api/internal/classification-prompt failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
