---
plan_number: 02-05
slug: rag-ingest-retrieval
wave: 3
depends_on: [02-02]
autonomous: false
requirements: [RAG-01, RAG-02, RAG-03, RAG-04, RAG-05, RAG-06]
files_modified:
  - dashboard/backend/src/rag/client.ts
  - dashboard/backend/src/rag/chunk.ts
  - dashboard/backend/src/rag/embed.ts
  - dashboard/backend/src/routes/kb.ts
  - dashboard/backend/src/index.ts
  - n8n/workflows/06-rag-ingest-sent-history.json
  - n8n/workflows/07-rag-index-new-message.json
---

<review_fixes>
**Applied from 02-REVIEWS.md (codex pass, 2026-04-13):**
- HIGH (historical ingest pollution): The 6-month sent backfill no longer writes into `mailbox.sent_history` with a fabricated `draft_source='local_qwen3'`. Backfill rows land in the new `mailbox.historical_sent` table (02-02 review fix). Persona extraction (02-06) reads from `historical_sent` for the onboarding seed corpus and from `sent_history` for the live monthly refresh; the two paths are explicit. PERS-05 and audit semantics stay clean.
- HIGH (handoff fix): Incremental indexing now fires from `03-classify-email-sub` AFTER the `draft_queue` upsert, not from `01-email-pipeline-main`. That's where the queue row actually exists. `01-email-pipeline-main` does NOT call `07-rag-index-new-message`.
- MEDIUM (top-K contract): retrieval is fixed at **top-5** from Qdrant with `score_threshold=0.72`; **top-3** is the slice handed to the draft prompt (selected by score, ties broken by recency). `client.ts.searchTopK` returns 5; `drafting/rag-snippet.ts` (02-07) slices to 3.
- MEDIUM (in-memory upload): document upload now streams to a temp file under `${TMP_DIR}/mailbox-uploads/` and chunk/embed reads from the file in 1MB windows. Spike on 8GB Jetson is bounded.
- Sent-on-approval indexing (RAG-03 completeness): `11-send-smtp-sub` (02-07) calls `07-rag-index-new-message` with `{ source: 'sent_email', source_id }` after archiving to `sent_history`, so live approved sends become RAG corpus.
</review_fixes>

<objective>
Build the retrieval-augmented generation pipeline: nomic-embed-text v1.5 embeddings, a single Qdrant collection, HTTP-based upsert/search via n8n (since n8n has no first-class Qdrant node), per-email chunking for sent history, per-paragraph chunking for uploaded PDF/DOCX/CSV documents, a dashboard backend `/api/kb` route for document upload/list/delete (streaming, review fix), a similarity threshold of 0.72 per RAG-05, and top-5 retrieval with top-3 refs sliced for the drafting prompt (review fix: explicit top-K contract). The 6-month sent history ingest writes to the dedicated `mailbox.historical_sent` table (02-02 review fix) so it does not pollute live `sent_history`. Indexing of new inbound messages handoffs from `03-classify-email-sub` (review fix), and indexing of live approved sends fires from `11-send-smtp-sub` (RAG-03).
</objective>

<must_haves>
- Qdrant collection `mailbox_rag` exists with `size=768` vectors (nomic-embed-text dim), `distance=Cosine`, and payload fields `source` (`sent_email_historical` | `sent_email_live` | `inbound_email` | `document`), `source_id`, `text`, `meta` (jsonb). NOTE: review fix — historical-backfill rows use `sent_email_historical`, live approved sends use `sent_email_live`. Persona extraction and audit can distinguish them.
- `POST /api/kb/documents` accepts a PDF/DOCX/CSV upload (streaming to disk; review fix), chunks it by paragraph, embeds each chunk, and upserts into Qdrant with `source='document'`. Hard cap 20MB.
- `GET /api/kb/documents` returns all uploaded documents with chunk counts
- `DELETE /api/kb/documents/:id` removes all vectors with the given `source_id`
- `06-rag-ingest-sent-history` workflow ingests 6 months of sent email from the connected account (IMAP `Sent Mail` folder), chunks one-email-per-chunk, embeds, upserts with `source='sent_email_historical'`, **and inserts a row per email into `mailbox.historical_sent`** (review fix: never into `mailbox.sent_history`). Progress is written to `mailbox.onboarding.ingest_progress_*` for the dashboard to display.
- `07-rag-index-new-message` is invoked from `03-classify-email-sub` AFTER the draft_queue insert (review fix), passing `{ email_raw_id }`. Inbound messages are indexed with `source='inbound_email'`.
- `07-rag-index-new-message` is ALSO invoked from `11-send-smtp-sub` (02-07) after archival, passing `{ source_id: 'sent:<outbound_id>', text: draft_sent, source: 'sent_email_live', meta }`. RAG-03 completeness.
- A helper function in the drafting workflow (Plan 02-07 will call it) performs vector search with `limit=5` and `score_threshold=0.72`, returning top-5; downstream prompt rendering slices to top-3. Top-K contract is documented at the route boundary.
- The 06 sub-workflow is invoked from the onboarding flow (Plan 02-08) with `{ customer_key, months_back: 6 }` input.
</must_haves>

<tasks>

<task id="1">
<action>
Create `dashboard/backend/src/rag/client.ts` — Qdrant REST client wrapper that ensures the collection exists on startup and exposes `upsert`, `search`, `deleteBySourceId`:

```ts
import { QdrantClient } from '@qdrant/js-client-rest';
import { config } from '../config.js';

export const COLLECTION = 'mailbox_rag';
export const EMBED_DIM = 768; // nomic-embed-text v1.5

export const qdrant = new QdrantClient({ url: config.QDRANT_URL });

export async function ensureCollection(): Promise<void> {
  const exists = await qdrant.getCollections().then((r) => r.collections.some((c) => c.name === COLLECTION)).catch(() => false);
  if (exists) return;
  await qdrant.createCollection(COLLECTION, {
    vectors: { size: EMBED_DIM, distance: 'Cosine' },
  });
  // Payload indexes for fast filtering by source / source_id
  await qdrant.createPayloadIndex(COLLECTION, { field_name: 'source', field_schema: 'keyword' });
  await qdrant.createPayloadIndex(COLLECTION, { field_name: 'source_id', field_schema: 'keyword' });
}

export interface RagPoint {
  id: string | number;
  vector: number[];
  payload: {
    source: 'sent_email' | 'inbound_email' | 'document';
    source_id: string;
    text: string;
    meta?: Record<string, unknown>;
  };
}

// Review fix: top-K contract documented at the type boundary.
// `searchTopK` ALWAYS returns up to 5 results filtered by RAG-05 threshold.
// Downstream callers (drafting/rag-snippet.ts) explicitly slice to top-3 for
// the LLM prompt and pass top-5 to logging/debugging surfaces.
export const DEFAULT_RETRIEVE_K = 5;
export const PROMPT_REFS_K = 3;

// Source tag enum kept in step with 02-02 + 02-07 review fixes.
export type RagSource = 'sent_email_historical' | 'sent_email_live' | 'inbound_email' | 'document';

export async function upsertPoints(points: RagPoint[]): Promise<void> {
  if (points.length === 0) return;
  await qdrant.upsert(COLLECTION, { wait: true, points });
}

export interface SearchResult {
  id: string | number;
  score: number;
  payload: RagPoint['payload'];
}

export async function searchTopK(vector: number[], k = DEFAULT_RETRIEVE_K, threshold = 0.72): Promise<SearchResult[]> {
  const res = await qdrant.search(COLLECTION, { vector, limit: k, score_threshold: threshold, with_payload: true });
  return res.map((r) => ({ id: r.id as string | number, score: r.score, payload: r.payload as RagPoint['payload'] }));
}

export async function deleteBySourceId(sourceId: string): Promise<void> {
  await qdrant.delete(COLLECTION, { filter: { must: [{ key: 'source_id', match: { value: sourceId } }] }, wait: true });
}
```
</action>
<read_first>
  - dashboard/backend/src/config.ts  (QDRANT_URL)
  - CLAUDE.md  (nomic-embed-text 768-dim, Qdrant 1.17.1)
  - .planning/REQUIREMENTS.md  (RAG-04 top-5, RAG-05 0.72 threshold)
</read_first>
<acceptance_criteria>
- `dashboard/backend/src/rag/client.ts` exists
- `grep "COLLECTION = 'mailbox_rag'" dashboard/backend/src/rag/client.ts` matches
- `grep 'EMBED_DIM = 768' dashboard/backend/src/rag/client.ts` matches
- `grep "distance: 'Cosine'" dashboard/backend/src/rag/client.ts` matches
- `grep 'score_threshold = 0.72' dashboard/backend/src/rag/client.ts` matches
- `grep 'export async function upsertPoints' dashboard/backend/src/rag/client.ts` matches
- `grep 'export async function searchTopK' dashboard/backend/src/rag/client.ts` matches
- `grep 'export async function deleteBySourceId' dashboard/backend/src/rag/client.ts` matches
</acceptance_criteria>
</task>

<task id="2">
<action>
Create `dashboard/backend/src/rag/chunk.ts` — two chunking strategies: `chunkEmail(body)` returns a single whole-email chunk (sent-history ingest uses this), `chunkDocument(text)` returns paragraph-level chunks targeting ~800-character windows so each stays within the 2K-token nomic-embed-text context. Handles PDF/DOCX/CSV text extraction via `pdf-parse`, `mammoth`, and a naive CSV-to-text converter.

```ts
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');

export function chunkEmail(body: string): string[] {
  const trimmed = (body || '').trim();
  if (!trimmed) return [];
  // Per-email chunking per CONTEXT.md Claude's Discretion — whole email = 1 chunk
  return [trimmed.slice(0, 6000)];
}

export function chunkDocument(text: string): string[] {
  const normalized = (text || '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];
  const paragraphs = normalized.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  let buf = '';
  for (const p of paragraphs) {
    if (!buf) { buf = p; continue; }
    if ((buf.length + p.length + 2) <= 800) buf = `${buf}\n\n${p}`;
    else { out.push(buf); buf = p; }
  }
  if (buf) out.push(buf);
  return out;
}

export async function extractText(filename: string, buf: Buffer): Promise<string> {
  const ext = filename.toLowerCase().split('.').pop();
  if (ext === 'pdf') {
    const res = await pdfParse(buf);
    return String(res.text || '');
  }
  if (ext === 'docx') {
    const res = await mammoth.extractRawText({ buffer: buf });
    return String(res.value || '');
  }
  if (ext === 'csv' || ext === 'txt') {
    return buf.toString('utf8');
  }
  throw new Error(`unsupported file type: .${ext}`);
}

// Review fix: file-path variant used by the streaming upload path so the
// 20MB document never sits in process memory as a single Buffer.
import { promises as fsp } from 'node:fs';
export async function extractTextFromFile(filename: string, filePath: string): Promise<string> {
  const ext = filename.toLowerCase().split('.').pop();
  if (ext === 'pdf' || ext === 'docx') {
    // pdf-parse / mammoth still need a Buffer — but only briefly, then it's
    // GCed. The streaming win is that we don't carry the multer-side copy.
    const buf = await fsp.readFile(filePath);
    return extractText(filename, buf);
  }
  if (ext === 'csv' || ext === 'txt') {
    return fsp.readFile(filePath, 'utf8');
  }
  throw new Error(`unsupported file type: .${ext}`);
}
```

Add deps to `dashboard/package.json`: `"pdf-parse": "^1.1.1"`, `"mammoth": "^1.8.0"`.
</action>
<read_first>
  - dashboard/package.json  (add RAG deps)
  - .planning/phases/02-email-pipeline-core/02-CONTEXT.md  (Claude's Discretion: chunking strategy)
  - .planning/REQUIREMENTS.md  (RAG-02 PDF/DOCX/CSV)
</read_first>
<acceptance_criteria>
- `dashboard/backend/src/rag/chunk.ts` exists
- `grep 'export function chunkEmail' dashboard/backend/src/rag/chunk.ts` matches
- `grep 'export function chunkDocument' dashboard/backend/src/rag/chunk.ts` matches
- `grep 'export async function extractText' dashboard/backend/src/rag/chunk.ts` matches
- `grep 'pdf-parse' dashboard/package.json` matches
- `grep 'mammoth' dashboard/package.json` matches
</acceptance_criteria>
</task>

<task id="3">
<action>
Create `dashboard/backend/src/rag/embed.ts` — calls Ollama's `/api/embeddings` endpoint for nomic-embed-text v1.5 and returns a 768-dim vector:

```ts
import { config } from '../config.js';

const MODEL = 'nomic-embed-text:v1.5';

export async function embed(text: string): Promise<number[]> {
  const res = await fetch(`${config.OLLAMA_URL}/api/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, prompt: text }),
  });
  if (!res.ok) throw new Error(`ollama embed failed: ${res.status}`);
  const j = (await res.json()) as { embedding: number[] };
  if (!Array.isArray(j.embedding) || j.embedding.length !== 768) {
    throw new Error(`unexpected embedding length: ${j.embedding?.length}`);
  }
  return j.embedding;
}

export async function embedMany(texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (const t of texts) out.push(await embed(t)); // serial — Ollama single-worker path is safer on 8GB
  return out;
}
```
</action>
<read_first>
  - dashboard/backend/src/config.ts
  - CLAUDE.md  (nomic-embed-text v1.5 requires Ollama 0.1.26+)
</read_first>
<acceptance_criteria>
- `dashboard/backend/src/rag/embed.ts` exists
- `grep "nomic-embed-text:v1.5" dashboard/backend/src/rag/embed.ts` matches
- `grep 'j.embedding.length !== 768' dashboard/backend/src/rag/embed.ts` matches
- `grep 'export async function embed' dashboard/backend/src/rag/embed.ts` matches
</acceptance_criteria>
</task>

<task id="4">
<action>
Create `dashboard/backend/src/routes/kb.ts` — document upload/list/delete routes:

```ts
import { Router } from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chunkDocument, extractTextFromFile } from '../rag/chunk.js';
import { embedMany } from '../rag/embed.js';
import { upsertPoints, deleteBySourceId, qdrant, COLLECTION } from '../rag/client.js';

export const kbRouter = Router();

// Review fix: stream uploads to disk instead of buffering in memory.
// 8GB unified RAM on Jetson cannot afford a 20MB Buffer spike per concurrent
// upload. multer.diskStorage writes the file to ${TMPDIR}/mailbox-uploads/
// and extractTextFromFile reads from disk in bounded windows.
const UPLOAD_DIR = path.join(os.tmpdir(), 'mailbox-uploads');
await fs.mkdir(UPLOAD_DIR, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => cb(null, `${randomUUID()}-${file.originalname.replace(/[^\w.-]/g, '_')}`),
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
});

kbRouter.post('/documents', upload.single('file'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'no file' });
  try {
    const text = await extractTextFromFile(file.originalname, file.path);
    const chunks = chunkDocument(text);
    if (chunks.length === 0) return res.status(400).json({ error: 'empty after chunking' });
    const vectors = await embedMany(chunks);
    const sourceId = `doc:${randomUUID()}`;
    const points = chunks.map((chunk, i) => ({
      id: `${sourceId}:${i}`,
      vector: vectors[i],
      payload: {
        source: 'document' as const,
        source_id: sourceId,
        text: chunk,
        meta: { filename: file.originalname, chunk_index: i, uploaded_at: new Date().toISOString() },
      },
    }));
    await upsertPoints(points);
    res.status(201).json({ source_id: sourceId, chunks: chunks.length, filename: file.originalname });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  } finally {
    // Always clean up the temp file even on failure.
    fs.unlink(file.path).catch(() => {});
  }
});

kbRouter.get('/documents', async (_req, res) => {
  // Scroll payload records filtered by source='document', aggregate by source_id
  const out: Record<string, { source_id: string; filename: string; chunk_count: number; uploaded_at?: string }> = {};
  let offset: string | number | null = null;
  do {
    const page: any = await qdrant.scroll(COLLECTION, {
      filter: { must: [{ key: 'source', match: { value: 'document' } }] },
      limit: 256,
      with_payload: true,
      offset: offset ?? undefined,
    });
    for (const p of page.points) {
      const sid = p.payload?.source_id as string;
      if (!out[sid]) {
        out[sid] = {
          source_id: sid,
          filename: String(p.payload?.meta?.filename || 'unknown'),
          chunk_count: 0,
          uploaded_at: p.payload?.meta?.uploaded_at,
        };
      }
      out[sid].chunk_count += 1;
    }
    offset = page.next_page_offset;
  } while (offset);
  res.json({ documents: Object.values(out) });
});

kbRouter.delete('/documents/:sourceId', async (req, res) => {
  await deleteBySourceId(req.params.sourceId);
  res.status(204).end();
});
```

Add `multer` to `dashboard/package.json` dependencies: `"multer": "^1.4.5-lts.1"` plus `"@types/multer": "^1.4.11"` under devDependencies.

Wire the router into `dashboard/backend/src/index.ts`:

```ts
// Add at the top with other imports:
import { kbRouter } from './routes/kb.js';
import { ensureCollection } from './rag/client.js';

// After healthRouter:
app.use('/api/kb', kbRouter);

// Before server.listen, add:
ensureCollection().catch((e) => console.error('[rag] ensureCollection failed', e));
```
</action>
<read_first>
  - dashboard/backend/src/rag/client.ts
  - dashboard/backend/src/rag/chunk.ts
  - dashboard/backend/src/rag/embed.ts
  - dashboard/backend/src/index.ts  (wire router)
  - .planning/REQUIREMENTS.md  (RAG-02, RAG-06)
</read_first>
<acceptance_criteria>
- `dashboard/backend/src/routes/kb.ts` exists
- `grep "kbRouter.post('/documents'" dashboard/backend/src/routes/kb.ts` matches
- `grep "kbRouter.get('/documents'" dashboard/backend/src/routes/kb.ts` matches
- `grep "kbRouter.delete('/documents/:sourceId'" dashboard/backend/src/routes/kb.ts` matches
- `grep '/api/kb' dashboard/backend/src/index.ts` matches
- `grep 'ensureCollection' dashboard/backend/src/index.ts` matches
- `grep '"multer"' dashboard/package.json` matches
</acceptance_criteria>
</task>

<task id="5">
<action>
Create `n8n/workflows/06-rag-ingest-sent-history.json` — onboarding-time sub-workflow. Triggered via Execute Workflow with `{ customer_key, account_key, months_back: 6 }`. Node graph (review-fixed: historical rows go to `historical_sent`, NOT `sent_history`):

1. **Execute Workflow Trigger** — accepts `{ customer_key, account_key, months_back }`. `account_key` defaults to `'default'`.
2. **Postgres: Set onboarding to ingesting** — `UPDATE mailbox.onboarding SET stage='ingesting', ingest_progress_done=0 WHERE customer_key = $1;`
3. **IMAP Get Many** — credential `Gmail IMAP — <account_key>` (review fix: per-account credential), mailbox `[Gmail]/Sent Mail`, filter `since: {{ $today.minus({months:6}).toFormat('dd-LLL-yyyy') }}`, limit `2000`. Emits one item per sent email.
4. **Postgres: Set ingest_progress_total** — once from the item count.
5. **Loop Over Items** — iterate each sent email:
   a. **Function: Extract Fields** — pull `messageId`, `from`, `to`, `cc`, `subject`, `text`, `date`.
   b. **Postgres: Insert historical_sent** *(review fix: dedicated table, NOT sent_history)* — `INSERT INTO mailbox.historical_sent (customer_key, account_key, message_id, from_addr, to_addr, cc_addr, subject, body_text, sent_at) VALUES (...) ON CONFLICT (message_id) DO NOTHING RETURNING id;`
   c. **HTTP Request: Embed** — POST to `http://ollama:11434/api/embeddings` with body `{"model":"nomic-embed-text:v1.5","prompt":"<subject>\n<body>"}`. Extract `embedding` (768-dim array).
   d. **HTTP Request: Upsert Qdrant** — PUT to `http://qdrant:6333/collections/mailbox_rag/points` with payload (review fix: `source='sent_email_historical'`):
      ```json
      {
        "points": [{
          "id": "{{ 'hist:' + $json.messageId }}",
          "vector": "={{ $('HTTP Request: Embed').item.json.embedding }}",
          "payload": {
            "source": "sent_email_historical",
            "source_id": "={{ 'hist:' + $json.messageId }}",
            "text": "={{ ($json.subject || '') + '\\n' + ($json.text || '') }}",
            "meta": { "from": "={{ $json.from }}", "to": "={{ $json.to }}", "cc": "={{ $json.cc }}", "date": "={{ $json.date }}", "account_key": "={{ $json.account_key }}" }
          }
        }]
      }
      ```
   e. **Postgres: Mark indexed_in_rag** — `UPDATE mailbox.historical_sent SET indexed_in_rag = true WHERE message_id = $1;`
   f. **Postgres: Increment progress** — `UPDATE mailbox.onboarding SET ingest_progress_done = ingest_progress_done + 1 WHERE customer_key = $1;`
6. **Postgres: Set onboarding stage** — `UPDATE mailbox.onboarding SET stage='pending_tuning' WHERE customer_key = $1;` (gates the onboarding wizard, Plan 02-08 observes it).

**Review-fix note (PERS-05 safety):** the historical backfill no longer touches `mailbox.sent_history`. `sent_history` is reserved for live, approved/generated outbound from `11-send-smtp-sub`. Persona extraction in 02-06 reads from `historical_sent` (onboarding seed) and `sent_history` (post-go-live refresh) explicitly and labels exemplar sources accordingly.

Workflow shape:
```json
{
  "name": "06-rag-ingest-sent-history",
  "active": false,
  "nodes": [ ... ],
  "connections": { ... },
  "settings": { "executionOrder": "v1", "saveExecutionProgress": true, "executionTimeout": 3600 },
  "tags": [{"name":"phase-2"}, {"name":"onboarding"}, {"name":"rag"}]
}
```
(`active: false` is intentional — this is a sub-workflow invoked by the onboarding flow, not a standalone trigger.)
</action>
<read_first>
  - dashboard/backend/src/rag/client.ts  (Qdrant collection contract)
  - .planning/phases/02-email-pipeline-core/02-CONTEXT.md  (D-08 6-month corpus, D-12 staged async, D-16 state machine)
  - .planning/REQUIREMENTS.md  (RAG-01 6mo sent history)
  - dashboard/backend/src/db/schema.ts  (onboarding, sent_history shapes)
</read_first>
<acceptance_criteria>
- `n8n/workflows/06-rag-ingest-sent-history.json` exists and is valid JSON
- `jq -r '.name' n8n/workflows/06-rag-ingest-sent-history.json` returns `06-rag-ingest-sent-history`
- `grep -c 'nomic-embed-text:v1.5' n8n/workflows/06-rag-ingest-sent-history.json` returns at least `1`
- `grep -c 'mailbox_rag' n8n/workflows/06-rag-ingest-sent-history.json` returns at least `1`
- `grep -c 'historical_sent' n8n/workflows/06-rag-ingest-sent-history.json` returns at least `1` (review fix: writes to historical table)
- `grep -c 'sent_email_historical' n8n/workflows/06-rag-ingest-sent-history.json` returns at least `1` (review fix: source tag)
- `grep -c 'ingest_progress_done' n8n/workflows/06-rag-ingest-sent-history.json` returns at least `1`
- `grep -c "'ingesting'\\|\"ingesting\"" n8n/workflows/06-rag-ingest-sent-history.json` returns at least `1`
- `grep -c "'pending_tuning'\\|\"pending_tuning\"" n8n/workflows/06-rag-ingest-sent-history.json` returns at least `1`
- **Negative check (review fix):** `grep -c 'INSERT INTO mailbox.sent_history' n8n/workflows/06-rag-ingest-sent-history.json` returns `0` — historical rows never go into the live sent_history table.
- **Negative check (review fix):** `grep -c "'local_qwen3'" n8n/workflows/06-rag-ingest-sent-history.json` returns `0` — historical rows do not carry a fabricated draft_source.
</acceptance_criteria>
</task>

<task id="6">
<action>
Create `n8n/workflows/07-rag-index-new-message.json` — incremental indexer invoked by **`03-classify-email-sub`** (review fix: that's where the `draft_queue` row is actually inserted; `01-email-pipeline-main` only writes `email_raw` and hands off to the classifier) AND by **`11-send-smtp-sub`** (02-07 review fix: live approved sends become RAG corpus, completing RAG-03).

Inputs are polymorphic:
- `{ kind: 'inbound', email_raw_id }` from `03-classify-email-sub` after draft_queue upsert.
- `{ kind: 'live_sent', outbound_id, text, source_id, meta }` from `11-send-smtp-sub` after archival.

Node graph:

1. **Execute Workflow Trigger** — accepts the polymorphic payload above.
2. **IF kind == 'inbound'** branch:
   a. **Postgres: Fetch email_raw** — `SELECT id, subject, body_text, message_id, from_addr, to_addr, cc_addr, received_at, account_key FROM mailbox.email_raw WHERE id = $1;`
   b. **HTTP Request: Embed** — `{model: 'nomic-embed-text:v1.5', prompt: subject + '\n' + body_text}`.
   c. **HTTP Request: Upsert Qdrant** — `source='inbound_email'`, `source_id='inbound:' + message_id`, `meta: { from, to, cc, received_at, account_key }`.
3. **ELSE IF kind == 'live_sent'** branch:
   a. **HTTP Request: Embed** — `{model: 'nomic-embed-text:v1.5', prompt: text}` (the approved draft body).
   b. **HTTP Request: Upsert Qdrant** — `source='sent_email_live'`, `source_id` from input, `meta` from input.

This workflow fires:
- On every new inbound email AFTER onboarding goes live AND AFTER `03-classify-email-sub` has inserted the `draft_queue` row (the live-gate already prevents pre-live drafting, but the indexer still runs so the corpus stays current).
- On every approved/sent outbound from `11-send-smtp-sub` (review fix completing RAG-03).
- Fire-and-forget in both cases so user-facing latency is not blocked by embed.

**Removed (review fix):** the original draft of this plan said `01-email-pipeline-main` should invoke this workflow. That was wrong — at that point `draft_queue` does not yet exist. The handoff lives in `03-classify-email-sub` (after the draft_queue upsert) and in `11-send-smtp-sub` (after archival). `01-email-pipeline-main.json` is NOT modified by this plan beyond what 02-03 already establishes.
</action>
<read_first>
  - n8n/workflows/03-classify-email-sub.json
  - dashboard/backend/src/rag/client.ts
</read_first>
<acceptance_criteria>
- `n8n/workflows/07-rag-index-new-message.json` exists and is valid JSON
- `jq -r '.name' n8n/workflows/07-rag-index-new-message.json` returns `07-rag-index-new-message`
- `grep 'inbound_email' n8n/workflows/07-rag-index-new-message.json` matches
- `grep 'sent_email_live' n8n/workflows/07-rag-index-new-message.json` matches (review fix: live-send corpus branch)
- `grep 'nomic-embed-text:v1.5' n8n/workflows/07-rag-index-new-message.json` matches
- `grep 'mailbox_rag' n8n/workflows/07-rag-index-new-message.json` matches
- `grep -c '07-rag-index-new-message' n8n/workflows/03-classify-email-sub.json` returns at least `1` (handoff fix: classifier invokes the indexer)
- `grep -c '07-rag-index-new-message' n8n/workflows/11-send-smtp-sub.json` returns at least `1` (RAG-03 completeness: SMTP send invokes the indexer)
- **Negative check (review fix):** `grep -c '07-rag-index-new-message' n8n/workflows/01-email-pipeline-main.json` returns `0` — the indexer is NOT called from the main ingestion workflow (no draft_queue row there yet).
</acceptance_criteria>
</task>

<task id="7">
<action>
Build, deploy, and smoke-test the RAG stack end-to-end:

```bash
# 1. Pre-pull the embedding model
docker compose exec -T ollama ollama pull nomic-embed-text:v1.5

# 2. Rebuild dashboard with new RAG routes
docker compose build dashboard
docker compose up -d dashboard

# 3. Wait for /api/kb to accept requests (ensureCollection runs at startup)
for i in $(seq 1 10); do
  if curl -fsS http://localhost:3000/api/health >/dev/null; then break; fi
  sleep 3
done

# 4. Verify collection exists in Qdrant
curl -fsS http://localhost:6333/collections/mailbox_rag | jq .result.config.params.vectors

# 5. Upload a small PDF and confirm chunks are indexed
printf '%s\n' "Sample knowledge base document for the MailBox One smoke test. This is paragraph one." "" "This is paragraph two. It contains product pricing information." > /tmp/kb-sample.txt
curl -fsS -X POST http://localhost:3000/api/kb/documents -F "file=@/tmp/kb-sample.txt"

# 6. List documents
curl -fsS http://localhost:3000/api/kb/documents | jq .

# 7. Search (direct qdrant call with a manually embedded query)
QUERY_VEC=$(curl -fsS -X POST http://localhost:11434/api/embeddings -H 'content-type: application/json' -d '{"model":"nomic-embed-text:v1.5","prompt":"product pricing"}' | jq -c .embedding)
curl -fsS -X POST http://localhost:6333/collections/mailbox_rag/points/search -H 'content-type: application/json' -d "{\"vector\": $QUERY_VEC, \"limit\": 3, \"with_payload\": true, \"score_threshold\": 0.4}" | jq .

# 8. Import the two new sub-workflows
./scripts/n8n-import-workflows.sh
```
</action>
<read_first>
  - dashboard/backend/src/rag/client.ts
  - dashboard/backend/src/routes/kb.ts
  - n8n/workflows/06-rag-ingest-sent-history.json
  - n8n/workflows/07-rag-index-new-message.json
</read_first>
<acceptance_criteria>
- `curl -fsS http://localhost:6333/collections/mailbox_rag | jq -r '.result.status'` returns `green` or `ok`
- `curl -fsS http://localhost:6333/collections/mailbox_rag | jq -r '.result.config.params.vectors.size'` returns `768`
- `curl -fsS http://localhost:6333/collections/mailbox_rag | jq -r '.result.config.params.vectors.distance'` returns `Cosine`
- `curl -fsS -X POST http://localhost:3000/api/kb/documents -F "file=@/tmp/kb-sample.txt" | jq -r '.chunks'` returns a positive integer
- `curl -fsS http://localhost:3000/api/kb/documents | jq '.documents | length'` returns at least `1`
- `docker compose exec -T n8n n8n list:workflow | grep -q '06-rag-ingest-sent-history'`
- `docker compose exec -T n8n n8n list:workflow | grep -q '07-rag-index-new-message'`
</acceptance_criteria>
</task>

</tasks>

<verification>
```bash
# 1. Collection exists with correct shape
curl -fsS http://localhost:6333/collections/mailbox_rag | jq -e '.result.config.params.vectors.size == 768 and .result.config.params.vectors.distance == "Cosine"' > /dev/null

# 2. Document upload + list + delete round-trip
SID=$(curl -fsS -X POST http://localhost:3000/api/kb/documents -F "file=@/tmp/kb-sample.txt" | jq -r .source_id)
curl -fsS http://localhost:3000/api/kb/documents | jq -e --arg sid "$SID" '.documents[] | select(.source_id == $sid)' > /dev/null
curl -fsS -X DELETE "http://localhost:3000/api/kb/documents/$SID" -o /dev/null -w '%{http_code}' | grep -q 204

# 3. Similarity threshold enforced in code
grep -q '0.72' dashboard/backend/src/rag/client.ts

# 4. Both RAG workflows imported
docker compose exec -T n8n n8n list:workflow | grep -q '06-rag-ingest-sent-history'
docker compose exec -T n8n n8n list:workflow | grep -q '07-rag-index-new-message'

# 5. Embed dim guard present
grep -q '768' dashboard/backend/src/rag/embed.ts
```
</verification>
