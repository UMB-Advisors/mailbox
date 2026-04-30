---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: Phase 2 in lean execution; 02-04a complete (MAIL-05 classifier deployed and verified end-to-end; corpus + scoring deferred to 02-04b)
stopped_at: 02-04a verified live on Jetson — classifier prompt + normalize + 3 internal API endpoints + MailBOX-Classify sub-workflow + main refactored to filter dupes / 5-min schedule. Dashboard rebuilt with system-font patch. End-to-end fire 2026-04-30 06:35 UTC: real Heron Labs invoice email classified `reorder` @ 0.9 confidence, 1757ms latency, json_parse_ok=t. Live-gate correctly blocked drafts row at stage=pending_admin. 02-04b (corpus + scoring) and 02-07 (drafting handoff) are next.
last_updated: "2026-04-29T23:30:00.000Z"
progress:
  total_phases: 4
  completed_phases: 1
  total_plans: 11
  completed_plans: 4
  percent: 36
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-02)
See: CLAUDE.md (canonical project governance, last updated on Jetson 2026-04-26)
See: prd-email-agent-appliance.md (canonical PRD)

**Core value:** Inbound operational email for small CPG brands gets triaged, drafted, and (with human approval) sent — without the founder spending 1-3 hours/day on email.

**Current focus:** Phase 02 — email-pipeline-core (02-02 v2 complete; 02-03..08 fully stubbed; 02-01 SUPERSEDED; ready to execute)

## Current Position

Phase: 02 (email-pipeline-core) — partial; 02-02 (v2) complete, 02-03..08 FULLY STUBBED
Plan: 1 of 7 substantive plans complete (02-02 v2). 02-01 marked SUPERSEDED.
Stubs: 02-03..08 captured as `*-PLAN-v2-2026-04-27-STUB.md` files alongside their v1 originals.
Cross-plan decisions: 25 captured (D-25..D-49) in `02-CONTEXT-ADDENDUM-v2-2026-04-27.md`.

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

### Known issues / parked
- 02-04a: end-to-end classify chain awaits first inbound email (no new emails since deploy; verify by checking `mailbox.classification_log` after schedule fires)
- 02-04a: existing legacy `MailBOX-Drafts` workflow (NIM-based) still active — may double-draft once 02-07 lands; needs deactivation guard
- 02-03 carry-forward: schedule trigger 1-min bug — RESOLVED in 02-04a (`minutesInterval: 5`)
- 02-03 carry-forward: legacy taxonomy — RESOLVED in 02-04a (MAIL-05 8-cat in canonical prompt)
- 02-03 carry-forward: filter-dupes-before-classify — RESOLVED in 02-04a (`Insert (skipOnConflict) → Run Classify Sub`)
- ID jump from 26 → 909 in inbox_messages.id sequence — cosmetic only

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

## Next Action

Phase 2 architectural surface is fully captured. Choice for next session: STUB PROMOTION vs LEAN EXECUTION.

**Path A: Stub promotion** — promote each stub to a full v2 plan with task list and verification before executing. Mirrors the 02-02-v2 process exactly. ~6 plans × ~1000 lines each = ~6000 lines of plan writing before any code lands. Authoritative spec for each plan; safer for a future session to resume against.

**Path B: Lean execution** — treat stubs as authoritative spec, write code directly against them, formalize each as a SUMMARY.md after the work lands. Mirrors the dashboard sub-project's build pattern from 2026-04-25. Faster to ship; relies on stub fidelity.

Recommendation: **Path B**. The stubs are detailed enough — each captures changes-from-v1, dependencies, cross-plan decisions, and a task outline. We've already proven executable-from-stub works (02-02-v2 ran to completion from a single plan file generated this session). The decision-resolution exercise was the hard part; the implementation is mechanical from here.

Suggested execution order (pipeline order, since each plan depends on upstream output):
1. 02-03 (IMAP ingestion + watchdog) — produces inbox_messages rows for everything else to consume
2. 02-04 (classification + routing) — gates whether drafts get created
3. 02-05 (RAG ingest + retrieval) — provides context for drafting
4. 02-06 (persona extract + refresh) — provides voice profile for drafting
5. 02-07 (drafting + SMTP send) — pulls 02-04..06 together, plus the send path
6. 02-08 (onboarding wizard) — wraps the operator UX around all of it

Resume file: `.planning/phases/02-email-pipeline-core/02-04-classification-routing-PLAN-v2-2026-04-27-STUB.md` (next pipeline-order plan; carries deferred 02-03 cleanup items: 5-min schedule, MAIL-05 taxonomy, filter-dupes-before-classify).

## Session Continuity

Last session: 2026-04-27T22:08:30.000Z
Stopped at: 02-03 partial — schema migration 007 applied; MailBOX workflow extended with thread-header capture; reply email validated. Known issues parked for 02-04. Last commit at session pause: workflow JSON committed.
Resume file: .planning/phases/02-email-pipeline-core/02-04-classification-routing-PLAN-v2-2026-04-27-STUB.md (next pipeline-order plan; carries the deferred 02-03 cleanup items)
