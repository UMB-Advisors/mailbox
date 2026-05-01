import { sql } from 'kysely';
import { type NextRequest, NextResponse } from 'next/server';
import type { Category } from '@/lib/classification/prompt';
import { getKysely } from '@/lib/db';
import { getPersonaContext } from '@/lib/drafting/persona-stub';
import { assemblePrompt } from '@/lib/drafting/prompt';
import { pickEndpoint } from '@/lib/drafting/router';
import { parseJson } from '@/lib/middleware/validate';
import { retrieveForDraft } from '@/lib/rag/retrieve';
import { draftPromptBodySchema } from '@/lib/schemas/internal';

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

    const persona = await getPersonaContext();
    const confidence = row.classification_confidence ?? 0;
    const endpoint = pickEndpoint(classification_category, confidence);

    // STAQPRO-191 — retrieval at draft time. Gated to local route by
    // default (privacy: per-call cloud egress should not include retrieved
    // local corpus snippets unless operator opts in via
    // RAG_CLOUD_ROUTE_ENABLED=1). Failures return empty refs and the
    // existing persona-stub path remains the fallback.
    const retrieval = await retrieveForDraft({
      from_addr: row.from_addr ?? '',
      subject: row.subject ?? null,
      body_text: row.body_text ?? null,
      draft_source: endpoint.source,
    });

    if (retrieval.refs.length > 0) {
      // Persist point IDs into drafts.rag_context_refs for traceability
      // (STAQPRO-192 phase 2 reads this). Non-blocking: a write failure
      // here MUST NOT prevent draft assembly downstream.
      const refsJson = JSON.stringify(retrieval.refs.map((r) => r.point_id));
      try {
        await db
          .updateTable('drafts')
          .set({
            rag_context_refs: sql`${refsJson}::jsonb`,
            updated_at: sql<string>`NOW()`,
          })
          .where('id', '=', draft_id)
          .execute();
      } catch (err) {
        console.error(`[rag] persisting rag_context_refs for draft ${draft_id} failed:`, err);
      }
    }

    const assembled = assemblePrompt({
      from_addr: row.from_addr ?? '',
      to_addr: row.to_addr ?? '',
      subject: row.subject ?? '',
      body_text: row.body_text ?? '',
      category: classification_category,
      confidence,
      persona,
      rag_refs: retrieval.refs.map((r) => ({ source: r.source, excerpt: r.excerpt })),
    });

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
      // STAQPRO-191 — surface retrieval status so n8n / smoke tests can log it.
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
