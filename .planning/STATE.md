---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: Phase 1 complete; Phase 2 awaiting re-scope
stopped_at: Phase 2 plans require re-scope to Next.js architecture
last_updated: "2026-04-27T07:30:00.000Z"
progress:
  total_phases: 4
  completed_phases: 1
  total_plans: 11
  completed_plans: 3
  percent: 27
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-02)
See: CLAUDE.md (canonical project governance, last updated on Jetson 2026-04-26)
See: prd-email-agent-appliance.md (canonical PRD)

**Core value:** Inbound operational email for small CPG brands gets triaged, drafted, and (with human approval) sent — without the founder spending 1-3 hours/day on email.

**Current focus:** Phase 02 — email-pipeline-core (re-scoping required before execution)

## Current Position

Phase: 02 (email-pipeline-core) — BLOCKED ON RE-SCOPE
Plan: 0 of 8 (all plans require revision)

## Completed Work

### Phase 1: Infrastructure Foundation ✓
- 01-01: Docker Compose stack (Postgres, Ollama, Qdrant, n8n, Caddy, dashboard)
- 01-02: First-boot checkpoint script for Jetson bring-up
- 01-03: Smoke test script (6/6 passing as of 2026-04-26)
- Smoke test verified deploy at `https://mailbox.heronlabsinc.com/`

### Phase 1 Dashboard Sub-Project ✓ (parallel build, 2026-04-25)
A self-contained 8-phase build delivered the human-in-the-loop approval queue. See `dashboard/.planning/` for the complete spec, build log, and T2 validation addendum. Result: working Next.js 14 full-stack dashboard at `https://mailbox.heronlabsinc.com/dashboard/queue` with API routes for list/get/approve/reject/edit/retry.

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
- 02-01 (dashboard-backend-bootstrap): SUPERSEDED. Next.js dashboard already provides the API surface.
- 02-08 (onboarding-wizard-and-queue-api): PARTIALLY DONE. Queue API already shipped; only onboarding wizard remains.
- 02-02 through 02-07: Content valid (schema, IMAP, classification, RAG, persona, draft generation) but plan files reference Express patterns that need rewriting for Next.js / n8n workflows.

## Next Action

Re-scope Phase 2 plans against the Next.js + n8n architecture before any execution. Suggested order:
1. Mark 02-01 as SUPERSEDED in its frontmatter; do not execute
2. Re-scope 02-08 to onboarding-wizard-only (queue API already exists)
3. Re-scope 02-02 (schema-foundation) to align with the live mailbox.inbox_messages and mailbox.drafts schemas already running
4. Then 02-03 onward in order

Resume file: .planning/phases/02-email-pipeline-core/02-08-onboarding-wizard-and-queue-api-PLAN.md (next priority per roadmap conversation 2026-04-27)

## Session Continuity

Last session: 2026-04-27T07:30:00.000Z
Stopped at: Three-way reconciliation complete. Jetson is canonical. Phase 2 ready to begin once 02-08 is re-scoped.
Resume file: .planning/phases/02-email-pipeline-core/02-08-onboarding-wizard-and-queue-api-PLAN.md
