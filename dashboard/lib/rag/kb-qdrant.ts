// dashboard/lib/rag/kb-qdrant.ts
//
// STAQPRO-148 — thin Qdrant client for the `kb_documents` collection (the
// operator-uploaded SOP / price-sheet / policy corpus). Sibling to
// rag/qdrant.ts (the email_messages client). Kept as a separate file rather
// than refactoring qdrant.ts to take a collection-name parameter — two
// collections, one read-mostly, lower risk to live email RAG (per Plan
// agent's stress-test). Revisit only if a 3rd collection appears.
//
// Idempotency: each chunk maps to a deterministic UUID derived from
// sha256(doc_sha256 + ':' + chunk_index), so re-ingesting the same doc
// produces the same point IDs (no duplication on retry).
//
// Failure mode: every method returns a tagged result instead of throwing,
// so callers can degrade gracefully (RAG is augmentation, not gate).

import { createHash } from 'node:crypto';

const QDRANT_URL = process.env.QDRANT_URL ?? 'http://qdrant:6333';
const KB_COLLECTION = 'kb_documents';
const QDRANT_TIMEOUT_MS = Number(process.env.QDRANT_TIMEOUT_MS ?? 5000);

export interface KbPointPayload {
  doc_id: number;
  chunk_index: number;
  doc_title: string;
  doc_sha256: string;
  mime_type: string;
  excerpt: string;
  uploaded_at: string; // ISO 8601
}

export interface KbUpsertResult {
  ok: boolean;
  point_id: string;
  reason?: string;
}

// Deterministic UUID-v4-shaped string from (doc_sha256, chunk_index). Same
// 8-4-4-4-12 RFC-4122-§4.4 derivation as pointIdFromMessageId in qdrant.ts;
// chosen here so re-upserts of the same chunk are no-op-equivalent overwrites.
export function pointIdFromChunk(doc_sha256: string, chunk_index: number): string {
  const h = createHash('sha256').update(`${doc_sha256}:${chunk_index}`).digest('hex');
  const v = `4${h.slice(13, 16)}`;
  const variantNibble = ((Number.parseInt(h[16] ?? '0', 16) & 0b0011) | 0b1000).toString(16);
  const r = `${variantNibble}${h.slice(17, 20)}`;
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${v}-${r}-${h.slice(20, 32)}`;
}

interface QdrantResponseBody {
  status?: string | { error?: string };
  result?: unknown;
}

async function qdrantRequest(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<{ status: number; json: QdrantResponseBody | null }> {
  const res = await fetch(`${QDRANT_URL}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(QDRANT_TIMEOUT_MS),
  });
  const text = await res.text();
  let json: QdrantResponseBody | null;
  try {
    json = text ? (JSON.parse(text) as QdrantResponseBody) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

export async function upsertKbPoint(
  vector: number[],
  payload: KbPointPayload,
): Promise<KbUpsertResult> {
  const pointId = pointIdFromChunk(payload.doc_sha256, payload.chunk_index);
  try {
    const r = await qdrantRequest('PUT', `/collections/${KB_COLLECTION}/points`, {
      points: [{ id: pointId, vector, payload }],
    });
    if (r.status !== 200) {
      const errBody = r.json?.status;
      const reason = typeof errBody === 'string' ? errBody : (errBody?.error ?? `HTTP ${r.status}`);
      return { ok: false, point_id: pointId, reason };
    }
    return { ok: true, point_id: pointId };
  } catch (error) {
    return {
      ok: false,
      point_id: pointId,
      reason: error instanceof Error ? error.message : 'unknown',
    };
  }
}

export interface KbSearchHit {
  id: string;
  score: number;
  payload: KbPointPayload;
}

export interface KbSearchResult {
  ok: boolean;
  hits: KbSearchHit[];
  reason?: string;
}

export interface KbSearchOptions {
  limit?: number;
  // Optional mime_type filter — useful if future UX wants to bias toward
  // policy docs vs price sheets per inbound query type. Unused at v1.
  mimeTypeFilter?: string;
}

// Search by vector. No hard filter on per-counterparty (unlike email retrieval)
// — KB content is corpus-wide knowledge, not per-sender history.
export async function searchKb(
  vector: number[],
  opts: KbSearchOptions = {},
): Promise<KbSearchResult> {
  const limit = opts.limit ?? 3;
  const must: Array<{ key: string; match: { value: string } }> = [];
  if (opts.mimeTypeFilter) must.push({ key: 'mime_type', match: { value: opts.mimeTypeFilter } });
  const filter = must.length > 0 ? { must } : undefined;
  try {
    const r = await qdrantRequest('POST', `/collections/${KB_COLLECTION}/points/search`, {
      vector,
      limit,
      with_payload: true,
      ...(filter ? { filter } : {}),
    });
    if (r.status !== 200) {
      return { ok: false, hits: [], reason: `HTTP ${r.status}` };
    }
    const result = r.json?.result;
    if (!Array.isArray(result)) {
      return { ok: false, hits: [], reason: 'unexpected response shape' };
    }
    const hits: KbSearchHit[] = result.map((h) => {
      const hit = h as { id: string; score: number; payload: KbPointPayload };
      return { id: hit.id, score: hit.score, payload: hit.payload };
    });
    return { ok: true, hits };
  } catch (error) {
    return {
      ok: false,
      hits: [],
      reason: error instanceof Error ? error.message : 'unknown',
    };
  }
}

// Delete every point belonging to a given doc. Used by the cascade-delete
// path in DELETE /api/kb-documents/[id]. Qdrant supports filter-based
// deletes natively; we use the doc_id payload index for an O(matched) op.
export async function deleteKbPointsByDocId(
  doc_id: number,
): Promise<{ ok: boolean; reason?: string }> {
  try {
    const r = await qdrantRequest('POST', `/collections/${KB_COLLECTION}/points/delete`, {
      filter: { must: [{ key: 'doc_id', match: { value: doc_id } }] },
    });
    if (r.status !== 200) {
      return { ok: false, reason: `HTTP ${r.status}` };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'unknown',
    };
  }
}
