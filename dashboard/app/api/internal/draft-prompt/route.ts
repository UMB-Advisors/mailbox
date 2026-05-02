import { sql } from 'kysely';
import { type NextRequest, NextResponse } from 'next/server';
import type { Category } from '@/lib/classification/prompt';
import { getKysely } from '@/lib/db';
import { getPersonaContext } from '@/lib/drafting/persona';
import { assemblePrompt } from '@/lib/drafting/prompt';
import { pickEndpoint } from '@/lib/drafting/router';
import { parseJson } from '@/lib/middleware/validate';
import { retrieveForDraft } from '@/lib/rag/retrieve';
import { draftPromptBodySchema } from '@/lib/schemas/internal';

// STAQPRO-191 — single-persona appliances all use 'default'. When
// multi-persona ships, this becomes a per-draft lookup against
// mailbox.drafts.persona_key (or whichever join makes sense at the time).
// Centralized so both the persona resolver and the retrieval filter use
// the SAME value — they MUST match or retrieval returns zero hits.
const DEFAULT_PERSONA_KEY = 'default';

export const dynamic = 'force-dynamic';

// D-41 — single source of truth for the drafting prompt. Consumed by
// n8n 04-draft-sub at runtime so the prompt cannot drift between local and
// cloud paths.
//
// Returns the messages payload AND the endpoint/model/credentials chosen by
// router.ts. n8n's HTTP Request node uses the returned baseUrl + apiKey + model
// to call Ollama (local daemon or Ollama Cloud — same /api/chat schema).
//
// POST (not GET) because the response includes secrets (Ollama Cloud API key)
// that should not appear in proxy logs as a query string.

export async function POST(req: NextRequest) {
  const b = await parseJson(req, draftPromptBodySchema);
  if (!b.ok) return b.response;
  const { draft_id } = b.data;

  try {
    const db = getKysely();
    const row = await db
      .selectFrom('drafts')
      .select([
        'id',
        'from_addr',
        'to_addr',
        'subject',
        'body_text',
        'classification_category',
        'classification_confidence',
      ])
      .where('id', '=', draft_id)
      .limit(1)
      .executeTakeFirst();
    if (!row) {
      return NextResponse.json({ error: `draft ${draft_id} not found` }, { status: 404 });
    }
    const classification_category = row.classification_category as Category | null;

    if (!classification_category) {
      // Fail closed — every draft row should be created post-classify with a
      // category populated. If we got here, the upstream pipeline broke.
      return NextResponse.json(
        {
          error: `draft ${draft_id} has no classification_category — upstream classify did not complete`,
        },
        { status: 422 },
      );
    }

    const persona = await getPersonaContext(DEFAULT_PERSONA_KEY);
    const confidence = row.classification_confidence ?? 0;

    // STAQPRO-191 — pick the endpoint BEFORE assembling the prompt because
    // the retrieval privacy gate depends on draft_source ('local' always
    // retrieves; 'cloud' is opt-in via RAG_CLOUD_ROUTE_ENABLED=1). The
    // existing call order ran pickEndpoint after assemble; reordering is
    // safe — pickEndpoint is pure and doesn't depend on assembled state.
    const endpoint = pickEndpoint(classification_category, confidence);

    const retrieval = await retrieveForDraft({
      from_addr: row.from_addr ?? '',
      subject: row.subject ?? null,
      body_text: row.body_text ?? null,
      draft_source: endpoint.source,
      persona_key: DEFAULT_PERSONA_KEY,
    });

    const assembled = assemblePrompt({
      from_addr: row.from_addr ?? '',
      to_addr: row.to_addr ?? '',
      subject: row.subject ?? '',
      body_text: row.body_text ?? '',
      category: classification_category,
      confidence,
      persona,
      // assemblePrompt's rag_refs accepts the {source, excerpt} subset;
      // retrieve.ts returns a richer shape but the extra fields (point_id,
      // score, direction, sent_at) are dropped by structural typing.
      rag_refs: retrieval.refs,
    });

    // STAQPRO-191 — unconditional writeback. Always persist refs + reason,
    // even when refs is empty, so the eval delta (STAQPRO-192 phase 2) can
    // distinguish 'no_hits' from 'embed_unavailable' / 'qdrant_unavailable' /
    // 'cloud_gated'. Awaited; sub-ms on local Postgres. n8n needs the response
    // anyway, so a sync write is fine.
    const refIds = retrieval.refs.map((r) => r.point_id);
    await db
      .updateTable('drafts')
      .set({
        rag_context_refs: sql`${JSON.stringify(refIds)}::jsonb`,
        rag_retrieval_reason: retrieval.reason,
      })
      .where('id', '=', draft_id)
      .execute();

    return NextResponse.json({
      draft_id,
      // Endpoint config for n8n's HTTP Request node.
      baseUrl: endpoint.baseUrl,
      apiKey: endpoint.apiKey,
      model: endpoint.model,
      source: endpoint.source,
      display_label: endpoint.display_label,
      // Prompt payload — drop straight into the chat-completions body.
      messages: assembled.messages,
      max_tokens: assembled.max_tokens,
      temperature: assembled.temperature,
      // STAQPRO-191 — RAG audit signal for n8n logging + dashboard debug
      // surface. refs_count is what dashboards graph; reason is what
      // eval/triage scripts filter on.
      rag: {
        refs_count: retrieval.refs.length,
        reason: retrieval.reason,
      },
    });
  } catch (error) {
    console.error('POST /api/internal/draft-prompt failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
