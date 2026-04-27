---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: Phase 2 fully stubbed (02-02-v2 done, 02-03..08 stubs); 02-01 SUPERSEDED; ready to promote stubs or execute lean
stopped_at: All Phase 2 stubs landed. 25 cross-plan decisions captured (D-25..D-49). Next: decide stub-promotion path vs lean-execution path, then build.
last_updated: "2026-04-27T22:08:30.000Z"
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

Resume file: `.planning/phases/02-email-pipeline-core/02-03-imap-ingestion-watchdog-PLAN-v2-2026-04-27-STUB.md` (next plan in pipeline order).

## Session Continuity

Last session: 2026-04-27T22:08:30.000Z
Stopped at: All Phase 2 stubs landed (02-03..08, 6 stubs totaling ~1572 lines). 25 cross-plan decisions captured (D-25..D-49). Next session decides Path A (stub promotion) vs Path B (lean execution); recommendation is Path B starting with 02-03.
Resume file: .planning/phases/02-email-pipeline-core/02-03-imap-ingestion-watchdog-PLAN-v2-2026-04-27-STUB.md
