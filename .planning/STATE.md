---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: Phase 1 complete; Phase 2 plan 02-02 (v2) complete; 02-03..08 still need re-scope
stopped_at: 02-02-v2 fully complete (tasks 1-9 + verification). SUMMARY.md written. 02-01 SUPERSEDED, 02-03..08 still need re-scope against Next.js + n8n architecture before execution.
last_updated: "2026-04-27T17:30:00.000Z"
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

**Current focus:** Phase 02 — email-pipeline-core (02-02 v2 complete; 02-03..08 still need re-scope)

## Current Position

Phase: 02 (email-pipeline-core) — partial; 02-02 (v2) complete, 02-03..08 BLOCKED ON RE-SCOPE
Plan: 1 of 8 substantive plans complete (02-02 v2). 02-01 marked SUPERSEDED.

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

02-02 is done. Remaining Phase 2 plans still need re-scoping against the Next.js + n8n architecture before any execution. Suggested order:
1. Mark 02-01 frontmatter as SUPERSEDED; do not execute
2. Re-scope 02-08 to onboarding-wizard-only (queue API already exists)
3. Re-scope 02-03 (imap-ingestion-watchdog) for n8n-driven IMAP polling instead of Express scheduler
4. Re-scope 02-04..07 (classification, RAG, persona, draft generation) for n8n workflows + Next.js API routes
5. Then execute remaining plans

Resume file: re-scope work begins with 02-01 frontmatter update + 02-08 re-scope.

## Session Continuity

Last session: 2026-04-27T17:30:00.000Z
Stopped at: 02-02-v2 fully complete (tasks 1-9, SUMMARY.md written, STATE updated). Next step is re-scoping 02-01, 02-03..08 against Next.js + n8n.
Resume file: .planning/phases/02-email-pipeline-core/02-02-schema-foundation-SUMMARY.md (latest completed reference)
