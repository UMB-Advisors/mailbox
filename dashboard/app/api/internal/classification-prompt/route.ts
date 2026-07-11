import { type NextRequest, NextResponse } from 'next/server';
import { buildFramedPrompt } from '@/lib/classification/classify-one';
import { retrieveClassificationExemplars } from '@/lib/classification/exemplars';
import { MODEL_VERSION } from '@/lib/classification/prompt';
import { resolvePreclass } from '@/lib/classification/resolve-preclass';
import { senderRule } from '@/lib/classification/sender-rules';
import { parseJson } from '@/lib/middleware/validate';
import { classificationPromptBodySchema } from '@/lib/schemas/internal';

export const dynamic = 'force-dynamic';

// D-29 — single source of truth for classification prompt. Consumed by n8n
// classify sub-workflow at run time so the prompt cannot drift between live
// pipeline and scoring script.
//
// POST (not GET, per D-29 letter) because email bodies are too large for a
// query string. Behavior is still pure & read-only.
//
// CPG-scrub Phase 1 (2026-05-08): the system framing is now persona-derived
// instead of hardcoded "small CPG brand operator". Pulls business_description
// from the operator's persona override (set during onboarding) and templates
// it into the classifier prompt. Falls back to generic "small business
// operator" framing when business_description is empty. This is now handled
// by the shared `buildFramedPrompt` (lib/classification/classify-one.ts) —
// the sweeper/backfill path and this route render the identical framing.
//
// Spec 002 FR7/FR7b — n8n's fixed node chain always calls this route BEFORE
// `classification-normalize` runs, so a `force`-mode sender rule doesn't
// change what we do here: we still build and return a normal, valid prompt
// (n8n's `Call Ollama` node downstream has nothing to send otherwise).
// Correctness for a force sender doesn't depend on this prompt — the
// normalize route independently re-resolves force/reverb and overrides the
// category regardless of what the LLM said. A `bias`-mode rule DOES change
// what we do here: its suggested bucket is injected as a senderPrior hint,
// and the exemplar retrieval is biased toward it.
export async function POST(req: NextRequest) {
  const b = await parseJson(req, classificationPromptBodySchema);
  if (!b.ok) return b.response;

  try {
    const preclass = await resolvePreclass(b.data.from, b.data.subject, {
      senderRuleLookup: senderRule,
    });
    const exemplars = await retrieveClassificationExemplars({
      senderPrior: preclass.senderPrior,
      subject: b.data.subject,
    });
    const prompt = await buildFramedPrompt(
      {
        id: 0,
        from_addr: b.data.from,
        to_addr: null,
        subject: b.data.subject,
        body: b.data.body,
        snippet: null,
      },
      preclass.senderPrior,
      exemplars,
    );
    return NextResponse.json({ prompt, model: MODEL_VERSION });
  } catch (error) {
    console.error('POST /api/internal/classification-prompt failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
