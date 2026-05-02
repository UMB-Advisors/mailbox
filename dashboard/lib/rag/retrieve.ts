// dashboard/lib/rag/retrieve.ts
//
// STAQPRO-191 — retrieval at draft time.
//
// Embed the inbound email, query Qdrant `email_messages` with a hard
// filter on `payload.sender == inbound.from_addr` for counterparty-scoped
// recall, vector similarity for topical ranking. Return top-k formatted
// snippets ready for the existing prompt.ts `rag_refs` slot.
//
// === Privacy gate (cloud route) ===
//
// Per the project Constraints section ("All email content and knowledge
// base stored only on local appliance. No bulk corpus sent to cloud.")
// and the STAQPRO-191 session call-out: retrieval payloads going into a
// cloud-route prompt count as additional cloud-bound content. The default
// is therefore PRIVACY-FIRST:
//
//   - LOCAL route (qwen3:4b-ctx4k on-device)  → retrieval ALWAYS runs
//   - CLOUD route (Ollama Cloud / Anthropic)  → retrieval runs only when
//                                                RAG_CLOUD_ROUTE_ENABLED=1
//
// This means cloud calls only carry the inbound email itself + per-call
// classification, exactly matching the existing baseline. Operators who
// explicitly opt in (`RAG_CLOUD_ROUTE_ENABLED=1` in .env) trade off some
// privacy budget for retrieval-quality on the cloud path.
//
// === Token budget (DR-18: 4096 ctx local) ===
//
// Qwen3 has 4096 tokens total. Existing system + user prompt without RAG
// is ~600-800 tokens; inbound bodies cap at MAX_BODY_CHARS=6000 chars (~1500
// tokens); completion is max_tokens=600. That leaves ~1000-1500 tokens for
// retrieved context.
//
// Conservative default: top-k=3, per-snippet excerpt cap=600 chars (~150
// tokens) — yields ~450 tokens of retrieved context, well under budget.
// Tunable via RAG_RETRIEVE_TOP_K + RAG_RETRIEVE_EXCERPT_CHARS.
//
// === Failure mode ===
//
// Returns empty refs[] (not throw) on any failure — embed unavailable,
// Qdrant unreachable, 0 hits. Drafting proceeds with persona-stub fallback
// per the issue's acceptance criterion ("RAG is augmentation, not gate").

import { embedText } from './embed';
import { buildBodyExcerpt, buildEmbeddingInput } from './excerpt';
import { normalizeSender, searchByVector } from './qdrant';

export interface RetrievalRef {
  point_id: string;
  source: string; // human-readable label rendered into the prompt
  excerpt: string;
  score: number;
  direction: 'inbound' | 'outbound';
  sent_at: string;
}

export interface RetrievalResult {
  refs: RetrievalRef[];
  reason:
    | 'ok'
    | 'cloud_gated'
    | 'embed_unavailable'
    | 'no_hits'
    | 'qdrant_unavailable'
    // STAQPRO-198 — set when `RAG_DISABLED=1` short-circuits retrieveForDraft
    // before any embed / Qdrant call. Used by the eval harness's no-rag pass
    // to run a baseline draft without persona-stub vs RAG noise.
    | 'disabled';
}

export interface RetrievalInput {
  from_addr: string;
  subject: string | null;
  body_text: string | null;
  draft_source: 'local' | 'cloud';
  // STAQPRO-191 — persona scoping. Multi-mailbox appliances (one Jetson,
  // 2-5 personas) require retrieval to be filtered to the persona that
  // owns the draft. Single-persona appliances pass 'default'. Must match
  // the value written into payload.persona_key at ingestion time or the
  // search returns zero hits.
  persona_key: string;
}

function topK(): number {
  return Number(process.env.RAG_RETRIEVE_TOP_K ?? 3);
}
function excerptCharCap(): number {
  return Number(process.env.RAG_RETRIEVE_EXCERPT_CHARS ?? 600);
}

// Lazy env read so operators can flip RAG_CLOUD_ROUTE_ENABLED without a
// process restart, and tests can toggle the gate per-case.
export function isCloudRetrievalEnabled(): boolean {
  return process.env.RAG_CLOUD_ROUTE_ENABLED === '1';
}

// STAQPRO-198 — operator-controlled kill switch for the eval harness's
// no-rag baseline pass. Lazy env read so the same script invocation flips
// behavior per `RAG_DISABLED=1 npm run eval:rag` without a process restart.
// Production code never sets this; only the eval harness does, and only on
// the second of its two passes.
export function isRagDisabled(): boolean {
  return process.env.RAG_DISABLED === '1';
}

export async function retrieveForDraft(input: RetrievalInput): Promise<RetrievalResult> {
  // STAQPRO-198 — short-circuit before any embed / Qdrant call. The harness
  // baseline relies on this returning empty refs without touching infra.
  if (isRagDisabled()) {
    return { refs: [], reason: 'disabled' };
  }

  // Privacy gate: cloud-route retrieval is opt-in.
  if (input.draft_source === 'cloud' && !isCloudRetrievalEnabled()) {
    return { refs: [], reason: 'cloud_gated' };
  }

  // STAQPRO-191 — normalize sender BEFORE filter construction. Inbound
  // from_addr can be 'Customer Name <cust@example.com>' or already-bare
  // 'cust@example.com'; ingestion paths normalize the same way (see
  // normalizeSender export). Without symmetric normalization, retrieval
  // silently returns zero hits for half of senders.
  const normalizedSender = normalizeSender(input.from_addr);
  if (!normalizedSender) {
    return { refs: [], reason: 'no_hits' };
  }

  const embedInput = buildEmbeddingInput(input.subject, buildBodyExcerpt(input.body_text));
  if (!embedInput.trim()) {
    return { refs: [], reason: 'no_hits' };
  }

  const vector = await embedText(embedInput);
  if (!vector) {
    return { refs: [], reason: 'embed_unavailable' };
  }

  const search = await searchByVector(vector, {
    limit: topK(),
    senderFilter: normalizedSender,
    personaKey: input.persona_key,
  });
  if (!search.ok) {
    return { refs: [], reason: 'qdrant_unavailable' };
  }
  if (search.hits.length === 0) {
    return { refs: [], reason: 'no_hits' };
  }

  const refs: RetrievalRef[] = search.hits.map((h) => {
    const dir = h.payload.direction === 'outbound' ? 'we wrote' : 'they wrote';
    const dateLabel = h.payload.sent_at.slice(0, 10);
    const subject = h.payload.subject ?? '(no subject)';
    return {
      point_id: h.id,
      source: `${dateLabel} · ${dir} · ${subject}`,
      excerpt: (h.payload.body_excerpt ?? '').slice(0, excerptCharCap()),
      score: h.score,
      direction: h.payload.direction,
      sent_at: h.payload.sent_at,
    };
  });

  return { refs, reason: 'ok' };
}
