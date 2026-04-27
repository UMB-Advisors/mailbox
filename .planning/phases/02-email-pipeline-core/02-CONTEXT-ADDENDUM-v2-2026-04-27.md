---
phase: 2
addendum: v2-pivot
created: 2026-04-27
references: 02-CONTEXT.md (v1 decisions D-01..D-24)
---

# Phase 2 Context Addendum — Architectural Pivot Decisions

This addendum captures decisions that emerged during the 2026-04-27
re-scoping of Phase 2 plans against the Next.js + n8n architecture
adopted in the ADR (`.planning/STATE.md` "Architectural Decision
Record: Dashboard Stack Pivot").

Decisions D-01..D-24 in `02-CONTEXT.md` remain in force unless
explicitly superseded here. Decisions below are numbered D-25 onward
and are referenced from the v2 stub plans
(`02-03..08-*-PLAN-v2-2026-04-27-STUB.md`).

---

## Cross-Plan Architectural Decisions

### D-25 — Threading header storage

**Plan:** 02-03 (IMAP ingestion)

`mailbox.inbox_messages` (kept as canonical from Phase 1 sub-project,
per 02-02-v2) does not yet carry `in_reply_to` or `references`
headers. Required by FR-MAIL-04 for SMTP reply threading.

**Decision:** ALTER TABLE inbox_messages ADD COLUMN in_reply_to TEXT,
references TEXT via a new forward migration (likely 009). Mirrors the
columns already added to `mailbox.drafts` in 02-02-v2 migration 003.

Rejected: separate `headers JSONB` column (more flexible but harder
to query); storing on `drafts` only (couples ingestion to drafts).

### D-26 — n8n → Postgres write path

**Plan:** 02-03 (IMAP ingestion); pattern applies to all n8n workflow
writes throughout Phase 2.

**Decision:** n8n Postgres node directly INSERTs to `mailbox.*`
tables for high-frequency append-only writes (`inbox_messages`,
`classification_log`). Reserve Next.js API route writes for
state-mutating operations that need cross-table consistency or
trigger downstream effects (already shipped as `app/api/drafts/*` for
approve/reject/edit/retry).

n8n holds Postgres credentials in its encrypted credential store. No
plaintext credentials in workflow JSON files committed to git.

Rejected: routing all writes through Next.js (adds network hop and
auth surface for high-frequency ingestion).

### D-27 — IMAP credentials entry UX

**Plan:** 02-08 (onboarding wizard)

n8n stores Gmail OAuth2 / IMAP credentials in its encrypted store.
The UX for *entering* those credentials is the open question.

**Decision:** Defer to 02-08-v2 stub. The credentials-by-name pattern
in n8n is unchanged from v1; 02-03 reads them by name. 02-08 will
specify whether the operator enters them via dashboard wizard
(automated, requires n8n REST API integration) or manually via SSH
during white-glove onboarding (less automated, more reliable).

### D-28 — Watchdog failure notification

**Plan:** 02-03 (IMAP watchdog)

v1 specified emailing the operator after 2 consecutive watchdog
restart failures. Email path uses customer SMTP — the same account
being watched, creating a circular dependency if SMTP itself is dead.

**Decision (Phase 2):** Skip operator email entirely. Surface
watchdog failures only on the dashboard status page (Phase 4
deliverable). Watchdog continues to log failures to Postgres for
audit.

**Decision (deferred to Phase 3):** Add operator notification with
the auto-send/notifications work (NOTF-01, NOTF-02) — at that point
notification infrastructure exists and the circular dependency can
be addressed properly (e.g. via a separate transactional SMTP
provider or webhook).

Rejected: adding a third-party transactional SMTP dependency in
Phase 2 just for watchdog alerts.

---

## Format

Each new decision adds a `### D-NN — Title` section above this line,
with at minimum:

- **Plan:** which v2 stub raised it
- A 1-3 paragraph explanation
- The decision in **bold** below
- "Rejected:" line(s) for alternatives that were considered

When a stub gets promoted to a full v2 plan, the cross-references in
that plan should cite both `02-CONTEXT.md` (D-01..D-24) and this
addendum (D-25+).

### D-29 — Ollama invocation path from n8n

**Plan:** 02-04 (classification + routing)

n8n can invoke Ollama via two paths: built-in Ollama Model node
(LangChain-style), or HTTP Request node calling
`http://ollama:11434/api/generate` directly. The choice matters
because the classification prompt is also imported by the
`heron-labs-score.mjs` scoring script that proves MAIL-08 accuracy.
If the prompt drifts between live workflow and scoring script,
accuracy regressions become invisible.

**Decision:** HTTP Request node. The canonical prompt lives at
`dashboard/lib/classification/prompt.ts` and is exposed read-only at
`GET /dashboard/api/internal/classification-prompt`. The n8n workflow
fetches the prompt at run-time and passes it to the Ollama HTTP API.
The scoring script imports the same TypeScript module directly. One
canonical source, drift impossible.

Rejected: built-in Ollama Model node (CLAUDE.md's preferred path),
because for classification specifically the drift risk silently
degrades accuracy. Other workflows (drafting in 02-07) may use the
built-in node where prompts don't have offline scoring counterparts.

### D-30 — Routing decision location

**Plan:** 02-04 (classification + routing)

The local-vs-cloud routing decision is a pure function of category +
confidence threshold (D-01, D-02). Could live in n8n IF node or as a
centralized TypeScript function exposed via API.

**Decision:** Keep routing in the n8n workflow's IF node. Document
the rule in this addendum so it's discoverable without opening
workflow JSON: route to local Qwen3 if `category IN
('reorder','scheduling','follow_up','internal') AND confidence >=
ROUTING_LOCAL_CONFIDENCE_FLOOR (default 0.75)`; route to cloud
Claude Haiku otherwise. Spam/marketing handled per D-21/D-31; never
routes to drafting.

Rejected: centralizing routing in
`dashboard/lib/classification/route.ts` exposed as an API route —
adds a network hop on every email for negligible benefit at single-
tenant Phase 2 scope.

### D-31 — Spam/marketing storage

**Plan:** 02-04 (classification + routing)

D-21 (v1) says spam/marketing emails skip the queue. v2's queue is
`mailbox.drafts` (not `draft_queue`). Same rule applies — spam
emails get a `classification_log` row but no `drafts` row.

**Decision:** Spam emails ARE retained in `mailbox.inbox_messages`
(the storage of raw inbound, immutable). The `drafts` row is what's
skipped. Dashboard `/api/drafts` JOIN already returns only inbox
rows that have a corresponding draft, so spam never appears in the
queue UI. Audit trail preserved in `inbox_messages` +
`classification_log`; storage cost trivial on NVMe.

Rejected: deleting spam from `inbox_messages` — irreversibly loses
ingestion history and the corpus for future ML retraining.

### D-32 — `auto_send_blocked` separation of concerns

**Plan:** 02-04 (classification + routing); affects Phase 3.

D-04 (v1) says `escalate` category sets `auto_send_blocked=true` and
"no future auto-send rule (Phase 3) can fire" on it. Clarifying the
v2 boundary:

**Decision:** 02-04 is responsible for SETTING `auto_send_blocked=true`
on INSERT to `mailbox.drafts` when category is `escalate`. ENFORCEMENT
of the flag (preventing auto-send) is Phase 3's responsibility, since
auto-send rules don't exist in Phase 2. 02-04's smoke test verifies
the flag is set correctly; it does NOT verify enforcement.

Not really a decision needing resolution — flagging the boundary so
Phase 3 implementers don't assume enforcement exists.

### D-33 — Qdrant collection topology

**Plan:** 02-05 (RAG ingest + retrieval)

Single tenant in Phase 2; multi-tenant on the roadmap. Choosing
between one collection with payload filters vs per-source or
per-customer collections.

**Decision:** Single Qdrant collection `mailbox_rag` for sent emails,
inbound emails, and uploaded documents. Payload-indexed fields
`source` ('sent_email' | 'inbound_email' | 'document'), `source_id`,
and `category` (denormalized from classification when source is
'inbound_email'). Filters at query time keep retrieval scoped.

Multi-tenancy added in Phase 3+ via a `customer_key` payload field
(no schema migration needed at the Qdrant level — Qdrant payloads
are schemaless). Phase 2 implicitly single-customer.

Rejected: per-source collections (over-engineered for one tenant);
per-customer collections (premature multi-tenancy).

### D-34 — Chunking strategy per source

**Plan:** 02-05 (RAG ingest + retrieval)

nomic-embed-text v1.5 has a 2K-token context window. Most CPG
operator email is short (a few hundred words = 1 chunk works).
Long documents and edge-case long emails need splitting.

**Decision:** Soft cap of 1500 tokens per chunk (well under 2K
ceiling). Single `chunk()` function at `dashboard/lib/rag/chunk.ts`
parameterized by source type:
- `source='sent_email'` or `'inbound_email'`: if under 1500 tokens,
  emit 1 chunk; otherwise paragraph-split
- `source='document'`: always paragraph-split, with `meta.location`
  payload field carrying page number (PDF) or row number (CSV) or
  paragraph index (DOCX)

Rejected: per-email-always (truncates long emails silently);
per-paragraph-always (loses cross-paragraph context for short
emails — most operator email).

### D-35 — Document upload format support

**Plan:** 02-05 (RAG ingest + retrieval); affects 02-08 (onboarding).

CPG operators commonly have product catalogs in PDF. Node-side PDF
parsing libraries pull binary deps that build flakily on ARM64.

**Decision:** Support PDF, DOCX, and CSV in Phase 2. Use system-
installed `pdftotext` (from `poppler-utils`, available in JetPack
6 base) as the PDF extraction path — invoke it via Node `child_process`
from `dashboard/lib/rag/extract.ts`. DOCX uses `mammoth` npm package.
CSV uses `papaparse` (already a stack dependency).

Avoids the brittle Node PDF parser ecosystem on ARM64 entirely. The
onboarding wizard accepts all three formats without operator-side
file conversion friction.

Rejected: deferring PDF to Phase 2.5+ (real onboarding friction —
most catalogs are PDFs); using `pdf-parse` or similar Node library
(binary dep flakiness on ARM64).

### D-36 — Embedding endpoint location

**Plan:** 02-05 (RAG); affects 02-07 (drafting).

Two callers need embeddings: bulk sent-history ingest in n8n
workflow (thousands of chunks) and drafting context-build in
TypeScript (single chunk per draft).

**Decision:** Single canonical embedding implementation at
`dashboard/lib/rag/embed.ts`. Two invocation paths:
- n8n bulk ingest workflow calls `http://ollama:11434/api/embeddings`
  directly (skip the Next.js round-trip for high-volume bulk work)
- Drafting (02-07) and document upload (02-05 single-doc path) call
  the TypeScript helper directly via `import`

If a future plan needs n8n-side single-shot embedding it can call
`POST /dashboard/api/internal/rag-embed` (not implemented in 02-05;
add when the use case appears).

Rejected: route everything through Next.js (slow for bulk ingest);
duplicate the embedding logic in n8n + TypeScript (drift risk on
prompts that aren't single-token-per-call).

### D-37 — Top-K retrieval API contract

**Plan:** 02-05 (RAG); contract consumed by 02-07 (drafting).

02-07's drafting context builder needs top-K relevant chunks.
Stable API contract decoupled from RAG internals.

**Decision:** Expose at `POST /dashboard/api/internal/rag-search`.

Request: `{ query: string, category?: ClassificationCategory,
            k?: number = 3 }`
Response: `{ results: [{ text, score, source, source_id, meta }] }`

Threshold filtering (RAG-05: 0.72) applied server-side before
returning. Below-threshold results are silently dropped, not
returned with a flag. Empty `results` is a valid response and means
"no relevant context found."

Rejected: have 02-07 import `lib/rag/client.ts` directly. Tighter
coupling; harder to swap retrieval backends later (e.g. if we move
from Qdrant to pgvector). The API boundary is testable in isolation.
