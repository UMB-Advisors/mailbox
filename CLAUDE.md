<!-- GSD:project-start source:PROJECT.md -->
## Project

**MailBox One — Email Agent Appliance**

A dedicated hardware appliance (Jetson Orin Nano Super) that runs an AI email agent for small business operators. The customer plugs in a box, connects their email, completes guided onboarding (which captures their industry / business description so the classifier and drafter speak in their context), and gets an always-on assistant that triages, drafts, and (with approval) sends email responses on their behalf. Sold as a managed product with white-glove onboarding and optional support subscription.

Customer #1 was a small-batch CPG operator (Heron Labs); customer #2 is a B2B tech / dev-tools company (Staqs). The product is industry-agnostic at the prompt layer per the 2026-05-08 CPG-scrub — `business_description` is a per-appliance persona override populated during onboarding, not a hardcoded vertical (see `dashboard/lib/drafting/persona.ts` `PersonaContext`).

**Core Value:** Inbound operational email gets triaged, drafted, and (with human approval) sent — without the operator spending 1-3 hours/day on email. Tuned per-customer via persona overrides; no vertical lock-in.

### Constraints

- **Hardware**: 8GB unified VRAM — local models limited to ~4B params quantized. NVMe storage: 500GB.
- **Power**: < 25W sustained under normal operation.
- **Latency**: Inbound email → draft in queue: < 30s local path, < 60s cloud path.
- **Boot time**: Cold boot to fully operational < 3 minutes.
- **Privacy**: All email content and knowledge base stored only on local appliance. No bulk corpus sent to cloud.
- **API provider**: Anthropic Claude (pooled Glue Co API key, billed to customer at cost + 20%).
- **Updates**: OTA via GitHub Container Registry (GHCR), customer-initiated only.
- **Phase 1 budget**: $800 (1 unit hardware + cloud API for testing).
<!-- GSD:project-end -->

<!-- GSD:stack-start source:research/STACK.md -->
## Technology Stack

> **As-built status (2026-05-01)** — this section reflects the live appliance, not aspirational recommendations. Customer #1 is at `mailbox.heronlabsinc.com`; customer #2 target 2026-05-20. Major divergences from the original STACK.md research doc are flagged with the relevant Decision Record (DR-NN).

### Core Technologies (live)
| Technology | Version | Purpose | Notes |
|------------|---------|---------|-------|
| Ollama | `ollama/ollama@sha256:...` (digest-pinned per appliance — STAQPRO-240, 2026-05-08) | Local LLM inference server | Upstream ARM64 multi-arch image; works with NVIDIA runtime via `nvidia-container-toolkit` on JetPack 6.2. **Pin by digest in `.env`** (`OLLAMA_IMAGE=ollama/ollama@sha256:<digest>`), never `:latest` — `:latest` silently bumped M2 from 0.20.5 → 0.23.0 and triggered the Qwen3 thinking-mode classification regression that consumed Sessions 2+3 of the customer-#2 install (see `docs/plan-jetson-02-install-automation-v0_2-2026-05-05.md` Session 3 + `n8n/workflows/MailBOX-Classify.json` `think: false`). Live fleet 2026-05-08: M1=`sha256:662109db...` (0.20.5), M2=`sha256:5600a652...` (0.23.0). The historical `dustynv/ollama:0.18.4-r36.4-cu126-22.04` reference (jetson-containers `autotag` lineage) is documented but not in active use — both customers run upstream images. |
| Qdrant | 1.17.1 | Vector database for RAG | Deployed but not yet wired — Phase 2 RAG. `MALLOC_CONF=narenas:1` set per ARM64 jemalloc workaround (issue #4298). |
| n8n | **2.14.2** | Workflow runtime | Upgraded from `1.123.35` → `2.14.2` on 2026-05-01 (STAQPRO-181, supersedes DR-17). All 4 workflow JSONs (`MailBOX`, `MailBOX-Classify`, `MailBOX-Draft`, `MailBOX-Send`) re-import + activate cleanly in 2.x; validated against dev compose before prod cutover. **Ingress = Schedule (5 min) + Gmail Get** per DR-22 KILL of Pub/Sub push. No IMAP. |
| Postgres | 17-alpine | Operational datastore | Schema `mailbox`. Hosts n8n's `workflow_entity` table on the same DB. |
| Next.js 14 dashboard | App Router + Kysely | Approval queue UI + internal API routes | **DR-24**: dedicated Next.js service (`mailbox-dashboard`), not an Express+Vite SPA and not a Brain plugin. Internal routes: `/api/internal/{draft-prompt,draft-finalize,classification-prompt,classification-normalize,onboarding/live-gate,inbox-messages}` plus CRUD under `/api/drafts/...`. **Dashboard ORM ADR (2026-05-01)**: Kysely chosen over Prisma/Drizzle on Jetson hardware grounds. |
| Caddy | 2.x | Public HTTPS + auth gate | Cloudflare DNS-01 cert. `basic_auth` on **all paths** (`/dashboard/*`, `/`, `/webhook/*`) per **STAQPRO-131** + **STAQPRO-161**. The `/webhook/*` bypass that existed for the retired Pub/Sub push (DR-22 KILLED 2026-04-30) was removed; the dashboard's approve→send loop calls n8n via internal docker DNS (`http://n8n:5678/webhook/mailbox-send`) and never traverses Caddy. Bcrypt `$` chars need `$$` escaping in `.env`. |
### Models (live)
| Model | Pull Tag / Provider | Size (VRAM) | Purpose | Notes |
|-------|----------|------------|---------|-------|
| Qwen3-4B (custom ctx) | `qwen3:4b-ctx4k` (4096 ctx) | ~2.7 GB | Classifier + local drafter | Custom Modelfile `FROM qwen3:4b-instruct` (non-thinking variant) with `PARAMETER num_ctx 4096` per DR-18. **Never `FROM qwen3:4b`** — that bare tag is a moving alias that shifted to a thinking-trained variant 2026-05-05; the drafting code's `/no_think` directive doesn't work against it and LOCAL drafts come out empty (STAQPRO-330). Routes via `LOCAL_CATEGORIES`: `reorder`, `scheduling`, `follow_up`, `internal`, `inquiry`. `/no_think` directive still set on classify path (harmless on instruct variant which has no thinking capability anyway). |
| nomic-embed-text | `nomic-embed-text:v1.5` | 274 MB | RAG embeddings | Pulled but not yet wired (Phase 2 RAG). |
| gpt-oss:120b | Ollama Cloud (`ollama.com`) | — (cloud) | Cloud-escalation drafter — **default cloud model** | Per Eric's 2026-04-30 pivot superseding DR-23. Same `/api/chat` shape as local Ollama → swap baseUrl + key only. Routes via `CLOUD_CATEGORIES`: `escalate`, `unknown`, plus any `confidence < 0.75` safety net. |
| claude-haiku-4-5-20251001 | Anthropic API | — (cloud) | Alt-cloud fallback (config-ready, not active) | Wired via `ANTHROPIC_API_KEY` env; commented out in `.env.example` so the Ollama Cloud path is the live default. Switch by populating `ANTHROPIC_API_KEY` and pointing the draft route at the Anthropic provider. |
### Supporting Libraries (Dashboard Service — Next.js 14)
| Library | Version | Purpose | Notes |
|---------|---------|---------|-------|
| `next` | 14.2.x | Framework + dashboard runtime | App Router. Internal API routes under `app/api/**/route.ts`. |
| `pg` | ^8.13 | Postgres driver | Pool client wrapped in `dashboard/lib/db.ts`. The pool feeds Kysely (typed query surface) and is also exposed via `getPool()` for the migration runner, the `sql.raw` escape hatch, and test setup/teardown helpers. `setTypeParser(1184/1114)` overrides keep TIMESTAMP/TIMESTAMPTZ as strings — preserved across the Kysely path via codegen `--type-mapping`. |
| `kysely` | ^0.28.16 | Typed SQL query builder | **Adopted 2026-05-01** per the Dashboard ORM ADR. `getKysely()` returns `Kysely<DB>`; `DB` is generated by `kysely-codegen` into `dashboard/lib/db/schema.ts`. All `dashboard/lib/queries*.ts` helpers and route inline queries route through Kysely. `sql.raw` escape hatch available where raw SQL reads cleaner. |
| `kysely-codegen` | ^0.20.0 (devDep) | Schema introspection → TS types | Run via `npm run db:codegen` — bootstraps a temp postgres:17-alpine, applies `dashboard/test/fixtures/schema.sql`, generates `dashboard/lib/db/schema.ts`. CI verifies drift via `npm run db:codegen:verify`. Flags: `--dialect postgres --default-schema mailbox --include-pattern 'mailbox.*' --numeric-parser string --type-mapping '{"timestamp":"string","timestamptz":"string","date":"string"}'`. |
| Migrations | plain SQL files | Schema versioning | `dashboard/migrations/NNN-*.sql` ordered numerically; runner is `dashboard/migrations/runner.ts` (custom tsx script, no drizzle-kit, no prisma-migrate). Tracking table: `mailbox.migrations`. Compose service: `docker compose --profile migrate run mailbox-migrate`. |
| `zod` | ^4.4.1 | Runtime validation | Adopted in **STAQPRO-138** (shipped 2026-05-01). Schemas as plain `z.object({...})` in `dashboard/lib/schemas/` parsed by `dashboard/lib/middleware/validate.ts`. Routes use `parseJson(req, schema)` / `parseParams(params, schema)` — structured 400 on failure, narrow types on success. No ORM-derived schemas (Kysely doesn't emit them). |
| `tailwindcss` | 3.4.x | Utility CSS | Mobile-responsive dashboard. (Note: original STACK.md spec was Tailwind v4 + Vite 6 — DR-24 flipped to Next.js 14 which currently runs Tailwind v3.) |
### Development Tools
| Tool | Purpose | Notes |
|------|---------|-------|
| Docker (via JetsonHacks) | Container runtime | Install via JetsonHacks `install_nvidia_docker.sh` — installs whatever version is current and validated for the installed JetPack (currently 27.5.1). Do NOT use `docker-ce` from Docker Inc. — breaks NVIDIA runtime configuration paths on JetPack. Do NOT use `docker.io` directly — JetsonHacks handles NVIDIA runtime wiring automatically |
| `nvidia-container-toolkit` | GPU passthrough to containers | Install via `apt-get install -y nvidia-container-toolkit` then `nvidia-ctk runtime configure --runtime=docker`. Required for Ollama GPU access |
| `jetson-containers` (dusty-nv) | Validated container images (historical alternative — not in active use) | The `autotag ollama` lineage produces JetPack-matched images. Live fleet uses upstream `ollama/ollama` instead — confirmed working with `nvidia-container-toolkit` on JetPack 6.2. Pin by digest, not by tag (STAQPRO-240). |
| `docker-compose` plugin | Orchestration | Use the Docker Compose v2 plugin (`docker compose`) not standalone `docker-compose` v1 (deprecated) |
| GHCR | OTA update registry | `ghcr.io` free for public images; multi-arch manifest push via `docker buildx` with `--platform linux/arm64` |
| `mkcert` | Local HTTPS | Optional: LAN HTTPS for dashboard if browser camera/mic permissions needed (not required for v1) |
## Installation
# --- Jetson host setup (run once after flash) ---
# Install Docker using JetsonHacks scripts (avoids broken docker-ce)
# Verify GPU passthrough
# --- Pull models via Ollama (after Docker Compose up) ---
# --- Dashboard dependencies ---
# --- React dashboard ---
## Docker Compose Service Config (critical settings)
## Alternatives Considered (historical)
| In use | Alternative | When alternative might apply |
|-------------|-------------|------------------------------|
| Ollama 0.18.x | llama.cpp direct | Only if needing GGUF features not yet in Ollama; Ollama adds ~50ms overhead but saves massive integration work |
| Qdrant | pgvector | Single-DB simplicity at < 100K vectors; pgvector is 3-4x slower on ANN. Phase 2 RAG decision. |
| n8n 2.14.2 | Custom Python orchestrator | Only if workflow logic becomes too complex for visual editing or n8n licensing becomes an issue. |
| Qwen3-4B (Q4_K_M, 4k ctx) | Llama-3.2-3B | Llama-3.2-3B is better for fine-tuning per distil labs; Qwen3-4B wins out-of-the-box classification. We re-tested 2026-04-30; Qwen3 stays. |
| nomic-embed-text v1.5 | nomic-embed-text-v2-moe | v2-moe is 475M params (vs 137M); creates memory pressure alongside Qwen3-4B on 8GB unified RAM. |
| Ollama Cloud `gpt-oss:120b` | Anthropic Haiku 4.5 | Both wired; same Ollama-shape API. Haiku is config-ready alt-cloud — flip by populating `ANTHROPIC_API_KEY`. Per 2026-04-30 pivot. |
| Next.js 14 dashboard | Express + Vite SPA | Original STACK.md spec; **flipped to Next.js per DR-24** (single service, App Router internal API routes, easier OAuth-callback patterns). |
| Kysely (pure-TS query builder) over raw pg.Pool | Drizzle / Prisma | **2026-05-01 Dashboard ORM ADR** (supersedes the 2026-04-27 ADR's "Drizzle as MVP target" half). Prisma rejected on Jetson grounds: separate Rust query-engine sidecar process (~80-150MB resident on ARM64) plus migration-tooling fight with the existing 8 hand-authored `.sql` migrations plus type cascade through 14 zod schemas (Prisma emits Date for TIMESTAMP; pg type-parser overrides force string). Drizzle rejected as redundant churn — its main value is its schema DSL, but our hand-written `.sql` migrations are an asset, not a liability. Kysely's `kysely-codegen` introspects the canonical schema snapshot and emits typed DB row shapes into `dashboard/lib/db/schema.ts`; `--type-mapping` flags preserve the timestamp/numeric-as-string convention end-to-end. |
## What NOT to Use
| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `docker-ce` (Docker Inc. repo) | Breaks NVIDIA runtime configuration paths on JetPack — GPU passthrough stops working | JetsonHacks `install_nvidia_docker.sh` |
| Mistral-7B or any 7B+ local model | 7B Q4_K_M needs ~4.5GB VRAM; leaves < 3.5GB for embeddings + system on 8GB unified RAM | Qwen3-4B (Q4_K_M, ~2.7GB, 4k ctx) |
| IMAP polling / SMTP send | The DR-22 KILL settled on n8n's Gmail Get + Gmail Reply nodes via OAuth (refresh token in n8n's encrypted credential store). No `imapflow` or `nodemailer` dependency. | Gmail Get + Gmail Reply (n8n nodes, OAuth via the appliance) |
| Pub/Sub push ingress | **DR-22 KILLED 2026-04-30** by Linus/Liotta/Neo consensus. Eliminates GCP project, watch renewal cron, and public webhook attack surface. | Schedule trigger (5 min) + Gmail Get polling |
| `docker-compose` v1 (standalone binary) | Deprecated upstream | Docker Compose v2 plugin (`docker compose`) |
| Auto-updating `:latest` tags in production | Silent breakage on OTA at a customer site is a support incident | Pin all service images to specific tags or digests; OTA via GHCR with controlled rollout |
| Langchain/LlamaIndex inside n8n | Duplicates what n8n already does natively; adds Python runtime dependency | n8n built-in AI Agent + Ollama Model nodes |
## Stack Patterns by Variant
- Live fleet runs `ollama/ollama` upstream images, digest-pinned in `.env` per appliance (`OLLAMA_IMAGE=ollama/ollama@sha256:<digest>`). The `jetson-containers run $(autotag ollama)` / `dustynv/ollama` path is a documented alternative but not in production — `nvidia-container-toolkit` configured per the JetsonHacks install script is sufficient for upstream-image GPU passthrough on JetPack 6.2.
- Capture the live digest before pinning: `IID=$(docker inspect mailbox-ollama-1 --format '{{.Image}}'); docker inspect "$IID" --format '{{range .RepoDigests}}{{.}}{{println}}{{end}}'`
- Check logs for `Nvidia GPU detected via cudart` — absence means toolkit is misconfigured
- This is a known open issue (GitHub #4298, open as of Nov 2025)
- Workaround: set `environment: - MALLOC_CONF=narenas:1` in docker-compose
- If that fails, build from source on-device: `cargo build --release` with `JEMALLOC_SYS_WITH_LG_PAGE=16`
- The official multi-arch image (`qdrant/qdrant:v1.17.1`) includes the `-arm64` tag variant; pull explicitly with `docker pull qdrant/qdrant:v1.17.1-arm64` if the manifest auto-select fails
- MEDIUM confidence on workaround reliability — test in Phase 1 sprint 1
- The n8n Anthropic Chat Model node accepts any model ID string as a custom value
- Set model to `claude-haiku-4-5-20251001` manually — n8n passes it directly to the API
- Qwen3 can toggle between thinking (chain-of-thought) and non-thinking mode
- For classification tasks (latency-sensitive), add `/no_think` system prompt directive
- For draft generation, thinking mode is acceptable (< 60s cloud SLA has headroom)
- Rollback procedure: `docker compose pull [service]@[previous-digest]`
- Pin digests not just versions: `qdrant/qdrant@sha256:...` in production compose file
- Pre-pull new image before stopping old container to minimize downtime
## Version Compatibility
| Package | Compatible With | Notes |
|---------|-----------------|-------|
| JetPack 6.2 (L4T r36.4) | Ollama 0.18.x+, CUDA 12.x | JetPack 6.2 introduced "Super Mode" which unlocks full 40 TOPS on Orin Nano Super — requires JetPack 6.2 specifically, not 6.0/6.1 |
| Docker 27.5.1 (via JetsonHacks) | nvidia-container-toolkit 1.17.x | Installed by JetsonHacks `install_nvidia_docker.sh`; version is managed by JetsonHacks and may advance. Always verify GPU passthrough after install with `docker run --rm --runtime nvidia nvidia/cuda:12.3.0-base-ubuntu22.04 nvidia-smi` |
| n8n 2.x | Postgres 13+ | n8n 2.0 dropped support for SQLite in multi-user mode; use Postgres 17 |
| n8n 2.x | Node.js 20+ (inside container) | n8n's Docker image ships its own Node.js; no host Node.js needed |
| Qdrant 1.17.x | `@qdrant/js-client-rest` ^1.11 | The JS client REST version should match the server major version; 1.17 server is API-compatible with 1.11 client |
| Qwen3-4B (Q4_K_M) | Ollama 0.6.0+ | Qwen3 family requires Ollama 0.6.0+ for proper tokenizer support; 0.18.x is well above this floor |
| nomic-embed-text:v1.5 | Ollama 0.1.26+ | Requires Ollama 0.1.26 per official library page |
| React 18 | Node.js 18+ (build time) | React 18 concurrent features require Node.js 18+; build happens on dev machine or CI, not on Jetson |
| Tailwind CSS v4 | Vite 6.x | Tailwind v4 requires Vite 6+ via the `@tailwindcss/vite` plugin (replaces PostCSS config) |
## Memory Budget (8GB Unified VRAM)
| Component | Typical Footprint | Notes |
|-----------|------------------|-------|
| Ubuntu 22.04 + JetPack 6.2 OS | ~1.5 GB | Baseline with Docker daemon running |
| Ollama daemon (no model loaded) | ~150 MB | |
| Qwen3-4B Q4_K_M (loaded) | ~2.7 GB | Stays loaded while processing emails |
| nomic-embed-text:v1.5 (loaded) | ~350 MB | May unload between RAG operations; Ollama LRU cache |
| Qdrant | ~200-400 MB | Depends on vector count; 10K emails ≈ 100MB index |
| n8n | ~300 MB | Node.js process; 2.x is more memory efficient than 1.x |
| Postgres | ~100 MB | Small operational DB; not analytics |
| Dashboard (nginx + Express) | ~100 MB | Static files via nginx + Express API |
| **Total estimate** | **~5.7 GB** | **~2.3 GB headroom for bursts and OS cache** |
## Sources
- [Jetson AI Lab — Ollama Tutorial](https://www.jetson-ai-lab.com/tutorials/ollama/) — GPU Docker setup for JetPack
- [JetsonHacks — Docker Setup on JetPack 6](https://jetsonhacks.com/2025/02/24/docker-setup-on-jetpack-6-jetson-orin/) — Docker 27.5.1 Jetson install
- [Cytron — Docker Setup for Jetson Orin Nano Super JP6.2](https://www.cytron.io/tutorial/docker-setup-for-jetson-orin-nano-super-jp6.2) — install_nvidia_docker.sh walkthrough
- [Ollama GitHub Releases](https://github.com/ollama/ollama/releases) — v0.18.4 latest stable confirmed 2026-03-26
- [Qdrant GitHub Releases](https://github.com/qdrant/qdrant/releases) — v1.17.1 latest stable confirmed 2026-03-27
- [Qdrant ARM64 jemalloc issue #4298](https://github.com/qdrant/qdrant/issues/4298) — open as of Nov 2025; workarounds documented
- [n8n Release Notes](https://docs.n8n.io/release-notes/) — 2.14.2 current stable (March 2026)
- [n8n Docker Hub](https://hub.docker.com/r/n8nio/n8n) — `latest-arm64` tag confirmed
- [n8n Ollama Integration](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.lmollama/) — built-in Ollama Model node
- [n8n Anthropic Chat Model node](https://n8n.io/integrations/anthropic/) — Claude integration confirmed
- [Ollama — nomic-embed-text](https://ollama.com/library/nomic-embed-text:v1.5) — 274MB, requires Ollama 0.1.26+
- [Qwen3-4B GGUF on Hugging Face](https://huggingface.co/Qwen/Qwen3-4B-GGUF) — Q4_K_M quantization variants confirmed
- [Distil Labs — Best Base Model for Fine-Tuning Benchmark](https://www.distillabs.ai/blog/we-benchmarked-12-small-language-models-across-8-tasks-to-find-the-best-base-model-for-fine-tuning/) — Qwen3-4B classification superiority
- [Anthropic Models Overview](https://platform.claude.com/docs/en/about-claude/models/overview) — claude-haiku-4-5-20251001 model ID
- [Jeremy Morgan — Jetson Orin Nano Speed Test](https://www.jeremymorgan.com/blog/tech/nvidia-jetson-orin-nano-speed-test/) — ~20 tok/s for 3.5B models
- [NVIDIA JetPack 6.2 Super Mode Blog](https://developer.nvidia.com/blog/nvidia-jetpack-6-2-brings-super-mode-to-nvidia-jetson-orin-nano-and-jetson-orin-nx-modules/) — 2x inference boost confirmed for JetPack 6.2 vs 6.1
- [nomic-embed-text-v2-moe release](https://simonwillison.net/2025/Feb/12/nomic-embed-text-v2/) — 475M params MoE analysis
- postgres:17-alpine — [Docker Hub official image](https://hub.docker.com/_/postgres) — multi-arch ARM64 confirmed
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

### Draft status state machine
`mailbox.drafts.status` lifecycle (live CHECK constraint): `pending` → `awaiting_cloud` (when route is `CLOUD_CATEGORIES` and the cloud call is in flight) → (`approved` | `rejected` | `edited`) → `sent`. Source of truth for the enum is the Postgres CHECK constraint defined in `dashboard/migrations/003-evolve-drafts-to-queue-shape-v1-2026-04-27.sql` (last narrowed by migration 016 / STAQPRO-202, which dropped `'failed'`). Route handlers must import a single TS constant for the enum (planned home: `dashboard/lib/types.ts`), not redeclare string literals — this is what STAQPRO-137 will consolidate.

Send-side failures no longer flip status — Gmail Reply errors leave the row at `approved`; the StuckApproved UI surfaces it for operator-driven retry (5s arm window + "may have already sent — verify in Gmail Sent" warning before re-fire). The retry route (`/api/drafts/[id]/retry`) accepts `'approved'` only; the approve route accepts `'pending'` and `'edited'` only.

**Audit log (STAQPRO-185, migration 009)**: every `mailbox.drafts.status` change is captured in `mailbox.state_transitions` (append-only) by a Postgres `AFTER UPDATE OF status` trigger. The trigger fires on `IS DISTINCT FROM` so same-value writes don't pollute the log. Caller-supplied actor + reason are read from session-local GUCs `mailbox.actor` and `mailbox.transition_reason` — set with `SELECT set_config(...)` inside a transaction. `dashboard/lib/transitions.ts:transitionToApprovedAndSend` sets `actor='operator'` + `reason=approve|retry`; flips done by n8n's MailBOX-Send Postgres node and any other unannotated path default to `actor='system'`. The trigger is the source of truth for "what changed when" — do NOT add ad-hoc audit writes from app code.

**Persona resolver (STAQPRO-195)**: every draft now reads its `PersonaContext` (`tone`, `signoff`, `operator_first_name`, `operator_brand`) from `mailbox.persona` via `dashboard/lib/drafting/persona.ts:getPersonaContext`. Three-layer fallback per field: operator override (`statistical_markers.tone` etc, set via the persona settings UI per STAQPRO-149) → extraction-derived (`formality_score` band → tone, `sign_off_top[0]` → signoff, populated by STAQPRO-153 extraction) → hardcoded Heron Labs default. The hardcoded layer keeps drafts byte-identical until either the operator sets explicit overrides or extraction populates the row. The old `lib/drafting/persona-stub.ts` is removed.

`drafts.draft_source` (live CHECK constraint): `local` | `cloud` | `local_qwen3` | `cloud_haiku`. Current code populates `local` or `cloud` (the route, not the model); the actual model used is recorded in `drafts.model` (e.g. `qwen3:4b-ctx4k`, `gpt-oss:120b`, `claude-haiku-4-5-20251001`). The `local_qwen3` / `cloud_haiku` qualified values exist in the constraint as historical-compatibility carry-overs from earlier migrations but are not the values written by the live drafting path.

### `inbox_messages` denormalization
`mailbox.inbox_messages` carries its own `classification`, `confidence`, `classified_at`, `model`, `draft_id` columns alongside the per-draft state in `mailbox.drafts`. Treat `inbox_messages` as the message-level snapshot of the latest classification + currently linked draft. `mailbox.classification_log` is the append-only history.

**Sync mechanism (STAQPRO-244, migration 021, 2026-05-08)**: the n8n workflow JSON does NOT write these columns directly — until 2026-05-08 they were dead schema (only 10 of 951 rows on M1 had values, all from a one-shot manual backfill). Two `AFTER INSERT` Postgres triggers in the `mailbox` schema now keep them in sync:
- `trg_sync_inbox_from_classification_log` on `mailbox.classification_log` updates `classification` / `confidence` / `classified_at` / `model` (latest log row wins on re-classification)
- `trg_sync_inbox_draft_id` on `mailbox.drafts` sets `inbox_messages.draft_id` to the most recent draft's id

`mailbox.classification_log` remains the source of truth — if `inbox_messages.classification` ever drifts (e.g., a manual UPDATE bypasses the trigger via DISABLE), replay with the backfill query in migration 021. The `Classify lag` health stat in `dashboard/lib/queries-system.ts` reads from `classification_log` via LEFT JOIN, not from the denormalized columns, so it's unaffected by drift.

### `rag_context_refs` field semantics (STAQPRO-191 / STAQPRO-192)
`mailbox.drafts.rag_context_refs` and `mailbox.sent_history.rag_context_refs` are both `jsonb DEFAULT '[]'::jsonb`. They store a JSON array of Qdrant point UUIDs (RFC 4122 v4) that were retrieved to augment the draft prompt at draft-assembly time. Empty array `[]` means one of: retrieval was gated (`cloud_gated`), upstream unavailable (`embed_unavailable`, `qdrant_unavailable`), or the counterparty had no prior history (`no_hits`).

- **`drafts.rag_context_refs`** is written by `/api/internal/draft-prompt` (STAQPRO-191) at the moment the draft is assembled. Truth at draft time.
- **`sent_history.rag_context_refs`** is the post-send archival snapshot. The migration 010 archival trigger (STAQPRO-189) carries the column over alongside the rest of the row when status flips to `'sent'`. Truth at send time.

The point UUIDs are deterministic (`sha256(message_id)`-derived per `dashboard/lib/rag/qdrant.ts:pointIdFromMessageId`), so given a stored UUID + the original `inbox_messages.message_id` corpus, you can replay which prior messages a draft saw. Combined with the `mailbox.state_transitions` log (STAQPRO-185), this gives a full audit chain: which retrieval refs → which draft → which final outcome (approved | edited | rejected | sent).

**Do NOT mutate these arrays after the trigger fires.** Both columns are point-in-time snapshots; later edits or re-retrievals do not retroactively write back. Future re-eval work that wants "what would today's RAG return" should query Qdrant fresh, not edit historical refs.

### Route handler pattern
All API handlers under `dashboard/app/api/**/route.ts` follow the App Router contract: export named handlers (`GET`, `POST`, `PATCH`) that accept `(request: Request, { params })` and return a `Response`. Internal routes (`/api/internal/*`) are not auth-gated by Caddy basic_auth — they're called from n8n inside the docker network. **STAQPRO-138 is in flight**: replace inline `typeof x !== 'string'` checks with zod schemas in `dashboard/lib/schemas/` parsed by a shared validate middleware (`dashboard/lib/middleware/validate.ts`).

### SQL convention
Hand-rolled SQL via `pg.Pool` from `dashboard/lib/db.ts`. Two surface patterns: (a) named query helpers in `dashboard/lib/queries*.ts` (preferred — keeps SQL out of route handlers and gives them a typed surface) and (b) inline `pool.query(sql, params)` calls inside a route file when the query is one-off. **Direction**: when the same SQL gets used by 2+ routes, promote it into `lib/queries*.ts`. Always parameterize — never string-concatenate user input into SQL.

### Comment standard (migration files)
Per migration 007 (the first migration to land the standard): every migration file opens with a 2-3 line block comment stating (i) what the migration changes, (ii) why (link the Linear issue or DR), and (iii) any reversal/rollback note. Schema-touching SQL only — no DML in migrations unless specifically called out as a backfill.

### `.env` escaping
Bcrypt hashes (used by Caddy `basic_auth` for `MAILBOX_BASIC_AUTH_HASH`) contain literal `$` characters. Docker Compose treats `$` as variable expansion and silently truncates values at the `$`. **Escape every `$` to `$$` in `.env`** or your hash will be empty inside the container. This bit us on the first Caddy deploy.

### Caddy basic_auth rotation gotchas (2026-05-08)
Two footguns when rotating dashboard basic_auth credentials:

1. **`caddy hash-password` requires `--plaintext` for non-interactive use.** Without a TTY it expects to prompt twice for confirmation, so piping (`echo -n "$PASS" | docker exec -i mailbox-caddy-1 caddy hash-password`) returns empty. Use `docker exec mailbox-caddy-1 caddy hash-password --plaintext "$PASS"` instead — yes the password is in argv on the host briefly, accept that for a single-user appliance.
2. **`docker compose restart caddy` does NOT pick up `.env` changes** — `restart` is stop/start of the existing container with its baked-in env. To apply env-var changes you must `docker compose up -d caddy` (which recreates the container if env or compose changed). The "Deploy flow" section's `restart caddy` instruction is correct for Caddyfile-only changes (bind-mounted, re-read on restart) but **wrong for `.env` changes**. Confirm via `docker exec mailbox-caddy-1 sh -c 'echo ${MAILBOX_BASIC_AUTH_HASH:0:10}'` — if the prefix doesn't match what's in `.env` (after `$$`-unescaping), the container hasn't been recreated.

**Canonical rotation (audit 2026-05-15)** — use `bin/rotate-basic-auth`.
Single command, handles both footguns, includes post-rotation verification
that the live container actually picked up the new hash:

    ./bin/rotate-basic-auth mailbox1                              # generate + apply
    ./bin/rotate-basic-auth --dry-run mailbox2                    # preview without applying
    ./bin/rotate-basic-auth --update-1password 'mailbox.heronlabsinc.com' mailbox1
                                                                  # apply + edit 1P item

Source: `bin/rotate-basic-auth`. The script writes a timestamped `.env`
backup before sed-ing in the new hash, then `docker compose up -d caddy`
(not `restart`) to force container recreation, then verifies via
`docker exec ... echo ${MAILBOX_BASIC_AUTH_HASH:0:10}`.

Manual fallback (no shell access to this repo on your workstation):

    NEW_PASS=$(openssl rand -base64 32 | tr -dc 'A-Za-z0-9' | head -c 28)
    HASH=$(ssh mailbox1 "docker exec mailbox-caddy-1 caddy hash-password --plaintext '$NEW_PASS'")
    ESCAPED=$(echo "$HASH" | sed 's/\$/\$\$/g')
    ssh mailbox1 "cd ~/mailbox && cp .env .env.bak-rotate-\$(date +%Y%m%d-%H%M%S) && \
      sed -i 's|^MAILBOX_BASIC_AUTH_HASH=.*|MAILBOX_BASIC_AUTH_HASH=$ESCAPED|' .env && \
      docker compose up -d caddy"
    # verify with the LAN IP because public DNS may be stale (STAQPRO-238)
    curl -sk -o /dev/null -w '%{http_code}\n' --resolve mailbox.heronlabsinc.com:443:192.168.50.179 \
      -u "admin:$NEW_PASS" https://mailbox.heronlabsinc.com/dashboard/queue

Then store the new plaintext in 1Password (see "Credentials" below).

### Gmail rate-limit cooldown — retries during cooldown extend the penalty (2026-05-08, STAQPRO-271)
When n8n's `Gmail Reply` (or any Gmail call) returns `User-rate limit exceeded. Retry after <ts>`, **do not retry until the stated `<ts>` AND ideally well past it**. Each retry during the cooldown window pushes the deadline further out — the second incident (2026-05-08) saw 4 retries push the cooldown by `+1h 44min` over the original 15-min stated retry-after, and a retry **46 min past the stated deadline** still 429'd and re-extended the penalty by another 61 min.

Empirical lessons confirmed:
- **Stated `Retry-After` is a soft minimum, not a guarantee.** The real cooldown can be hours-to-day (per STAQPRO-232 forensics) and grows with each in-cooldown attempt.
- **Read and send quotas are independent buckets.** During a send-side cooldown, `MailBOX` parent's `Gmail Get` keeps polling fine — don't disable the parent workflow on a send-side 429.
- **n8n's webhook returns an empty body when the `Gmail Reply` node throws** (the `Respond Success`/`Respond Failure` terminal nodes are never reached). Dashboard's `JSON.parse('')` then throws `Unexpected end of JSON input` and returns 502. Treat any 502 with that error string as a Gmail send failure, fetch the actual cause from `execution_data.data` of the latest errored `MailBOX-Send` execution.

How to inspect a stuck send:

    EXEC=$(ssh mailbox1 "docker exec mailbox-postgres-1 psql -U mailbox -d mailbox -tAc \\
      \"SELECT id FROM execution_entity WHERE \\\"workflowId\\\"=(SELECT id FROM workflow_entity \\
      WHERE name='MailBOX-Send') AND status='error' ORDER BY \\\"startedAt\\\" DESC LIMIT 1;\"")
    ssh mailbox1 "docker exec mailbox-postgres-1 psql -U mailbox -d mailbox -tAc \\
      \"SELECT data FROM execution_data WHERE \\\"executionId\\\"=$EXEC;\"" \
      | grep -oE '\"User-rate limit[^\"]+\"'
    # → "User-rate limit exceeded.  Retry after 2026-05-08T19:08:18.719Z"

Until STAQPRO-231 lands a circuit-breaker, the manual cooldown SLO is: **don't fire `MailBOX-Send` again until `now > stated_retry_after + 1 hour`**, and on subsequent failures double the wait. If the operator escalates ("we need to send NOW"), the only safe path is sending the reply manually from the underlying Gmail account.

### n8n workflow editing
- **All four MailBOX workflows must be `active=true` on n8n 2.x.** `MailBOX` (parent, ScheduleTrigger), `MailBOX-Classify`, `MailBOX-Draft`, `MailBOX-Send` (sub-workflows invoked via `executeWorkflowTrigger`). The pre-2.x guidance — that sub-workflows should stay `active=false` to avoid cosmetic "could not activate" warnings — was retracted in n8n 2.x: now an `executeWorkflow` call to an inactive sub-workflow throws *"Workflow is not active and cannot be executed"* and dark-classifies the inbox until caught (STAQPRO-181 hit this for ~12h on M2 post-2.14.2 upgrade). The post-n8n-upgrade verification one-liner in **Deployment Target → Post-n8n-upgrade verification** is the canonical guardrail. The dashboard CLAUDE.md's STAQPRO-186 boundary contract still mentions the pre-2.x guidance — treat that as historical, the n8n 2.x reality is "all four active."
- `n8n update:workflow --active=...` is a NO-OP at runtime unless the n8n container is restarted. The flag persists to the DB but the live runtime keeps the old activation state cached.
- `Insert Inbox (skip dupes)` with no Gmail returns produces an empty `$json` that still fires `Run Classify Sub` once. That's why empty 5-min cycles error harmlessly at `Load Inbox Row`. Pre-existing, benign, but confusing if not explained.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

### Service topology (8-service Docker Compose stack on Jetson)

| Service | Image | Role |
|---------|-------|------|
| `postgres` | `postgres:17-alpine` | Operational DB (`mailbox` schema) + n8n's `workflow_entity` table |
| `qdrant` | `qdrant/qdrant:v1.17.1` | Vector store. Collection `email_messages` (768d / Cosine) holds inbound + outbound message embeddings for RAG retrieval (M3.5 / STAQPRO-188). Payload indexes: `message_id`, `thread_id`, `sender`, `direction`, `sent_at`, `classification_category`. Bootstrap via `docker compose --profile qdrant-bootstrap up mailbox-qdrant-bootstrap` (idempotent). |
| `ollama` | `ollama/ollama@sha256:<per-appliance digest>` (STAQPRO-240 — pin in `.env`, never `:latest`) | Local LLM inference (Qwen3-4B classifier + drafter, nomic-embed-text) |
| `n8n` | `n8nio/n8n:2.14.2` | Workflow runtime; sub-workflows: `MailBOX`, `MailBOX-Classify`, `MailBOX-Draft`, `MailBOX-Send` |
| `caddy` | `caddy:2` | Public HTTPS via Cloudflare DNS-01; basic_auth on all paths (incl. `/webhook/*` per STAQPRO-161 — bypass removed post-DR-22) |
| `mailbox-dashboard` | Next.js 14 build | Approval queue UI + internal API routes (DR-24) |
| `mailbox-migrate` | Custom tsx migration runner | `docker compose --profile migrate run mailbox-migrate` — runs `dashboard/migrations/runner.ts` against the `mailbox.migrations` tracking table, applies un-applied `.sql` files in numeric order |
| `mailbox-qdrant-bootstrap` | One-shot tsx bootstrap | `docker compose --profile qdrant-bootstrap run mailbox-qdrant-bootstrap` — runs `dashboard/scripts/qdrant-bootstrap.ts`. Creates the `email_messages` collection (768d / Cosine for nomic-embed-text:v1.5) and ensures payload indexes. Idempotent — safe to re-run on every appliance boot. |

**Operator shell access**: Tailscale SSH only (`tailscale ssh bob@<tailnet-host>`). The previously-deployed `ttyd` browser terminal was removed 2026-05-01 per STAQPRO-126 (NC-27) — basic_auth-per-device didn't scale across N customers. Tailscale is identity-based; revoking a user removes shell access from every appliance instantly.

### Pipeline flow (live as of 2026-05-01)

```
Schedule (5 min)
  └─> Gmail Get  ──> Insert Inbox (skip dupes)
                         └─> Run Classify Sub  (MailBOX-Classify)
                                  └─> qwen3:4b-ctx4k classify (with /no_think)
                                  └─> live-gate check
                                  └─> Insert Draft Stub
                                       └─> Run Draft Sub  (MailBOX-Draft)
                                              ├─ LOCAL route  → qwen3:4b-ctx4k        → /api/internal/draft-finalize
                                              └─ CLOUD route  → Ollama Cloud (gpt-oss:120b) → /api/internal/draft-finalize
                                                    (Anthropic Haiku 4.5 = config-ready alt-cloud)
                                                    └─> mailbox.drafts.status = pending_approval
                                                          └─> Dashboard approval queue (operator reviews)
                                                                 └─> approve → Run Send Sub (MailBOX-Send)
                                                                                   └─> Gmail Reply → mailbox.drafts.status = sent
```

### Routing rules (`dashboard/lib/classification/prompt.ts:routeFor`)

- `spam_marketing` → drop (no draft created)
- `confidence < 0.75` → cloud (safety net)
- `LOCAL_CATEGORIES` (`reorder`, `scheduling`, `follow_up`, `internal`, `inquiry`) → local Qwen3
- `CLOUD_CATEGORIES` (`escalate`, `unknown`) → Ollama Cloud (`gpt-oss:120b` default; `OLLAMA_CLOUD_MODEL` env override)

### RAG retrieval (M3.5 / STAQPRO-191)

`POST /api/internal/draft-prompt` embeds the inbound message and queries Qdrant `email_messages` with a hard sender filter (`payload.sender == inbound.from_addr`) for counterparty-scoped recall. Top-k snippets land in `lib/drafting/prompt.ts` `rag_refs` (already wired) and the point IDs persist into `drafts.rag_context_refs` for STAQPRO-192 traceability.

**Privacy gate (cloud route)**: per the project Constraints ("All email content stored only on local appliance. No bulk corpus sent to cloud."), retrieved corpus snippets feeding a cloud-route prompt are additional cloud-bound data. Default behavior:

- **LOCAL route** (Qwen3 on-device) — retrieval ALWAYS runs.
- **CLOUD route** (Ollama Cloud / Anthropic) — retrieval runs only when `RAG_CLOUD_ROUTE_ENABLED=1`. Otherwise `retrieveForDraft` returns `{ refs: [], reason: 'cloud_gated' }` and drafting falls back to persona-stub.

Tunables (env): `RAG_RETRIEVE_TOP_K` (default 3, sized for the 4096-token Qwen3 context per DR-18), `RAG_RETRIEVE_EXCERPT_CHARS` (default 600 ≈ 150 tokens per snippet).

Failure modes (`retrieveForDraft` in `dashboard/lib/rag/retrieve.ts` returns `{ refs: [], reason: ... }`): `cloud_gated`, `embed_unavailable`, `qdrant_unavailable`, `no_hits`, plus `disabled` when the eval harness sets `RAG_DISABLED=1` to short-circuit retrieval (STAQPRO-198 — operator-only, never set in production). Drafting falls back to persona-stub on any non-`ok` reason — RAG is augmentation, not gate. The reason is persisted alongside refs in `drafts.rag_retrieval_reason` (TEXT, default `'none'` per migration 013), and the trigger from STAQPRO-189 carries it onto `sent_history` at archival time.

### RAG ingestion (M3.5 / STAQPRO-190)

The Qdrant `email_messages` collection (STAQPRO-188) is populated by:

- **Inbound — automatic.** `/api/internal/inbox-messages` POST (called by n8n `MailBOX > Insert Inbox` node) fires a fire-and-forget `embedText() → upsertEmailPoint()` after a successful insert (only when `created=true` to skip dedupe re-fires). Failures are logged and swallowed; n8n's response is not blocked. Latency-wise the embed runs in parallel with the response, so the 5-min poll cycle isn't extended.
- **Outbound — explicit.** `POST /api/internal/embed` (`dashboard/app/api/internal/embed/route.ts`) is the single entry point. The `MailBOX-Send` workflow should add an HTTP node *after* `Mark Sent` that POSTs `{ message_id, sender, recipient, subject, body, sent_at, direction: 'outbound', classification_category }` to `http://mailbox-dashboard:3001/api/internal/embed`. The route is idempotent on `message_id` (deterministic Qdrant point UUID), so re-fires are safe.
- **Backfill — one-shot.** `docker exec mailbox-dashboard npx tsx scripts/rag-backfill.ts` backfills from `mailbox.inbox_messages` + `mailbox.sent_history` over a configurable lookback window (env `BACKFILL_LOOKBACK_HOURS` mirrors the in-script knob; the script header documents `RAG_BACKFILL_LOOKBACK_DAYS` as a logical unit, default 90 days). Idempotent on point UUID. Gmail History-API backfill (pre-appliance history) is intentionally deferred — the local-row corpus is the v1 starting point. **Image requirement (commit `7c655e6`)**: the dashboard runtime stage now copies `/app/lib` so `tsx`'s `../lib/...` imports resolve. Pre-`7c655e6` images shipped scripts but not lib, so this command failed with `Cannot find module '../lib/rag/embed'`. Same path applies to all operator one-shots: `classify-backfill`, `qdrant-bootstrap`, `rag-eval-harness`, `gmail-history-backfill`. Verify the runtime has `/app/lib` before invoking: `docker exec mailbox-dashboard ls /app/lib/rag/embed.ts`.

Failure semantics: every RAG path returns success-shaped responses on Ollama or Qdrant outage so the draft pipeline keeps running. RAG is augmentation, not gate.

### Active decision records

| DR | Decision | Status |
|----|----------|--------|
| DR-17 | Pin n8n to `1.123.35` (avoid 2.x migration for MVP) | **Superseded 2026-05-01 (STAQPRO-181)** — upgraded to `2.14.2` after dev-compose validation confirmed all 4 workflow JSONs re-import + activate cleanly |
| DR-18 | `qwen3:4b-ctx4k` @ 4096 ctx as T2 default | Active |
| DR-22 | Pub/Sub push as Phase 1 ingress | **KILLED 2026-04-30** — stay polling |
| DR-23 | Anthropic Haiku 4.5 as primary cloud draft model | **SUPERSEDED 2026-04-30** — Ollama Cloud `gpt-oss:120b` is default; Haiku is config-ready alt |
| DR-24 | Dedicated Next.js 14 dashboard service (not Brain plugin, not Express+Vite SPA) | Active |
| DR-25 | llama.cpp as T2 local inference runtime (Phase 1, behind `LOCAL_INFERENCE_RUNTIME=llama-cpp`); SDK HTTP abstraction in `dashboard/lib/llm/` + `/api/internal/llm/api/{chat,generate}` proxy keeps n8n runtime-agnostic; Ollama retained on T3+ and for embeddings on T2 | **Proposed 2026-05-13** — design + SDK abstraction landed, on-device build + §3.5.5 envelope re-validation pending per STAQPRO-338. See `dashboard/.planning/spec/addendum-t2-build-validation-v0_2-2026-05-13.md` and `docs/runbook/llamacpp-migration.v0.1.0.md` |
| DR-50 | Deterministic operator-domain preclass for `internal` category (lifted recall 0.22 → PASS) | Active |
| 2026-04-27 ADR (Dashboard Stack Pivot) | Next.js 14 single-service architecture (active); Drizzle-as-MVP-target half **SUPERSEDED 2026-05-01** by Dashboard ORM ADR (Kysely) | Partial — single-service half active, ORM half superseded |
| 2026-05-01 ADR (Dashboard ORM) | Kysely chosen over Prisma/Drizzle on Jetson hardware grounds + migration-tooling + type-cascade reasoning. Closes STAQPRO-136. | Active |

### Public surface

**Customer #1 — `mailbox.heronlabsinc.com` (M1, `192.168.50.179`):**
- `https://mailbox.heronlabsinc.com/dashboard/queue` — approval queue (basic_auth gated per STAQPRO-131)
- `https://mailbox.heronlabsinc.com/` — n8n editor (basic_auth gated)
- `https://mailbox.heronlabsinc.com/webhook/*` — n8n webhook ingress (basic_auth gated per STAQPRO-161; the dashboard's approve→send loop bypasses Caddy via internal docker DNS at `http://n8n:5678/webhook/mailbox-send`)

**Customer #2 — `mailbox.staqs.io` (M2, `192.168.50.11`, deployed 2026-05-05):**
- `https://mailbox.staqs.io/dashboard/queue` — approval queue (basic_auth, same gating model as M1)
- `https://mailbox.staqs.io/` — n8n editor (basic_auth)
- `https://mailbox.staqs.io/webhook/*` — n8n webhook ingress (basic_auth)
- TLS via Cloudflare DNS-01, zone owned by Eric@staqs.io's CF account; A record proxied=false (LAN IP).
- Caddyfile currently hardcodes the M1 hostname and was hand-`sed`'d to `mailbox.staqs.io` for this install — see install plan v0.2 follow-up #6 for the templating fix that needs to land before customer #3.

### Per-customer subdomain pattern (NC-25 / STAQPRO-183)

**Pattern for customers 3+:** `<customer-slug>.mailbox.<staqs-shared-domain>` resolves to the appliance's LAN IP. Caddy solves TLS via Cloudflare DNS-01 (challenge happens entirely over the Cloudflare API — never traverses public internet to the appliance), so non-routable LAN IPs work fine.

**Why this exists:** M1 and M2 each consumed bespoke DNS setup (customer-owned domain, customer-paid Cloudflare account). NC-25 collapses that to one Staqs-owned parent zone — customer plugs the appliance into their router, opens the HTTPS hostname, done. Customer #1 (`mailbox.heronlabsinc.com`) stays as a customer-owned exception; M2 (`mailbox.staqs.io`, Eric's personal zone) is grandfathered until/unless we re-issue.

**Shared parent domain:** `staqs.io` (locked in as part of NC-25 / STAQPRO-183). `MAILBOX_SHARED_DOMAIN` is the env var the provisioning script reads; the operator sets it to `staqs.io` on shared-subdomain appliances. The Caddyfile itself only sees `{$DOMAIN}` which is the fully-resolved hostname.

**Cert resolver:** Shared `CLOUDFLARE_API_TOKEN` (scope: Zone → DNS → Edit on the parent zone only). Same token serves both Caddy (cert issuance at runtime) and `scripts/provision-customer-dns.sh` (A-record creation at provision time). NEVER use an account-wide token — the blast radius of a leaked appliance token has to be one zone.

**A-record provisioning:** Run from the provisioner workstation, NOT on the Jetson.
```bash
# .env on provisioner workstation must export:
#   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ZONE_ID, MAILBOX_SHARED_DOMAIN
./scripts/provision-customer-dns.sh <customer-slug> <appliance-LAN-IP>
# e.g.:  ./scripts/provision-customer-dns.sh acme 192.168.50.11
# →  acme.mailbox.staqs.io  A  192.168.50.11   (proxied=false, TTL 60s)
```

Idempotent: re-running with the same IP is a no-op; re-running with a new IP updates in place. `--dry-run` previews without API calls. See script header for full env/exit-code docs.

**Caddy reads `DOMAIN` from the appliance's `.env`** — set it to the fully-resolved hostname (`acme.mailbox.staqs.io`) on the appliance. The Caddyfile's `tls { dns cloudflare {env.CLOUDFLARE_API_TOKEN} }` block is the same for shared-subdomain and customer-owned-domain appliances; only `DOMAIN` and the token's zone scope change between them.

**Gotcha — proxied mode:** Cloudflare's "Proxied" (orange-cloud) mode intercepts and rewrites traffic, which both (a) hides the LAN IP from end users (defeats the LAN-only model) and (b) breaks the cert challenge. The provisioning script hardcodes `proxied=false`; if you ever create records manually in the dashboard, leave the cloud icon grey.

**Runbook cross-link:** [`docs/runbook/provisioning.v0.1.0.md`](docs/runbook/provisioning.v0.1.0.md) §5 (Customer DNS + Cloudflare API token) — the runbook owns the customer-facing checklist; this section owns the architectural rationale.

### Test coverage

**STAQPRO-133 (open)** — there are no Vitest tests yet. The existing `scripts/smoke-test.sh` is **infrastructure** smoke (GPU, Qdrant, Postgres) — it does not exercise the pipeline. Pipeline + schema + route tests are scheduled to land before customer #2.
<!-- GSD:architecture-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd:quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd:debug` for investigation and bug fixing
- `/gsd:execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->



<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd:profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->

## Related Repositories

Sibling repos that aren't part of the appliance build but inform development:

- **`~/mailbox-queue-sandbox/`** — UI/UX design sandbox for the dashboard. Vite + React 19 + Tailwind v4, runs at `http://localhost:5173/` via `pnpm dev`. Fixtures pulled from real M1 production data (real sender addresses + bodies) — **local-only git repo, not pushed**. Use it to prototype dashboard UI before porting to `dashboard/` (Next.js production). Design decisions made here propagate back; fixtures stay redacted/local.

<!-- GSD:deployment-start -->
## Deployment Target

The appliance is reachable from this workstation via SSH alias `mailbox1`
(tailnet: `mailbox1.tail377a9a.ts.net`, user `bob`). A direct-LAN alias
`mailbox1-lan` points at `192.168.50.179` for use when the tailnet path
isn't preferred. The Jetson runs the deployed code from `/home/bob/mailbox/` —
same git remote as this local clone.

A legacy isolated `10.42.0.0/24` direct-ethernet path remains configured
via NetworkManager profiles ("jetson-direct" on the workstation, "Wired
connection 1" on the Jetson) at workstation `10.42.0.1` / Jetson `10.42.0.2`,
providing ~0.5ms RTT vs the router LAN's typical 1-5ms. Currently inactive —
the appliance has been on the router LAN since the bring-up move.

### Reading appliance state

- Container status: `ssh mailbox1 'cd ~/mailbox && docker compose ps'`
- Service logs: `ssh mailbox1 'docker logs <service> --tail 50'`
- Live config: `ssh mailbox1 'cat /home/bob/mailbox/<path>'`
- Health probes: `ssh mailbox1 'docker compose -f ~/mailbox/docker-compose.yml exec <svc> <cmd>'`

### Deploy flow

This local clone is the source of truth. Edit here, commit, push, then on the Jetson: pull and reload.

    # On this workstation
    git add . && git commit -m "..." && git push origin master

    # Apply on the Jetson (one-liner from this workstation)
    ssh mailbox1 'cd ~/mailbox && git pull && docker compose up -d --build --remove-orphans'

**Always pass `--remove-orphans`** on full-stack `up` calls. When a service is removed from `docker-compose.yml` (e.g., the ttyd removal in STAQPRO-182), the running container becomes an orphan and keeps its host port binding — `--remove-orphans` cleans it up automatically. Without it, you'll see `docker compose down <service>` return "no such service" while the container is still listening.

For **Caddyfile** changes (bind-mounted, no rebuild), restart the container:

    ssh mailbox1 'cd ~/mailbox && git pull && docker compose restart caddy'

For **`.env` changes** that drive Caddy env vars (`MAILBOX_BASIC_AUTH_HASH`, `MAILBOX_BASIC_AUTH_USER`, etc.), use `up -d` instead — `restart` reuses the container's baked-in env and silently keeps stale values:

    ssh mailbox1 'cd ~/mailbox && docker compose up -d caddy'

(See **Conventions → Caddy basic_auth rotation gotchas** for full rotation flow including the `caddy hash-password --plaintext` requirement.)

Don't use `docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile` — STAQPRO-161 deploy hit a case where the admin-API reload reported "config is unchanged" and kept the old config loaded even though the bind-mounted Caddyfile on the host had the new content. Full container restart re-reads the bind mount cleanly. Cost is ~1s of dropped connections vs the silent stale-config trap.

### Credentials — 1Password (MailBOX vault)

Operator-side credentials for both appliances live in the **1Password "MailBOX" vault** under `dustin@umbadvisors.com`'s account. Single source of truth; never paste these into commits, Linear, or chat history.

| Item | Vault | Purpose | Notes |
|---|---|---|---|
| `mailbox.heronlabsinc.com` | MailBOX | M1 dashboard sign-in (Caddy basic_auth) | username `admin`, URL `https://mailbox.heronlabsinc.com/dashboard/queue` |
| `mailbox.staqs.io` | MailBOX | M2 dashboard sign-in (Caddy basic_auth) | username `admin`, URL `https://mailbox.staqs.io/dashboard/queue` |
| `mailbox1` | MailBOX | M1 SSH user + appliance Postgres password | SSH user `bob` (use the `mailbox1` ssh alias / Tailscale identity-based auth — no password needed for SSH itself); the Postgres password matches `POSTGRES_PASSWORD` in M1's `.env` |
| `mailbox2` | MailBOX | M2 SSH user + appliance Postgres password | Same shape as `mailbox1`. M2's SSH path is Tailscale-ACL-gated; no `authorized_keys` on M2. |

Retrieve from CLI: `op item get 'mailbox.heronlabsinc.com' --vault MailBOX --reveal`. After basic_auth rotation (rotation flow above), update the corresponding 1P item with `op item edit '<title>' --vault MailBOX password='<new-plaintext>'` — don't create a new item, edit the existing one so URLs/tags persist.

Customer-side: when the appliance is operated by someone other than Dustin (Heron Labs operator, Staqs operator), share the relevant 1Password item to that person's 1Password account rather than emailing the password.

### Public surface

**M1 (`192.168.50.179`, customer #1):**
- Dashboard: `https://mailbox.heronlabsinc.com/dashboard/queue`
- n8n editor: LAN-only at `http://192.168.50.179:5678` (was `192.168.1.45:5678` pre-router-LAN move; old IP referenced in older docs)
- Ollama API: `http://192.168.50.179:11434` (LAN only)
- Qdrant: `http://192.168.50.179:6333` (LAN only)

**M2 (`192.168.50.11`, customer #2, deployed 2026-05-05):**
- Dashboard: `https://mailbox.staqs.io/dashboard/queue`
- **No host port bindings for ollama / n8n / qdrant** — M2's `docker-compose.yml` omits the `ports:` block on those services, so they're docker-network-only. To probe from the workstation, either `ssh mailbox2 'docker exec mailbox-dashboard wget -qO- http://ollama:11434/api/tags'` or open an SSH tunnel: `ssh -L 5678:localhost:5678 mailbox2`. This is the safer default and should be backported to M1.

### Post-n8n-upgrade verification

After **any** n8n version bump or workflow re-import, all four `MailBOX*`
workflows must be `active=true` or the polling chain silently breaks at the
`Run Classify Sub` ExecuteWorkflow node ("Workflow is not active and cannot
be executed"). `n8n import:workflow` defaults to `active=false`; STAQPRO-135
hit this on the original deploy and STAQPRO-181 (n8n `1.123.35 → 2.14.2`,
2026-05-01) re-introduced the gap, dark-classifying ~12h of inbox before it
was caught.

**Canonical guardrail (audit 2026-05-15)** — `mailbox-n8n-verify` compose
profile. Exits 0 when all four `MailBOX*` workflows are `active=t`, exits
1 when any are missing or inactive (with a clear rollup of which), exits
2 on connection error. Safe to re-run; read-only against `workflow_entity`.

    ssh mailbox1 "cd ~/mailbox && docker compose --profile n8n-verify run --rm mailbox-n8n-verify"

Source: `dashboard/scripts/n8n-verify.ts`. Use this in install runbooks
and OTA scripts — the non-zero exit code is the gate.

Manual fallback (no compose profile available, e.g. raw psql access):

    ssh mailbox1 "docker exec mailbox-postgres-1 psql \
      -U \$(grep ^POSTGRES_USER /home/bob/mailbox/.env | cut -d= -f2-) \
      -d \$(grep ^POSTGRES_DB /home/bob/mailbox/.env | cut -d= -f2-) \
      -c \"SELECT name, active FROM workflow_entity WHERE name LIKE 'MailBOX%' ORDER BY name;\""

All four (`MailBOX`, `MailBOX-Classify`, `MailBOX-Draft`, `MailBOX-Send`)
must show `active = t`. The dashboard `/status` page also surfaces this via
the **Classify lag** Stat — green ("caught up") when no unclassified
inbox_messages in the last 24h, red when the oldest unclassified row is
older than 15 min. Use the Stat as the always-on guardrail; use the
`mailbox-n8n-verify` profile as the deploy gate.

Activation runbook (post-import): toggle Active on each sub-workflow in the
n8n editor (`http://mailbox1:5678`), or via CLI:

    ssh mailbox1 "docker exec mailbox-n8n-1 n8n update:workflow --active=true --id=<id>"
    ssh mailbox1 "cd /home/bob/mailbox && docker compose restart n8n"

The CLI flag is a no-op at runtime without the restart (n8n caches
activation state in memory).

### Tailscale access

Both Jetsons live on the shared `consultingfutures@gmail.com` tailnet
(MagicDNS suffix `tail377a9a.ts.net`) and on the same router LAN
(`192.168.50.0/24`). SSH aliases in `~/.ssh/config`:

| Alias          | Tailnet host                  | Tailnet IP       | LAN IP           | Local user | Repo path                |
|----------------|-------------------------------|------------------|------------------|------------|--------------------------|
| `mailbox1`     | `mailbox1.tail377a9a.ts.net`  | `100.65.9.2`     | `192.168.50.179` | `bob`      | `/home/bob/mailbox/`     |
| `mailbox2`     | `mailbox2.tail377a9a.ts.net`  | `100.120.102.45` | `192.168.50.11`  | `mailbox`  | `/home/mailbox/mailbox/` |

`mailbox1-lan` and `mailbox2-lan` aliases point at the LAN IPs directly for
when the tailnet path isn't preferred. mailbox2 uses Tailscale SSH (banner
`SSH-2.0-Tailscale`), gated by the tailnet ACL — `consultingfutures@gmail.com`
is permitted to SSH `tag:mailbox` machines as `bob`, `mailbox`, `mailbox2`,
`root`. Identity-based; no `authorized_keys` needed on mailbox2.

The two boxes are **not** identical-layout: user and repo path differ
(`bob` / `/home/bob/mailbox/` vs `mailbox` / `/home/mailbox/mailbox/`). Use
`~/mailbox/` rather than a hardcoded path in cross-box commands.

LAN-only services on mailbox2 are reachable via the tailnet hostname
(provided the compose port bindings are `0.0.0.0`, not `127.0.0.1`):

- Dashboard direct: `http://mailbox2.tail377a9a.ts.net:3001/dashboard/queue`
- n8n editor: `http://mailbox2.tail377a9a.ts.net:5678`
- Ollama API: `http://mailbox2.tail377a9a.ts.net:11434`
- Qdrant: `http://mailbox2.tail377a9a.ts.net:6333`

Fallback if a port is bound to localhost only:

    ssh -L 5678:localhost:5678 mailbox2

#### Hardware deltas (mailbox1 vs mailbox2)

Both are NVIDIA Jetson Orin Nano Engineering Reference Developer Kit Super,
JetPack 6.2 / L4T R36 rev 5.0 (build 2026-01-16, GCID 43688277), kernel
5.15.185-tegra, 8 GB unified RAM, MAXN_SUPER (mode 2). Real differences:

- **NVMe**: mailbox1 = SPCC M.2 PCIe SSD 953.9 GB; mailbox2 = Kingston
  SNV3S1000G 931.5 GB. Both DRAM-less consumer drives — fine for current
  workload, but worth re-benchmarking if RAG ingest or Postgres WAL ever
  becomes write-bound.
- **Ethernet PHY OUI**: mailbox1 `4c:bb:47` (NVIDIA), mailbox2 `3c:6d:66`
  (ASUSTek). Two valid Orin Nano Super dev kit revisions — the OUI alone
  is not a Jetson/non-Jetson signal.
- **Docker**: trivial patch drift (29.4.0 vs 29.4.2, both via JetsonHacks).
<!-- GSD:deployment-end -->
