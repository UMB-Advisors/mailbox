import { sql } from 'kysely';
import { type NextRequest, NextResponse } from 'next/server';
import type { Category } from '@/lib/classification/prompt';
import { getKysely } from '@/lib/db';
import { getCategoryExemplars } from '@/lib/drafting/exemplars';
import { getPersonaContext } from '@/lib/drafting/persona';
import { assemblePrompt } from '@/lib/drafting/prompt';
import { pickEndpoint } from '@/lib/drafting/router';
import { stripQuotedAndSignature } from '@/lib/drafting/strip-quoting';
import { getThreadHistory } from '@/lib/drafting/thread-history';
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
        // STAQPRO-219 — passed into retrieveForDraft so it can compute the
        // inbound's own point UUID and exclude it via must_not.has_id.
        'message_id',
        // STAQPRO-222 (H3) — passed into retrieveForDraft so it can drop
        // every same-thread point from retrieval via must_not on
        // payload.thread_id (gated by RAG_RETRIEVE_EXCLUDE_SAME_THREAD).
        'thread_id',
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

    // STAQPRO-341 — strip quoted thread history + signatures from the
    // inbound body before it enters the prompt. Pure function; sub-ms.
    // Applied here (not in assemblePrompt) so the stripped body is also
    // available for downstream instrumentation (audit log, response).
    const strippedInbound = stripQuotedAndSignature(row.body_text ?? '');

    // STAQPRO-234 + STAQPRO-341 — run RAG retrieval, sent_history exemplar
    // mining, and same-thread history fetch in parallel. All three are
    // read-only and independent; exemplar + thread-history queries run
    // entirely in postgres (no Qdrant / no Ollama embed) so they add <10ms.
    // Default k=1 keeps the budget at 1 exemplar (~600c) + 2 RAG refs
    // (~1200c), the same ~450-token augmentation slice as before per
    // prompt.ts:effectiveRagRefsCap. Thread history has its own char budget
    // (THREAD_HISTORY_CHAR_BUDGET, default 6000c) and sits in the existing
    // MAX_THREAD_CHARS=2000c assemblePrompt slot — the in-module 50-row
    // SQL LIMIT + per-message strip keeps the join cheap.
    const [retrieval, exemplars, threadHistory] = await Promise.all([
      retrieveForDraft({
        from_addr: row.from_addr ?? '',
        subject: row.subject ?? null,
        body_text: row.body_text ?? null,
        draft_source: endpoint.source,
        persona_key: DEFAULT_PERSONA_KEY,
        // STAQPRO-219 — drop self-match from retrieval via must_not.has_id.
        message_id: row.message_id,
        // STAQPRO-222 (H3) — drop every same-thread point from retrieval
        // via must_not on payload.thread_id. Default-on; flag-gated by
        // RAG_RETRIEVE_EXCLUDE_SAME_THREAD env var inside retrieveForDraft.
        thread_id: row.thread_id,
      }),
      getCategoryExemplars(classification_category, 1, DEFAULT_PERSONA_KEY),
      getThreadHistory({
        thread_id: row.thread_id,
        message_id: row.message_id,
        draft_source: endpoint.source,
      }),
    ]);

    const assembled = assemblePrompt({
      from_addr: row.from_addr ?? '',
      to_addr: row.to_addr ?? '',
      subject: row.subject ?? '',
      // STAQPRO-341 — feed the stripped inbound body, not the raw row body.
      // Quoted nested threads + signature lines were taking ~half the local
      // model's 4k ctx before this lands.
      body_text: strippedInbound.body,
      category: classification_category,
      confidence,
      persona,
      // assemblePrompt's rag_refs / kb_refs accept the {source, excerpt}
      // subset; retrieve.ts returns richer shapes but the extra fields are
      // dropped by structural typing.
      rag_refs: retrieval.refs,
      kb_refs: retrieval.kb_refs,
      // STAQPRO-234 — past-reply exemplars from sent_history. When the array
      // is empty (early-onboarding category, sent_history miss), prompt.ts
      // falls back to today's 3-RAG-ref default — graceful degrade.
      exemplar_refs: exemplars.map((e) => ({
        snippet: e.snippet,
        sent_at: e.sent_at,
        subject: e.subject,
      })),
      // STAQPRO-341 — same-thread prior messages walked via thread_id.
      // assemblePrompt's threadBlock truncates at MAX_THREAD_CHARS=2000c
      // and renders one "From: ..." block per message. Empty array = no
      // history available / gated / disabled (graceful degrade).
      thread_context: threadHistory.messages.map((m) => ({
        from_addr: m.from_addr,
        body_text: m.body_text,
      })),
    });

    // STAQPRO-191/148 — unconditional writeback. Always persist BOTH refs
    // + reasons, even when arrays are empty, so the eval delta
    // (STAQPRO-192 phase 2) can distinguish 'no_hits' from
    // 'embed_unavailable' / 'qdrant_unavailable' / 'cloud_gated' /
    // 'kb_cloud_gated'. Awaited; sub-ms on local Postgres. n8n needs the
    // response anyway, so a sync write is fine.
    //
    // Note: rag_retrieval_reason carries the EMAIL retrieval reason for
    // backward-compat with STAQPRO-192's existing eval surface. The KB
    // reason currently lives only in the response body — if the eval
    // surface starts caring about KB hit-rate, add a kb_retrieval_reason
    // column then (parallel to migration 013).
    const emailRefIds = retrieval.refs.map((r) => r.point_id);
    const kbRefIds = retrieval.kb_refs.map((r) => r.point_id);
    // STAQPRO-234 — exemplar_refs holds postgres-row pointers (sent_history
    // message_id strings), NOT Qdrant point UUIDs. They live in their own
    // jsonb column (migration 020) so the STAQPRO-191/192 RAG-eval surface
    // (which depends on rag_context_refs being a UUID-only array) stays
    // pure. Empty array means no exemplar was injected — either k=0
    // requested or sent_history had no rows for this category yet.
    const exemplarMessageIds = exemplars.map((e) => e.message_id);
    await db
      .updateTable('drafts')
      .set({
        rag_context_refs: sql`${JSON.stringify(emailRefIds)}::jsonb`,
        rag_retrieval_reason: retrieval.reason,
        kb_context_refs: sql`${JSON.stringify(kbRefIds)}::jsonb`,
        exemplar_refs: sql`${JSON.stringify(exemplarMessageIds)}::jsonb`,
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
      // STAQPRO-191 — email RAG audit signal for n8n logging + dashboard
      // debug surface. refs_count is what dashboards graph; reason is what
      // eval/triage scripts filter on.
      rag: {
        refs_count: retrieval.refs.length,
        reason: retrieval.reason,
      },
      // STAQPRO-148 — parallel KB audit signal.
      kb: {
        refs_count: retrieval.kb_refs.length,
        reason: retrieval.kb_reason,
      },
      // STAQPRO-234 — exemplar audit signal. Drives the dashboard debug
      // surface and the "did Phase 1 actually inject anything?" eval check.
      exemplars: {
        refs_count: exemplars.length,
      },
      // STAQPRO-341 — thread-history + quote-strip audit signals. Lets the
      // dashboard graph "how often did thread context fire?" and the n8n
      // execution log surface why a draft had no thread context (gated /
      // no_thread_id / no_hits / disabled / db_unavailable).
      thread_history: {
        messages_count: threadHistory.messages.length,
        reason: threadHistory.reason,
      },
      strip_quoting: {
        stripped_quoted: strippedInbound.stripped_quoted,
        stripped_signature: strippedInbound.stripped_signature,
        original_length: strippedInbound.original_length,
        stripped_length: strippedInbound.body.length,
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
