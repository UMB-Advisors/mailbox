---
gsd_state_version: 1.0
milestone: M3
milestone_name: customer #2 onboarded
milestone_axis_note: "Linear-aligned M-axis. M1 reference build (Phase 1 + first-pass 02-02/03/04/07) — DELIVERED. M2 2nd-appliance readiness — DELIVERED 2026-05-05 (mailbox2 live at mailbox.staqs.io). M3 customer #2 onboarded (current focus — install automation polish + 02-08 onboarding wizard finish). M4 Phase 2 RAG + edit-to-skill — partial (RAG STAQPRO-188-220 + persona STAQPRO-149-195 shipped; auto-send + notif + OTA still Phase 3). See ROADMAP.md crosswalk for M ↔ Phase mapping."
status: M2 DELIVERED 2026-05-05 (mailbox.staqs.io live for customer #2). Phase 2 substance shipped via Linear in lean execution — 02-05 RAG, 02-06 persona, 02-07 drafting all closed with retroactive SUMMARYs (commit bea2405). 02-08 onboarding wizard remains the open Phase 2 plan; install automation v0.1 drafted (docs/plan-jetson-02-install-automation-v0_1-2026-05-04.md).
stopped_at: "M2 install automation Phase 13 OAuth flow + classify $json.response/thinking parser fix (commits aca5455, 0c857e2). Recent: op-sync-from-env.py for 1Password (c50f77a), dashboard nav prefix fix (436a5b4), n8n+caddy SPA path exemption + telemetry disable (9c64e8a). Active workstream: customer-#2 install automation polish + 02-08 onboarding wizard finish."
last_updated: "2026-05-07T19:00:00.000Z"
progress:
  total_phases: 4
  completed_phases: 1
  total_plans: 11
  completed_plans: 10
  percent: 91
  count_note: "Phase 1 = 3/3 done. Phase 2 = 7 of 8 plan slots done. Slots: 02-01 SUPERSEDED (counted as resolved), 02-02 done, 02-03 done, 02-04 done (split a/b), 02-05 done (retroactive SUMMARY), 02-06 done (retroactive SUMMARY), 02-07 done (retroactive SUMMARY closing post-PLAN-promotion shipping wave), 02-08 partial (onboarding wizard scaffolded via STAQPRO-152 + KB nudge UI via STAQPRO-235; install-automation polish in flight). Phase 3 and Phase 4 plan counts are TBD until those phases plan out."
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-02)
See: CLAUDE.md (canonical project governance, last updated on Jetson 2026-04-26)
See: prd-email-agent-appliance.md (canonical PRD)

**Core value:** Inbound operational email for small CPG brands gets triaged, drafted, and (with human approval) sent — without the founder spending 1-3 hours/day on email.

**Current focus:** M3 customer-#2 polish — Jetson install automation (`docs/plan-jetson-02-install-automation-v0_1-2026-05-04.md`) + 02-08 onboarding wizard finish. Phase 2 drafting + RAG + persona substance shipped via Linear; only 02-08 remains open in the GSD ledger.

## Current Position

Phase: 02 (email-pipeline-core) — substantively complete; 02-08 onboarding wizard remains the open plan slot.
Plans complete: 02-02 v2 (schema), 02-03 (ingestion), 02-04 (classification, split a+b), 02-05 (RAG, retroactive SUMMARY 2026-05-07), 02-06 (persona, retroactive SUMMARY 2026-05-07), 02-07 (drafting + send, retroactive SUMMARY 2026-05-07 closing post-PLAN-promotion shipping wave). 02-01 SUPERSEDED (architectural pivot, counted as resolved).
Plans open: 02-08 (onboarding wizard + queue API) — partial. Wizard scaffold landed via STAQPRO-152 (quick task `260502-rk0`); KB nudge UI via STAQPRO-235; install-automation polish in flight via `docs/plan-jetson-02-install-automation-v0_1-2026-05-04.md`. Stub `02-08-PLAN-v2-2026-04-27-STUB.md` is still authoritative architectural spec; full PLAN promotion may or may not be needed depending on whether the install plan + Linear tickets are deemed sufficient closure.
Cross-plan decisions: 27 captured (D-25..D-52) — D-25..D-49 in `02-CONTEXT-ADDENDUM-v2-2026-04-27.md`, D-50 in 02-04b SUMMARY v2, D-51 (Pub/Sub revert) in addendum, D-52 (cloud vendor: Ollama Cloud `gpt-oss:120b` default) closed by STAQPRO-156 + 02-07 SUMMARY.

## Completed Work

### Phase 1: Infrastructure Foundation ✓
- 01-01: Docker Compose stack (Postgres, Ollama, Qdrant, n8n, Caddy, dashboard)
- 01-02: First-boot checkpoint script for Jetson bring-up
- 01-03: Smoke test script (6/6 passing as of 2026-04-26)
- Smoke test verified deploy at `https://mailbox.heronlabsinc.com/`

### Phase 1 Dashboard Sub-Project ✓ (parallel build, 2026-04-25)
A self-contained 8-phase build delivered the human-in-the-loop approval queue. See `dashboard/.planning/` for the complete spec, build log, and T2 validation addendum. Result: working Next.js 14 full-stack dashboard at `https://mailbox.heronlabsinc.com/dashboard/queue` with API routes for list/get/approve/reject/edit/retry.

### Phase 2 Plan 02-02 (v2): Schema Foundation ✓ (2026-04-27)
- 6 forward-only SQL migrations applied to live Jetson Postgres via new `dashboard/migrations/runner.ts`
- New tables: `mailbox.classification_log`, `sent_history`, `rejected_history`, `persona`, `onboarding` (seeded `pending_admin`)
- `mailbox.drafts` evolved to D-17 queue-record shape (denormalized email fields, classification fields, RAG refs, `awaiting_cloud` status, `approved_at`/`sent_at`)
- `dashboard/lib/types.ts` extended with Phase 2 interfaces; `lib/queries-onboarding.ts` and `lib/queries-persona.ts` created (typecheck passes)
- See: `.planning/phases/02-email-pipeline-core/02-02-schema-foundation-SUMMARY.md`



### Phase 2 Stubs ✓ (2026-04-27)
All remaining Phase 2 plans (02-03 through 02-08) re-scoped against the Next.js + n8n architecture as v2 stubs. Stubs capture changes-from-v1, cross-plan decisions, dependencies on adjacent plans, and a tasks-outline. Stubs are NOT executable — they're authoritative spec at the architectural level, deferring full task breakdown until execution time.

- 02-03 (IMAP ingestion + watchdog): 180 lines, decisions D-25..D-28
- 02-04 (classification + routing): 235 lines, decisions D-29..D-32
- 02-05 (RAG ingest + retrieval): 244 lines, decisions D-33..D-37
- 02-06 (persona extract + refresh): 278 lines, decisions D-38..D-40
- 02-07 (drafting + SMTP send): 317 lines, decisions D-41..D-45
- 02-08 (onboarding wizard): 318 lines, decisions D-46..D-49

Cross-plan decisions live in `.planning/phases/02-email-pipeline-core/02-CONTEXT-ADDENDUM-v2-2026-04-27.md` (continuation of 02-CONTEXT.md's D-NN numbering).



### Phase 2 Plan 02-03: Partial — Schema migration + Ingestion workflow updated (2026-04-28)
- Migration 007 (in_reply_to + references columns on inbox_messages) applied to live Jetson Postgres
- MailBOX n8n workflow updated:
  - Filter changed from `label:MailBOX-Test` to `in:inbox`
  - Extract Fields node extracts `inReplyTo` and `references` from Gmail node output
  - Merge Classification node passes both threading columns through
  - Store in DB node migrated from Execute Query to Insert mode (fixes comma-in-body parameter binding bug that silently affected v1)
  - On Conflict: Skip behavior preserved
- Workflow JSON exported and committed to `n8n/workflows/01-email-pipeline-main.json`
- End-to-end validated: reply email at id=909 has both `in_reply_to` and `references` populated

### Phase 2 Plan 02-04a: Partial — MAIL-05 classifier + classify sub-workflow + live-gate stub (2026-04-29)
- Dashboard `lib/classification/{prompt,normalize}.ts` with 8-category MAIL-05 taxonomy + `<think>` strip + hard fallback to `unknown` (D-05/D-06/D-07)
- Three internal API endpoints under `/dashboard/api/`:
  - `POST internal/classification-prompt` — D-29 source of truth (deviation: POST not GET because body too large for query string)
  - `POST internal/classification-normalize` — applies normalize logic
  - `GET onboarding/live-gate` — D-49 boundary stub, fails closed
- MailBOX main refactored: 5-min schedule (minutesInterval bug fixed), classification removed inline, ingest+filter-dupes-before-classify via skipOnConflict, hands new row id to sub via Execute Workflow node
- New MailBOX-Classify sub-workflow (id `MlbxClsfySub0001`, 12 nodes): Trigger → Load Row → Build Prompt → Mark Start → Ollama → Normalize → Insert classification_log → Drop spam? → Live Gate → Onboarding Live? → Insert Draft Stub (with `auto_send_blocked` for escalate per D-32; placeholder `draft_body=''`/`model='pending'` until 02-07)
- Drafting handoff intentionally NOT wired (deferred to 02-07)
- Dashboard rebuilt with `next/font/google` removed (system fonts via CSS variables in `globals.css`) — Jetson appliance builds offline; previous behavior failed on first boot due to `CERT_NOT_YET_VALID` from epoch-zero clock
- Live verification: `docker compose ps mailbox-dashboard` healthy, all three endpoints curl-verified, both workflows in workflow_entity (main active, sub inactive — Execute Workflow Trigger is not a self-starting trigger)
- See: `.planning/phases/02-email-pipeline-core/02-04a-classification-routing-SUMMARY-v1-2026-04-29.md`

### Phase 2 Plan 02-04b: Complete — D-50 + MAIL-08 gate PASS (2026-04-30)
- v1 shipped corpus + scoring infrastructure (635-row labeled corpus, route-based scoring engine, n=82 stratified sample)
- v2 closed out **D-50 (operator-identity preclass)** — `dashboard/lib/classification/preclass.ts` with `OPERATOR_DOMAINS` / `OPERATOR_ALLOWLIST` / `OPERATOR_INBOX_EXCEPTIONS` env config, post-LLM override in `normalize.ts`, `from_addr`+`to_addr` plumbed through n8n classify sub
- Sales-inbox exception (`sales@heronlabsinc.com`) added after post-D50 scoring caught a forced-internal regression on a prospect inquiry
- Temperature=0 pinned on Ollama call + scoring script for deterministic re-runs
- Final metrics (full-body, n=82, temperature=0):
  - **Route accuracy: 73.2% — MAIL-08 gate PASS**
  - Per-route F1: drop 0.58 / local 0.83 / cloud 0.68
  - internal recall 0.22 → 0.44 (D-50 lift)
  - Latency p95 3434ms (well under 5s MAIL-06 gate)
  - JSON parse 100%
- Category accuracy dropped 61% → 51.2% by design — operator-domain `follow_up`/`scheduling` rows force-relabel to `internal`, but all three categories route to local, so production routing is unaffected
- Commits: 15f2865 (D-50), bf8a2c6 (sales exception + temp=0), e745bb8 (SUMMARY v2)
- See: `.planning/phases/02-email-pipeline-core/02-04b-classification-corpus-scoring-SUMMARY-v2-2026-04-30.md`

### Known issues / parked
- 02-04a: end-to-end classify chain awaits first inbound email (no new emails since deploy; verify by checking `mailbox.classification_log` after schedule fires)
- 02-04a: legacy `MailBOX-Drafts` workflow (NIM-based) — RESOLVED 2026-04-30/05-01 via STAQPRO-156. Workflow exported to `n8n/workflows/legacy/MailBOX-Drafts-NIM.json` (commit bf288b0 on origin) and deactivated in n8n. New MailBOX-Draft chain from 02-07 is now the active drafting path.
- 02-03 carry-forward: schedule trigger 1-min bug — RESOLVED in 02-04a (`minutesInterval: 5`)
- 02-03 carry-forward: legacy taxonomy — RESOLVED in 02-04a (MAIL-05 8-cat in canonical prompt)
- 02-03 carry-forward: filter-dupes-before-classify — RESOLVED in 02-04a (`Insert (skipOnConflict) → Run Classify Sub`)
- ID jump from 26 → 909 in inbox_messages.id sequence — cosmetic only
- Pub/Sub watch-renewal (DR-22, originally tracked as STAQPRO-115) — REVERTED 2026-04-30 per post-audit reviewer consensus. Captured as **D-51** in `02-CONTEXT-ADDENDUM-v2-2026-04-27.md`. Live ingestion path is Gmail node + Schedule trigger (per 02-03 SUMMARY); no Pub/Sub watch-renewal job is required.

### Phase 2 Lean-Execution Wave ✓ (2026-05-01 → 2026-05-07)

The 02-05/06/07 v2 stubs were never promoted to full GSD PLANs. Per the 2026-05-01
HANDOFF declaration, lean-execution mode meant stubs were authoritative spec and
substance shipped through Linear with retrospective SUMMARYs. That wave closed
2026-05-07 with three retroactive SUMMARYs (commit `bea2405`):

- **02-05 RAG ingest + retrieval** — Qdrant `email_messages` collection (STAQPRO-188), inbound auto + outbound + backfill ingest (190), counterparty-scoped retrieval at draft-assembly (191), `rag_context_refs` traceability + archival snapshot via the migration 010 trigger (192), KB document upload pipeline + UI (122/148, migration 014), nomic embed bounds (199/200), eval re-runs (207, 220), self-exclusion fix (219), `RAG_DISABLED` operator gate (198), KB nudge UI (235). Live shape captured in CLAUDE.md "RAG retrieval (M3.5)" + "RAG ingestion (M3.5)".
- **02-06 persona extract + refresh** — Extraction over sent-history (STAQPRO-153), three-layer-fallback resolver per field (195), operator overrides UI (149). Live in `dashboard/lib/drafting/persona.ts:getPersonaContext`.
- **02-07 drafting + send** — D-52 cloud-vendor decision (STAQPRO-156: Ollama Cloud `gpt-oss:120b` default, Anthropic Haiku 4.5 alt-cloud config-ready). PLAN promoted 2026-04-30; post-promotion wave shipped: drop `failed` status (202, migration 016), drafts state machine narrowed to `pending → awaiting_cloud → approved/rejected/edited → sent`, Gmail Reply send path with `sent_gmail_message_id` idempotency (migration 015), Gmail cooldown system (227/228, migration 018) with read-side gate + 60-min Retry-After buffer, drafting telemetry views + /status card (233, migration 019), few-shot exemplars from sent_history (234, migration 020), Ollama tuning (206), classify-sweeper auto-recovery, customer-#2 day-1 monitoring runbooks (178/179).

10 new migrations landed in this wave (011 through 020). State machine + send-side
failure handling were deliberately simplified — Gmail Reply errors leave the row at
`approved` and surface in the StuckApproved UI for operator-driven retry.

### M2 Customer #2 Delivered ✓ (2026-05-05)

`mailbox.staqs.io` (LAN `192.168.50.11`, tailnet `mailbox2.tail377a9a.ts.net`).
Caddy public surface gated by basic_auth (STAQPRO-131); Ollama/Qdrant ports
internal-only (STAQPRO-130 — already shipped 2026-05-01). Hardware deltas vs
mailbox1 captured in CLAUDE.md "Hardware deltas". Two post-install follow-ups
flagged in memory for the next install (`memory/project_post_install_followups.md`):
front-matter `git pull` step in install plans, stale nested `mailbox/` cleanup,
STAQPRO-228 scope drift to flag.

n8n upgrade `1.123.35 → 2.14.2` (STAQPRO-181) shipped 2026-05-01 — supersedes
DR-17. n8n Postgres credential `JFX4tvrffvKnTouV` is hardcoded into
MailBOX-Classify; fresh-install gotcha captured in memory
(`memory/project_n8n_postgres_credential_gotcha.md`).

### Quick Tasks Completed

| # | Description | Date | Commit | Directory |
|---|-------------|------|--------|-----------|
| 260502-rk0 | Scaffold onboarding wizard GUI (STAQPRO-152) + customer onboarding docs templates (STAQPRO-132) | 2026-05-03 | c1d66f9 | [260502-rk0-scaffold-onboarding-wizard-gui-staqpro-1](./quick/260502-rk0-scaffold-onboarding-wizard-gui-staqpro-1/) |
| 260510-7sp | Add conversation history view to dashboard draft detail | 2026-05-10 | a4bc170 | [260510-7sp-add-conversation-history-view-to-dashboa](./quick/260510-7sp-add-conversation-history-view-to-dashboa/) |

## Architectural Decision Record: Dashboard Stack Pivot

**Date:** 2026-04-27
**Decision:** Adopt Next.js 14 full-stack as the dashboard architecture. Reject the Express backend + separate React/Vite UI design originally scoped in 02-01.

**Context:** Two parallel implementations existed at 2026-04-27 reconciliation:
- Ubuntu workstation (`.planning/`) had drafted 02-01 as an Express backend with Drizzle ORM, Anthropic SDK, and Qdrant client (Node 22 ESM). Never deployed.
- Jetson appliance had a working Next.js 14 dashboard with `app/api/` routes, pg driver, Node 20 alpine multi-stage build. Live and serving traffic.

**Decision rationale:**
- The Next.js dashboard is already deployed, healthy, and passing smoke tests
- Single-service architecture reduces appliance footprint (one container instead of two)
- API routes inside the same Next.js app eliminate the dashboard ↔ backend network hop
- Phase 2 dependencies (Anthropic SDK, Qdrant client, Drizzle ORM) work fine inside Next.js API routes

**Consequence for Phase 2:**
- 02-01 (dashboard-backend-bootstrap): SUPERSEDED with frontmatter marker on 2026-04-27.
- 02-02 (schema foundation): RE-SCOPED as v2 plan and EXECUTED on 2026-04-27 (6 SQL migrations applied to live Postgres + types/queries shipped).
- 02-03..08: RE-SCOPED as v2 stubs on 2026-04-27. Stubs are authoritative for architectural decisions; ready for either stub-promotion-to-full-plan or lean-execution.

**STATUS: Partially superseded 2026-05-01.** The "raw pg + ORM-deferred (Drizzle as MVP target)" half is replaced by the Dashboard ORM ADR below. The Next.js single-service architecture half stands.

## Architectural Decision Record: Dashboard ORM — Kysely

**Date:** 2026-05-01
**Decision:** Adopt Kysely (TypeScript SQL query builder) as the dashboard's typed query surface. Supersedes the "Drizzle as MVP target" half of the 2026-04-27 Dashboard Stack Pivot ADR. Rejects both Drizzle and Prisma.

**Context:**
- 2026-04-27 ADR named Drizzle as the eventual ORM but kept raw `pg` for MVP. Drizzle was never adopted; production code is `pg.Pool` + hand-rolled SQL in `dashboard/lib/queries*.ts` + plain `.sql` migrations under `dashboard/migrations/NNN-*.sql`.
- 2026-04-30 Isa code audit recommended Prisma. STAQPRO-136 was reopened 2026-05-01 with a substance reassessment that initially leaned Prisma (portfolio consistency with formul8-platform).
- 2026-05-01 pre-flight review by Liotta + Linus (Neo skill unreachable in this session) flipped the decision. Both reviewers — independently — argued against Prisma on this appliance.

**Decision rationale:**
- **Migration tooling fight (Linus blocker)**: Prisma's `migrate resolve --applied` over the existing 8 hand-authored `.sql` migrations creates a hybrid state that breaks the moment anyone runs `migrate dev` (checksum mismatch on Prisma-not-authored files). Kysely doesn't own migrations; the custom tsx runner stays.
- **Type cascade (Linus blocker)**: `dashboard/lib/db.ts` overrides pg type parsers 1184/1114 to return TIMESTAMPTZ/TIMESTAMP as strings. Prisma's generated client emits `Date`. That contradicts 14 zod schemas already shipped under STAQPRO-138. Kysely codegen (with `--type-mapping '{"timestamp":"string","timestamptz":"string","date":"string"}'`) preserves the string convention; existing zod schemas continue to compose correctly.
- **Schema introspection scope (Linus blocker)**: The same Postgres also hosts n8n's `workflow_entity` / `execution_entity` / `execution_data` (in the `public` schema). Kysely's `--include-pattern 'mailbox.*'` is one flag; Prisma requires `previewFeatures = ["multiSchema"]` plus `schemas = ["mailbox"]` plus careful `--schema` flagging on every operation forever.
- **Hardware footprint (Liotta argument)**: Prisma ships a separate Rust query-engine binary process per Node process (~80-150MB resident on ARM64 Jetson). Kysely is pure TypeScript, ~50KB, ships in the bundle, no separate process. Memory measurement on Bob 2026-05-01 showed mailbox-dashboard at 51MB idle and ~3GB headroom on 7.4GB unified RAM — Prisma was not catastrophic — but the binary OTA cadence at customer #5+ (engine binaries ship monthly, ~30-50MB each) compounds.
- **Drift discovery (validating the schema-in-3-places concern)**: Kysely codegen surfaced that `dashboard/lib/types.ts` Draft interface declared 11 columns; the live `mailbox.drafts` table has 28. STAQPRO-137 only consolidated enums; 17 columns of view drift went undetected. Continuing on raw pg without typed introspection would have left this drift indefinitely.
- **Portfolio consistency (rejected as a decision driver)**: Initial reasoning leaned Prisma because formul8-platform runs Prisma. Eric's read 2026-05-01: portfolio consistency does not outweigh hardware-fit on a constrained appliance. Different problems, different tools.

**Consequence:**
- `dashboard/lib/db.ts` exposes `getKysely()` returning `Kysely<DB>` alongside `getPool()`. Both share the same `pg.Pool`.
- `dashboard/lib/db/schema.ts` is the kysely-codegen output — full DB row shapes for the `mailbox` schema. Re-exported as `DraftRow`, `InboxMessageRow`, etc. from `lib/types.ts`.
- `dashboard/lib/types.ts` retains the *semantic* SoT (DRAFT_STATUSES/DRAFT_SOURCES const tuples, ClassificationCategory/OnboardingStage unions) and *curated views* (Draft, InboxMessage, etc — narrower than full row, the dashboard's consumer surface).
- Migrations stay as plain `.sql` files run by `dashboard/migrations/runner.ts` (custom tsx). No drizzle-kit, no prisma-migrate.
- `npm run db:codegen` regenerates `lib/db/schema.ts` from `dashboard/test/fixtures/schema.sql` via a throwaway postgres:17-alpine container. `npm run db:codegen:verify` is wired for CI drift checks.
- `getPool()` stays for the migration runner, the `sql.raw` escape hatch, and test setup/teardown helpers.
- The 2026-04-27 ADR's Drizzle reference is retired. The Next.js single-service architecture from that ADR stands.

**STAQPRO-136**: closed by this ADR + the 8 implementation commits referenced in the issue.

## Next Action

**Single track now: M3 customer-#2 polish.** The M2 dual-track structure
(02-07 finish + parallel security track) is closed. M2 shipped on 2026-05-05;
the security track delivered (STAQPRO-130 ports, 131 basic_auth — both live in
Caddy on both appliances). Phase 2's drafting/RAG/persona substance shipped via
Linear with retroactive SUMMARYs (2026-05-07).

### Open Phase 2 work — 02-08 onboarding wizard

The onboarding wizard remains the open Phase 2 plan. State:

- **Wizard scaffold**: STAQPRO-152 — quick task `260502-rk0` landed the GUI scaffold.
- **KB nudge**: STAQPRO-235 — post-onboarding nudge at `/settings/kb`, live.
- **Install automation**: `docs/plan-jetson-02-install-automation-v0_1-2026-05-04.md` v0.1 drafted, executable, used to deploy mailbox2 on 2026-05-05. Three follow-ups captured in memory for v0.2.
- **Live-gate boundary**: `/api/onboarding/live-gate` stub from 02-04a — fails closed; needs proper wiring to onboarding state.
- **First-send acceptance gate**: documented in `docs/runbook/customer-2-success-criteria.v0.1.0.md`.

Decision still open: do we promote `02-08-PLAN-v2-2026-04-27-STUB.md` to a full PLAN, or is the install-automation plan + Linear ticket trail sufficient closure for this slot? Lean-execution precedent says the latter is fine; formal-closure precedent (the way 02-07 was promoted) says the former. Defer until the wizard work resumes.

### Resume sequence

1. Continue M3 install automation: post-install follow-ups for v0.2 (`memory/project_post_install_followups.md` — front-matter `git pull`, stale nested `mailbox/` cleanup, STAQPRO-228 scope drift).
2. Finish wizard wiring against the live-gate boundary; ship through the customer-#2 success-criteria runbook.
3. When 02-08 closes, decide Phase 2 → Phase 3 transition (graduated auto-send, classification correction, OTA updates, email notifications — see ROADMAP.md).

Resume file: `docs/plan-jetson-02-install-automation-v0_1-2026-05-04.md` (live install plan) plus `.planning/phases/02-email-pipeline-core/02-08-onboarding-wizard-and-queue-api-PLAN-v2-2026-04-27-STUB.md` (architectural intent).

## Session Continuity

Last session: 2026-05-07T19:00:00Z (this reconciliation pass)
Stopped at: GSD ↔ Linear reconciliation complete — STATE.md + ROADMAP.md aligned with shipped work; retroactive SUMMARYs written for 02-05 / 02-06 / 02-07. Active workstream is M3 install automation polish + 02-08 onboarding wizard finish. Working tree clean.
Last commits: 7dfd1b4 (install plan v0.1 + bootstrap-ssh), 89c660b (jetson → mailbox1 SSH alias rename), 942f06d (gitignore /mailbox/ USB payload), bea2405 (retroactive SUMMARYs for 02-05/06/07).
Prior session ground-truth commits: c50f77a (op-sync-from-env.py for 1Password), 436a5b4 (dashboard nav prefix fix), aca5455 (install session 2 log — Phase 13 OAuth), 0c857e2 (classify $json.response/thinking parser fix).
Resume file: `docs/plan-jetson-02-install-automation-v0_1-2026-05-04.md` for install automation; `02-08-onboarding-wizard-and-queue-api-PLAN-v2-2026-04-27-STUB.md` for wizard architectural intent.
