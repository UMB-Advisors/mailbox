# Requirements: MailBox One

**Defined:** 2026-04-02
**Core Value:** Inbound operational email for small CPG brands gets triaged, drafted, and (with human approval) sent — without the founder spending 1-3 hours/day on email.

---

## Milestone M5 — Unified Entities (AgentBOX fork)

**Defined:** 2026-07-20
**Goal:** Make the CRM business/department model the single source of truth for every entity reference in the AgentBOX dashboard, and let entities come into existence automatically from connected accounts.
**Decisions locked:** auto-create is **silent + editable** (no connect-time prompt); auto-create applies to **all providers** (Gmail + IMAP/Microsoft) for parity; gbrain digest bridge is **in scope as the final phase** (one-way CRM → `entities.json`).

### Entity Creation (`ENT`)
- [ ] **ENT-01**: Authorizing/connecting an account (any provider) auto-creates a CRM business for it by default, named from `display_label` else email domain.
- [ ] **ENT-02**: Auto-create is idempotent — re-auth/reconnect of the same account never creates a duplicate business (`xmax=0` first-insert pattern; `businesses.name` UNIQUE → find-or-create via `ON CONFLICT DO NOTHING RETURNING id` + fallback select).
- [ ] **ENT-03**: Domain match — if a business already exists for the account's email domain, the account attaches to it rather than creating a new business.
- [ ] **ENT-04**: User can create a business manually (a company with no connected inbox).
- [ ] **ENT-05**: Auto-create is silent (no connect-time prompt); the created business is fully editable afterward (rename, re-map, add departments).

### Account ↔ Business Mapping (`MAP`)
- [ ] **MAP-01**: New nullable `mailbox.accounts.business_id` FK → `businesses.id`, `ON DELETE SET NULL` (mirrors shipped `departments.business_id`, migration 053).
- [ ] **MAP-02**: User can re-map a connected account to a different business.
- [ ] **MAP-03**: Disconnecting/un-mapping an account never deletes the business (set null, not cascade).
- [ ] **MAP-04**: Migration backfills the existing accounts↔businesses linkage (6 accounts, 3 businesses live) sensibly (domain match, else unlinked).

### Entity Management (`MANAGE`)
- [ ] **MANAGE-01**: User can rename any business, including auto-created ones.
- [ ] **MANAGE-02**: User can add/manage departments per business (reaffirm existing capability under the unified model).
- [ ] **MANAGE-03**: Deleting a business requires confirmation and surfaces what it will orphan (linked accounts, departments, jobs). Full business *merge* is deferred.

### Filter Unification (`FILT`)
- [ ] **FILT-01**: Agent Jobs business dropdown (`CronPage`) reads the live CRM business list, not hardcoded `ENTITY_OPTIONS`.
- [ ] **FILT-02**: Daily Brief entity filter reads the CRM source.
- [ ] **FILT-03**: Proposals entity tag reads the CRM source.
- [ ] **FILT-04**: Mail triage business references read the CRM source.
- [ ] **FILT-05**: Back-compat — add a `slug` column to `mailbox.businesses` + seed legacy slugs so existing cron jobs (which store a string slug in `jobs.json`, a flat file outside Postgres) keep resolving; no job orphaned. Slug backfill is a file-aware operation with rollback, not only a SQL migration.
- [ ] **FILT-06**: Retire `entities.ts`/`ENTITY_OPTIONS` (delete it to force compile errors on any missed consumer).

### gbrain Digest Bridge (`DIGEST`)
- [ ] **DIGEST-01**: One-way sync — CRM businesses generate the gbrain `entities.json` axis (CRM = source of truth; digest derives from it). Sequenced as the final phase; additive, non-blocking.

### Deferred / Out of Scope (named)
- Full business **merge** (combine two businesses + re-point all refs) — deferred to a later milestone.
- **Two-way** gbrain↔CRM sync — one-way (CRM→digest) only.
- Inline "attach to existing vs create new" prompt at connect time — rejected in favor of silent+editable (ENT-05).

### Traceability
_(filled by roadmap — each REQ maps to exactly one phase)_

---

## v1 Requirements

Requirements for Phase 1 internal dogfood. Each maps to roadmap phases.

### Infrastructure

- [ ] **INFRA-01**: Jetson Orin Nano Super flashed with JetPack 6.2 on NVMe SSD, booting headless
- [ ] **INFRA-02**: Docker 27.5.1 installed with NVIDIA Container Runtime, GPU passthrough verified
- [ ] **INFRA-03**: Power mode set to 25W (MAXN) at boot via systemd service
- [x] **INFRA-04**: Docker Compose stack running 5 services: Ollama, Qdrant, n8n, Postgres, Dashboard
- [x] **INFRA-05**: All services pass health checks within 3 minutes of cold boot
- [ ] **INFRA-06**: Qwen3-4B (Q4_K_M) loaded in Ollama with GPU inference verified (num_gpu_layers > 0)
- [ ] **INFRA-07**: nomic-embed-text v1.5 loaded in Ollama for embedding generation
- [x] **INFRA-08**: Qdrant running with jemalloc workaround for ARM64 (MALLOC_CONF=narenas:1)
- [x] **INFRA-09**: Postgres 17 with persistent volume, separate schemas for n8n (public) and mailbox data
- [ ] **INFRA-10**: OTA update mechanism: dashboard button pulls new images from GHCR, runs docker compose up -d
- [ ] **INFRA-11**: NVMe disk encryption (LUKS) for all customer data at rest
- [x] **INFRA-12**: System boot to fully operational in < 3 minutes

### Email Pipeline

- [ ] **MAIL-01**: Connect to customer email via OAuth2 (Gmail, Outlook/M365) or manual IMAP/SMTP credentials
- [ ] **MAIL-02**: Poll for new inbound emails at configurable interval (default 60 seconds) using n8n IMAP trigger
- [ ] **MAIL-03**: IMAP watchdog workflow to detect and restart dead IMAP trigger connections
- [ ] **MAIL-04**: Handle HTML and plain text email, extract body text, preserve threading/references
- [ ] **MAIL-05**: Classify every inbound email into one of 8 categories: inquiry, reorder, scheduling, follow-up, internal, spam/marketing, escalate, unknown
- [ ] **MAIL-06**: Classification runs on local Qwen3-4B with p95 latency < 5 seconds
- [ ] **MAIL-07**: Strip Qwen3 `<think>` tokens before JSON parse of classification output
- [ ] **MAIL-08**: Classification accuracy > 80% on Heron Labs email corpus (100-email test set)
- [ ] **MAIL-09**: Route simple responses (reorder, scheduling, follow-up at high confidence) through local Qwen3-4B
- [ ] **MAIL-10**: Route complex responses (inquiry, low-confidence, unknown) through cloud Claude Haiku API
- [ ] **MAIL-11**: All drafts include source classification, confidence score, and RAG context references
- [ ] **MAIL-12**: Graceful degradation: complex emails queue with "awaiting cloud" status if API unreachable
- [ ] **MAIL-13**: Send outbound emails via customer's SMTP (replies appear from their address)
- [ ] **MAIL-14**: Support up to 3 email accounts per appliance

### Approval Workflow

- [ ] **APPR-01**: All generated drafts enter approval queue visible in dashboard
- [ ] **APPR-02**: User can approve (send as-is), edit then approve, reject (discard), or escalate (flag for manual)
- [ ] **APPR-03**: Configurable auto-send rules: emails matching classification + confidence threshold bypass queue
- [ ] **APPR-04**: Auto-send defaults to OFF for all categories; user enables per-category after trust-building
- [ ] **APPR-05**: Dashboard shows pending queue count, time-in-queue per draft, daily/weekly send volume
- [ ] **APPR-06**: User can view and correct classifications to improve accuracy over time

### RAG & Knowledge Base

- [ ] **RAG-01**: Ingest customer's sent email history (last 6 months) during onboarding as background task with progress indicator
- [ ] **RAG-02**: Accept uploaded documents (PDF, DOCX, CSV) as knowledge base sources
- [ ] **RAG-03**: Incrementally index new sent and inbound emails to keep knowledge base current
- [ ] **RAG-04**: Vector search returns top-5 relevant context chunks via nomic-embed-text embeddings in Qdrant
- [ ] **RAG-05**: Minimum similarity threshold of 0.72 for context retrieval
- [ ] **RAG-06**: User can view, add, and remove knowledge base documents via dashboard

### Persona

- [ ] **PERS-01**: Voice profile extracted from sent email history during onboarding (sentence length, formality, greeting/closing patterns, vocabulary)
- [ ] **PERS-02**: Persona tuning interface: user reviews 20 sample drafts, marks each good tone / wrong tone / edit
- [ ] **PERS-03**: 3-5 approved email pairs (inbound + response) curated per classification category as few-shot examples
- [ ] **PERS-04**: Maintain consistent voice/tone across all generated drafts
- [ ] **PERS-05**: Customer edits to drafts logged for monthly system prompt refinement

### Dashboard

- [ ] **DASH-01**: Web-based dashboard served locally at http://device.local:3000, accessible via LAN
- [ ] **DASH-02**: Local authentication (username + password, set during first-boot)
- [ ] **DASH-03**: Approval queue view with pending drafts, confidence scores, approve/edit/reject/escalate actions
- [ ] **DASH-04**: Sent history log with classification, draft source, and timestamp
- [ ] **DASH-05**: Classification log with confidence scores and category for every processed email
- [ ] **DASH-06**: Knowledge base management: view, upload, and remove documents
- [ ] **DASH-07**: Persona settings: view/edit voice profile, manage few-shot examples
- [ ] **DASH-08**: System status: uptime, email connection health, model status, disk usage, queue depth, API cost meter
- [ ] **DASH-09**: Mobile-responsive — primary interaction is phone browser on same Wi-Fi
- [ ] **DASH-10**: Notification config: queue threshold alert, daily digest email toggle

### Onboarding

- [ ] **ONBR-01**: First-boot wizard: create admin account on first visit to dashboard
- [ ] **ONBR-02**: Guided email connection: OAuth2 redirect for Gmail/Outlook or manual IMAP/SMTP entry
- [ ] **ONBR-03**: Automatic 6-month sent email history ingestion on email connection (background, progress shown)
- [ ] **ONBR-04**: Document upload flow for product catalog, pricing sheets, spec sheets
- [ ] **ONBR-05**: Persona tuning session: review 20 auto-generated sample drafts
- [ ] **ONBR-06**: Notification preferences setup (queue threshold, daily digest email address)

### Notifications

- [ ] **NOTF-01**: Email notification when approval queue exceeds configurable threshold (default: 5 pending)
- [ ] **NOTF-02**: Daily digest email: emails received, drafts generated, auto-sent, pending, escalated

## v2 Requirements

Deferred to future release. Tracked but not in current roadmap.

### Remote Access

- **RMTE-01**: Tailscale/WireGuard remote access to dashboard outside LAN

### Multi-User

- **MUSR-01**: Multi-user roles: admin, reviewer, read-only

### Relationship Graph

- **GRPH-01**: SQLite relationship graph with entity extraction (contacts, companies, products, prices, orders)
- **GRPH-02**: Graph-augmented context retrieval alongside vector similarity
- **GRPH-03**: Relationship graph dashboard view (visual map of contacts and deal flows)
- **GRPH-04**: Graph-powered proactive follow-up suggestions (detect stale threads)

### Integrations

- **INTG-01**: CRM sync (bi-directional with HubSpot)
- **INTG-02**: Shopify order context injection into RAG
- **INTG-03**: SMS/Slack webhook notifications

### Advanced

- **ADVN-01**: Active learning from approval edits (few-shot refinement, not model fine-tuning)
- **ADVN-02**: Fleet management dashboard for Glue Co
- **ADVN-03**: Outbound follow-up sequence drafting
- **ADVN-04**: Cross-account graph merge for multi-email setups

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| Consumer D2C support email | Product handles operational brand comms only |
| Email marketing / outbound campaigns | Different product entirely — route to Mailchimp |
| Full email client (compose arbitrary email) | Dashboard is approval surface, not email client |
| Voice / phone integration | Different modality and infrastructure |
| Mobile native app | Dashboard is mobile-responsive web |
| Real-time email push (WebSocket) | 60s IMAP poll sufficient for operational email |
| Global auto-send (no approval) | Irreversible relationship damage on error — graduated per-category only |
| Online model fine-tuning | Too complex for 8GB VRAM — use few-shot examples instead |
| Custom carrier board / production hardware | v1 uses Jetson dev kit |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| INFRA-01 | Phase 1 | Pending |
| INFRA-02 | Phase 1 | Pending |
| INFRA-03 | Phase 1 | Pending |
| INFRA-04 | Phase 1 | Complete |
| INFRA-05 | Phase 1 | Complete |
| INFRA-06 | Phase 1 | Pending |
| INFRA-07 | Phase 1 | Pending |
| INFRA-08 | Phase 1 | Complete |
| INFRA-09 | Phase 1 | Complete |
| INFRA-11 | Phase 1 | Pending |
| INFRA-12 | Phase 1 | Complete |
| MAIL-01 | Phase 2 | Pending |
| MAIL-02 | Phase 2 | Pending |
| MAIL-03 | Phase 2 | Pending |
| MAIL-04 | Phase 2 | Pending |
| MAIL-05 | Phase 2 | Pending |
| MAIL-06 | Phase 2 | Pending |
| MAIL-07 | Phase 2 | Pending |
| MAIL-08 | Phase 2 | Pending |
| MAIL-09 | Phase 2 | Pending |
| MAIL-10 | Phase 2 | Pending |
| MAIL-11 | Phase 2 | Pending |
| MAIL-12 | Phase 2 | Pending |
| MAIL-13 | Phase 2 | Pending |
| MAIL-14 | Phase 2 | Pending |
| RAG-01 | Phase 2 | Pending |
| RAG-02 | Phase 2 | Pending |
| RAG-03 | Phase 2 | Pending |
| RAG-04 | Phase 2 | Pending |
| RAG-05 | Phase 2 | Pending |
| RAG-06 | Phase 2 | Pending |
| PERS-01 | Phase 2 | Pending |
| PERS-02 | Phase 2 | Pending |
| PERS-03 | Phase 2 | Pending |
| PERS-04 | Phase 2 | Pending |
| PERS-05 | Phase 2 | Pending |
| ONBR-01 | Phase 2 | Pending |
| ONBR-02 | Phase 2 | Pending |
| ONBR-03 | Phase 2 | Pending |
| ONBR-04 | Phase 2 | Pending |
| ONBR-05 | Phase 2 | Pending |
| ONBR-06 | Phase 2 | Pending |
| APPR-01 | Phase 2 | Pending |
| APPR-02 | Phase 2 | Pending |
| APPR-03 | Phase 3 | Pending |
| APPR-04 | Phase 3 | Pending |
| APPR-05 | Phase 3 | Pending |
| APPR-06 | Phase 3 | Pending |
| NOTF-01 | Phase 3 | Pending |
| NOTF-02 | Phase 3 | Pending |
| INFRA-10 | Phase 3 | Pending |
| DASH-01 | Phase 4 | Pending |
| DASH-02 | Phase 4 | Pending |
| DASH-03 | Phase 4 | Pending |
| DASH-04 | Phase 4 | Pending |
| DASH-05 | Phase 4 | Pending |
| DASH-06 | Phase 4 | Pending |
| DASH-07 | Phase 4 | Pending |
| DASH-08 | Phase 4 | Pending |
| DASH-09 | Phase 4 | Pending |
| DASH-10 | Phase 4 | Pending |

**Coverage:**
- v1 requirements: 61 total
- Mapped to phases: 61
- Unmapped: 0

---
*Requirements defined: 2026-04-02*
*Last updated: 2026-04-02 after roadmap creation*
