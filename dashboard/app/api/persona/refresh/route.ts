import { NextResponse } from 'next/server';
import { extractPersona } from '@/lib/persona/extract';
import { listSentHistoryForExtraction, upsertPersona } from '@/lib/queries-persona';

// STAQPRO-153 — on-demand persona extraction.
//
// Privacy: extraction runs entirely on-appliance — no sent-email content
// leaves Postgres during this call. Heuristics live in lib/persona/extract.ts.
//
// Trigger surfaces today:
//   - PersonaSettings UI button (POST from the dashboard)
// Future surfaces (deferred):
//   - n8n weekly scheduled workflow
//   - on-boarding completion hook
//
// Returns the new persona row + the source row count.

export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    const rows = await listSentHistoryForExtraction();
    if (rows.length === 0) {
      return NextResponse.json(
        { error: 'No sent_history rows yet — send at least one approved draft first' },
        { status: 409 },
      );
    }
    const result = extractPersona(rows);
    const persona = await upsertPersona(
      result.statistical_markers as unknown as Record<string, unknown>,
      result.category_exemplars as unknown as Record<string, unknown>,
      result.source_email_count,
    );
    return NextResponse.json({ persona, source_email_count: result.source_email_count });
  } catch (error) {
    console.error('POST /api/persona/refresh failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
