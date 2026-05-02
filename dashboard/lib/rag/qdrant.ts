// dashboard/lib/rag/qdrant.ts
//
// STAQPRO-190 — thin Qdrant client for the `email_messages` collection.
// Wraps the two HTTP calls we need: upsert one point and search by vector.
// Idempotency: each Gmail `message_id` deterministically maps to a single
// point UUID (sha256-derived), so re-upserting the same message_id is a
// no-op-equivalent overwrite rather than creating duplicate points. This
// is what the issue calls out as the "Idempotent on `message_id`" acceptance
// criterion.
//
// Failure mode: every method returns a tagged result instead of throwing,
// so callers can degrade gracefully (RAG is augmentation, not gate).

import { createHash } from 'node:crypto';

const QDRANT_URL = process.env.QDRANT_URL ?? 'http://qdrant:6333';
const COLLECTION = 'email_messages';
const QDRANT_TIMEOUT_MS = Number(process.env.QDRANT_TIMEOUT_MS ?? 5000);

export type Direction = 'inbound' | 'outbound';

// STAQPRO-191 — symmetric sender normalization for the
// payload.sender == inbound.from_addr counterparty filter. Gmail headers
// arrive as either 'Display Name <addr@host>' or already-bare 'addr@host';
// without symmetric normalization at ingestion AND retrieval, half of
// senders silently miss the filter and return zero hits. Both sides MUST
// import this single normalizer — do not inline.
//
// Pure function (no IO). Returns '' on empty/whitespace input so callers
// can short-circuit instead of throwing.
export function normalizeSender(raw: string | null | undefined): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  // 'Name <addr@host>' → 'addr@host'; lone 'addr@host' passes through.
  const angled = trimmed.match(/<([^>]+)>/);
  return (angled ? angled[1] : trimmed).trim().toLowerCase();
}

export interface EmailPointPayload {
  message_id: string;
  thread_id: string | null;
  sender: string;
  recipient: string;
  subject: string | null;
  body_excerpt: string;
  sent_at: string; // ISO 8601
  direction: Direction;
  classification_category: string | null;
  // STAQPRO-191 — persona scoping for multi-mailbox appliances. Tenant
  // boundary is hardware (one Jetson per customer); this field discriminates
  // multiple mailboxes inside a single appliance. All current ingestion
  // paths seed 'default'; future multi-persona work writes the persona's
  // mailbox.persona.customer_key.
  persona_key: string;
}

export interface UpsertResult {
  ok: boolean;
  point_id: string;
  reason?: string;
}

// Deterministic UUID-v4-shaped string from message_id, suitable for Qdrant
// point IDs (Qdrant accepts integers or UUIDs; UUID is chosen to avoid the
// 64-bit integer collision space across mailboxes). sha256 → first 32 hex
// chars → 8-4-4-4-12 dash format with version/variant nibbles set per RFC
// 4122 §4.4 so the result is a syntactically valid UUID v4.
export function pointIdFromMessageId(messageId: string): string {
  const h = createHash('sha256').update(messageId).digest('hex');
  // Set version (4) and variant (8/9/a/b) bits per RFC 4122.
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
  method: 'GET' | 'POST' | 'PUT',
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

export async function upsertEmailPoint(
  vector: number[],
  payload: EmailPointPayload,
): Promise<UpsertResult> {
  const pointId = pointIdFromMessageId(payload.message_id);
  try {
    const r = await qdrantRequest('PUT', `/collections/${COLLECTION}/points`, {
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

export interface SearchHit {
  id: string;
  score: number;
  payload: EmailPointPayload;
}

export interface SearchResult {
  ok: boolean;
  hits: SearchHit[];
  reason?: string;
}

export interface SearchOptions {
  limit?: number;
  senderFilter?: string;
  // STAQPRO-191 — persona scoping. When set, ANDed with senderFilter so a
  // multi-persona appliance only retrieves history from the persona that
  // owns the in-flight draft. When unset, no persona filter is applied
  // (single-persona appliances retain previous behavior).
  personaKey?: string;
}

// Search by vector with optional hard filters on payload.sender and
// payload.persona_key. Used by STAQPRO-191 retrieval at draft time. For now
// this lives in the same module as the upsert path so consumers have one
// rag/qdrant import.
export async function searchByVector(
  vector: number[],
  opts: SearchOptions = {},
): Promise<SearchResult> {
  const limit = opts.limit ?? 5;
  const must: Array<{ key: string; match: { value: string } }> = [];
  if (opts.senderFilter) must.push({ key: 'sender', match: { value: opts.senderFilter } });
  if (opts.personaKey) must.push({ key: 'persona_key', match: { value: opts.personaKey } });
  const filter = must.length > 0 ? { must } : undefined;
  try {
    const r = await qdrantRequest('POST', `/collections/${COLLECTION}/points/search`, {
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
    const hits: SearchHit[] = result.map((h) => {
      const hit = h as { id: string; score: number; payload: EmailPointPayload };
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
