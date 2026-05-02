// dashboard/scripts/qdrant-bootstrap.ts
//
// STAQPRO-188 — idempotent Qdrant bootstrap for the `email_messages` collection.
//
// Why a script instead of extending mailbox-migrate: the migrate profile is the
// Postgres schema-versioning surface (mailbox.migrations table, .sql files).
// Qdrant collection state lives entirely server-side in Qdrant — no migration
// log, no SQL — so coupling it to the Postgres runner blurs the boundary.
// Instead, this is its own one-shot compose step (`mailbox-qdrant-bootstrap`
// profile) that runs to completion and exits.
//
// Idempotency: PUT /collections/{name} returns 200 OK and is a no-op if the
// collection already exists with matching config. Payload index creates use
// PUT and Qdrant treats them as upserts (no error if the index already
// exists). Re-running this script on every appliance boot is safe.
//
// Vector config: 768 dims / Cosine distance — matches nomic-embed-text:v1.5
// which is trained for cosine similarity. Vector size is the model's
// embedding dimension; do not change without re-embedding the corpus.

import process from 'node:process';

const QDRANT_URL = process.env.QDRANT_URL ?? 'http://qdrant:6333';
const COLLECTION = 'email_messages';
const VECTOR_SIZE = 768; // nomic-embed-text:v1.5
const DISTANCE = 'Cosine';

// Indexed payload fields: keep narrow and intentional. Each indexed field
// costs Qdrant memory; only index what we filter or sort by.
//   - message_id: idempotent upsert key (text → keyword for exact match)
//   - thread_id:  thread-grouping filter
//   - sender:     counterparty filter (the primary retrieval hard-filter)
//   - direction:  inbound vs outbound discriminator
//   - sent_at:    time-range filter / recency ranking input
//   - classification_category: future filter (e.g., "show me past 'reorder' replies")
const PAYLOAD_INDEXES: Array<{ field: string; schema: 'keyword' | 'datetime' }> = [
  { field: 'message_id', schema: 'keyword' },
  { field: 'thread_id', schema: 'keyword' },
  { field: 'sender', schema: 'keyword' },
  { field: 'direction', schema: 'keyword' },
  { field: 'sent_at', schema: 'datetime' },
  { field: 'classification_category', schema: 'keyword' },
];

interface QdrantErrorBody {
  status?: { error?: string };
}

async function qdrantRequest(
  method: 'GET' | 'PUT',
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${QDRANT_URL}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

async function ensureCollection(): Promise<void> {
  const probe = await qdrantRequest('GET', `/collections/${COLLECTION}`);
  if (probe.status === 200) {
    console.log(`[qdrant-bootstrap] collection '${COLLECTION}' already exists — skip create`);
    return;
  }
  if (probe.status !== 404) {
    throw new Error(
      `[qdrant-bootstrap] unexpected status ${probe.status} probing collection: ${JSON.stringify(probe.json)}`,
    );
  }

  const create = await qdrantRequest('PUT', `/collections/${COLLECTION}`, {
    vectors: { size: VECTOR_SIZE, distance: DISTANCE },
  });
  if (create.status !== 200) {
    const err =
      (create.json as QdrantErrorBody | null)?.status?.error ?? JSON.stringify(create.json);
    throw new Error(`[qdrant-bootstrap] create collection failed (${create.status}): ${err}`);
  }
  console.log(
    `[qdrant-bootstrap] created collection '${COLLECTION}' (${VECTOR_SIZE}d ${DISTANCE})`,
  );
}

async function ensurePayloadIndexes(): Promise<void> {
  for (const idx of PAYLOAD_INDEXES) {
    const res = await qdrantRequest('PUT', `/collections/${COLLECTION}/index`, {
      field_name: idx.field,
      field_schema: idx.schema,
    });
    // Qdrant returns 200 whether the index was created or already existed.
    if (res.status !== 200) {
      const err = (res.json as QdrantErrorBody | null)?.status?.error ?? JSON.stringify(res.json);
      throw new Error(
        `[qdrant-bootstrap] payload index ${idx.field} (${idx.schema}) failed (${res.status}): ${err}`,
      );
    }
    console.log(`[qdrant-bootstrap] payload index '${idx.field}' (${idx.schema}) ensured`);
  }
}

async function main(): Promise<void> {
  console.log(`[qdrant-bootstrap] target=${QDRANT_URL} collection=${COLLECTION}`);
  await ensureCollection();
  await ensurePayloadIndexes();
  console.log('[qdrant-bootstrap] complete');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
