import { NextRequest, NextResponse } from 'next/server';
import { getPool, normalizeDraftBody } from '@/lib/db';
import { computeCost } from '@/lib/drafting/cost';
import type { DraftSource } from '@/lib/drafting/router';

export const dynamic = 'force-dynamic';

// Single write path for the new draft-generation pipeline (Linus + Neo's
// API-boundary recommendation, 2026-04-30).
//
// n8n 04-draft-sub calls this AFTER the Ollama HTTP call returns. It hands us
// the body + token counts; we compute cost via PRICING (not n8n's job),
// validate, and persist. n8n never writes to mailbox.drafts directly for the
// new path.
//
// Status transitions: drafts row is created with status='pending' by the
// classify sub-workflow's Insert Draft Stub. After this route writes the body,
// status STAYS 'pending' (waiting for operator approval). The 'sending' state
// Neo recommended is a follow-up issue (STAQPRO-137 update).

const VALID_SOURCES = new Set<DraftSource>(['local', 'cloud']);

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

interface FinalizePayload {
  draft_id?: number;
  body?: string;
  source?: string;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
}

export async function POST(req: NextRequest) {
  try {
    const payload = (await req.json().catch(() => null)) as FinalizePayload | null;
    if (!payload) {
      return NextResponse.json({ error: 'JSON body required' }, { status: 400 });
    }

    const { draft_id, body, source, model } = payload;
    const input_tokens = Number(payload.input_tokens ?? 0);
    const output_tokens = Number(payload.output_tokens ?? 0);

    if (typeof draft_id !== 'number' || !Number.isFinite(draft_id)) {
      return NextResponse.json(
        { error: 'draft_id (number) required' },
        { status: 400 },
      );
    }
    if (typeof body !== 'string' || body.trim().length === 0) {
      return NextResponse.json(
        { error: 'body (non-empty string) required' },
        { status: 400 },
      );
    }
    if (typeof source !== 'string' || !VALID_SOURCES.has(source as DraftSource)) {
      return NextResponse.json(
        { error: `source must be one of: ${[...VALID_SOURCES].join(', ')}` },
        { status: 400 },
      );
    }
    if (typeof model !== 'string' || model.trim().length === 0) {
      return NextResponse.json(
        { error: 'model (non-empty string) required' },
        { status: 400 },
      );
    }
    if (!Number.isFinite(input_tokens) || input_tokens < 0) {
      return NextResponse.json(
        { error: 'input_tokens must be a non-negative number' },
        { status: 400 },
      );
    }
    if (!Number.isFinite(output_tokens) || output_tokens < 0) {
      return NextResponse.json(
        { error: 'output_tokens must be a non-negative number' },
        { status: 400 },
      );
    }

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
      return NextResponse.json(
        { error: `draft ${draft_id} not found` },
        { status: 404 },
      );
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
