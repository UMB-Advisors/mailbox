---
phase: 05-backend-data-model-auto-create
plan: 01
subsystem: database
tags: [postgres, kysely, kysely-codegen, migrations, vitest]

# Dependency graph
requires: []
provides:
  - "mailbox.accounts.business_id (nullable FK, ON DELETE SET NULL) — MAP-01 storage"
  - "mailbox.businesses.slug (NOT NULL, UNIQUE, frozen-at-creation) — FILT-05 storage"
  - "dashboard/lib/db/schema.ts regenerated with business_id + slug + job_outcomes (drift fix)"
  - "schema-invariant test coverage proving FK ON DELETE SET NULL + slug constraints"
affects: [05-02, 05-03, 05-04]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Migration DDL mirrored into test/fixtures/schema.sql as a trailing ALTER TABLE block when the FK target table is defined later in the file (bootstrap-order-safe append, not inline CREATE TABLE edit)"
    - "PL/pgSQL DO $$ loop for collision-suffixing a slug column at migration-apply time — no Node/tsx dependency mid-transaction"

key-files:
  created:
    - dashboard/migrations/057-add-accounts-business-id-and-business-slug-v1-2026-07-28.sql
  modified:
    - dashboard/test/fixtures/schema.sql
    - dashboard/lib/db/schema.ts
    - dashboard/test/schema-invariants.test.ts
    - dashboard/test/lib/job-outcomes.test.ts

key-decisions:
  - "Docker was available — took the real npm run db:codegen path, not the hand-stub fallback (plan's autonomous:false condition resolved)"
  - "Codegen regeneration incidentally fixed pre-existing schema.ts drift (job_outcomes table entirely missing) since CI never runs db:codegen:verify"

patterns-established:
  - "New FK/column mirrored into test/fixtures/schema.sql goes in a trailing ALTER TABLE block appended after both referenced CREATE TABLEs, matching migration 053's own departments.business_id precedent"

requirements-completed: [MAP-01, FILT-05]

coverage:
  - id: D1
    description: "mailbox.accounts.business_id nullable FK to mailbox.businesses(id) ON DELETE SET NULL, never cascades"
    requirement: MAP-01
    verification:
      - kind: unit
        ref: "dashboard/test/schema-invariants.test.ts#deleting a business sets its linked accounts.business_id to NULL, never cascades (MAP-01)"
        status: pass
      - kind: unit
        ref: "dashboard/test/schema-invariants.test.ts#accounts.business_id is nullable with no column default (MAP-04 — unmatched accounts stay unlinked)"
        status: pass
    human_judgment: false
  - id: D2
    description: "mailbox.businesses.slug NOT NULL + globally UNIQUE, computed backfill with collision suffixing, Altitude Guitar seeded to 'altitude'"
    requirement: FILT-05
    verification:
      - kind: unit
        ref: "dashboard/test/schema-invariants.test.ts#businesses.slug is NOT NULL (D-13)"
        status: pass
      - kind: unit
        ref: "dashboard/test/schema-invariants.test.ts#businesses_slug_key is a UNIQUE index on businesses(slug) (D-13)"
        status: pass
      - kind: unit
        ref: "dashboard/test/schema-invariants.test.ts#inserting two businesses with the same slug is rejected (unique violation)"
        status: pass
      - kind: other
        ref: "manual probe against throwaway postgres:17-alpine: Altitude Guitar=altitude, UMB Advisors=umb-advisors, Dup!! Name=dup-name, Dup Name=dup-name-2"
        status: pass
    human_judgment: false
  - id: D3
    description: "test/fixtures/schema.sql and lib/db/schema.ts agree with migration 057; db:codegen:verify clean"
    verification:
      - kind: other
        ref: "npm run db:codegen:verify"
        status: pass
      - kind: other
        ref: "npm run typecheck"
        status: pass
    human_judgment: false
  - id: D4
    description: "No existing business INSERT left slug-less except lib/crm/queries.ts (owned by plan 05-02)"
    verification:
      - kind: other
        ref: "grep -rn 'INTO mailbox.businesses' dashboard --include=*.ts --include=*.tsx | grep -v node_modules | grep -v slug | grep -v lib/crm/queries.ts | wc -l -> 0"
        status: pass
    human_judgment: false

duration: 55min
completed: 2026-07-28
status: complete
---

# Phase 5 Plan 1: Backend Data Model — Migration 057 Summary

**Migration 057 adds `accounts.business_id` (nullable FK, ON DELETE SET NULL) and `businesses.slug` (NOT NULL UNIQUE, computed backfill + `-2`/`-3` collision suffixing + single `altitude` legacy seed), mirrored into the fixture, regenerated through kysely-codegen with Docker, and proven by new schema-invariant tests.**

## Performance

- **Duration:** ~55 min
- **Tasks:** 3 completed
- **Files modified:** 5 (1 created, 4 modified)

## Accomplishments

- `dashboard/migrations/057-add-accounts-business-id-and-business-slug-v1-2026-07-28.sql` — idempotent, applies twice with no error; verified against a throwaway `postgres:17-alpine` container bootstrapped from the current fixture.
- `mailbox.accounts.business_id` is nullable, no DEFAULT, `REFERENCES mailbox.businesses(id) ON DELETE SET NULL` — mirrors migration 053's `departments.business_id` shape exactly.
- `mailbox.businesses.slug` is NOT NULL, uniquely indexed (`businesses_slug_key`), backfilled via a deterministic lowercase-kebab transform with a PL/pgSQL collision-suffix loop, and seeded `slug='altitude'` on exactly the `Altitude Guitar` row (guarded, idempotent, ordered before the unique index so a defeated guard fails loudly instead of shipping a duplicate).
- `test/fixtures/schema.sql` carries the identical DDL as a trailing block after both `mailbox.accounts` (:1228) and `mailbox.businesses` (:1599) CREATE TABLEs — required because `accounts` textually precedes its own FK target in this file.
- `lib/db/schema.ts` regenerated via the real `npm run db:codegen` (Docker path, not the hand-stub fallback — see "Docker path taken" below). `db:codegen:verify` and `typecheck` both pass clean.
- New schema-invariant coverage in `test/schema-invariants.test.ts`: FK `ON DELETE SET NULL` behavioral proof (delete business → re-read account → `business_id IS NULL`), `information_schema` checks for nullability/default, unique-index presence, and unique-violation rejection on a duplicate slug insert.
- `test/lib/job-outcomes.test.ts`'s two raw business INSERTs repaired with unique stamped slugs (the only other slug-less writer besides `lib/crm/queries.ts`, which plan 05-02 owns).

## Docker path taken

**Real `npm run db:codegen` ran successfully** (Docker server 29.5.2, confirmed available per orchestrator note). The hand-stub fallback in Task 2's `<action>` was **not** invoked. `db:codegen:verify` reports "Generated types are up-to-date!" and `npm run typecheck` passes.

## Task Commits

Each task was committed atomically:

1. **Task 1: Write migration 057** — `c23692d` (feat) — migration file only; verified idempotent + collision-safe against a throwaway container before committing.
2. **Task 2: Schema sync — fixture mirror + codegen + drift check** — `e2aa958` (feat) — fixture tail block, regenerated `lib/db/schema.ts`, `db:codegen:verify` + `typecheck` clean.
3. **Task 3 (TDD):**
   - RED — `eb4b9a5` (test) — 5 new schema-invariant cases added, confirmed failing against the **pre-057** fixture snapshot (checked out from `git show c23692d~1` era, i.e. before this plan's migration existed) before any implementation existed for them at the test-file level.
   - GREEN — `711aaf4` (feat) — repaired `job-outcomes.test.ts`'s two slug-less INSERTs; all 5 new cases + the full suite pass against the post-057 fixture, confirmed twice in a row (idempotence) and with `TEST_POSTGRES_URL` set (1290/1290 pass, DB cases actually execute rather than skip).

**Plan metadata:** (this commit, forthcoming) `docs(05-01): complete plan`

## Files Created/Modified

- `dashboard/migrations/057-add-accounts-business-id-and-business-slug-v1-2026-07-28.sql` — the migration
- `dashboard/test/fixtures/schema.sql` — trailing DDL mirror block (no DML — fixture bootstraps an empty DB, so `slug TEXT NOT NULL` needs no backfill dance)
- `dashboard/lib/db/schema.ts` — regenerated; `business_id` on `Accounts`, `slug` on `Businesses`, plus incidental `job_outcomes` drift fix
- `dashboard/test/schema-invariants.test.ts` — 5 new `it.skipIf(!DB_URL)` cases
- `dashboard/test/lib/job-outcomes.test.ts` — two business INSERTs gained stamped slug values

## Decisions Made

- Docker's real availability (confirmed by the orchestrator) meant the plan's `autonomous: false` uncertainty resolved cleanly — no hand-stub fallback needed, no follow-up item to re-run codegen before plan 05-04.
- Kept the codegen-incidental `job_outcomes` drift fix in the same commit as the fixture mirror, rather than splitting it out — it's a direct, mechanical byproduct of running `npm run db:codegen` correctly (Rule 1: fixing broken/stale generated output), not a new scope item.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed pre-existing `lib/db/schema.ts` drift unrelated to this migration**
- **Found during:** Task 2 (codegen regeneration)
- **Issue:** `lib/db/schema.ts` was missing the entire `JobOutcomes` interface and the `job_outcomes` DB member (migration 054's table), plus carried two stale "hand-maintained mirror" comments on `ClassificationExemplars`/`SenderRules` that were no longer true once regeneration ran clean. CI does not run `db:codegen:verify`, so this drift was silent until this plan's Task 2 forced a real regeneration.
- **Fix:** Accepted the full regenerated output from `npm run db:codegen` (single source of truth = `test/fixtures/schema.sql`).
- **Files modified:** `dashboard/lib/db/schema.ts`
- **Verification:** `npm run db:codegen:verify` reports no drift; `npm run typecheck` passes.
- **Committed in:** `e2aa958` (Task 2 commit)

**2. [Rule 3 - Blocking] Biome format fix on the new duplicate-slug test case**
- **Found during:** Task 3 GREEN verification (`npm run lint`)
- **Issue:** My new `it()` case in `schema-invariants.test.ts` had a multi-line `pool!.query(...)` call argument array that Biome's formatter collapses to one line.
- **Fix:** Ran `npx biome check --write` scoped to the two files this plan touches; no logic change, format-only.
- **Files modified:** `dashboard/test/schema-invariants.test.ts`
- **Verification:** `npm run lint` exits 0 with no errors (only pre-existing unrelated warnings in `test/lib/queries-git.test.ts` / `test/routes/digest.test.ts`, out of scope, not touched).
- **Committed in:** `711aaf4` (Task 3 GREEN commit)

---

**Total deviations:** 2 auto-fixed (1 bug/drift fix, 1 blocking/lint)
**Impact on plan:** Both fixes necessary for a clean `npm run lint && npm run typecheck && npm test` per the plan's own success criteria. No scope creep — `lib/crm/queries.ts` was explicitly left untouched per the plan's hard boundary (plan 05-02 owns it).

## Issues Encountered

- No local `psql` client on this machine — all schema-application and probe queries against throwaway containers were run via `docker exec <container> psql ...` / `docker cp` instead of a host-side `psql` binary. No impact on results.
- This repo is a normal (non-worktree) git checkout on `master` — the worktree-specific safety steps in the executor protocol (cwd-drift assertion, HEAD branch namespace check) did not apply; confirmed via `git rev-parse --abbrev-ref HEAD` = `master` and `.git` is a directory, not a file.

## User Setup Required

None — no external service configuration required. This plan is DB-schema and test-coverage only; no live/remote database was touched (explicitly out of scope per the orchestrator's Wave 1 gate — the `agentbox3` deploy is plan 05-04).

## Next Phase Readiness

- `mailbox.accounts.business_id` and `mailbox.businesses.slug` now exist in the migration, the fixture, and the generated Kysely types — plan 05-02's `linkAccountToBusiness` / `findOrCreateBusiness` writes will type-check against real columns, not a stale schema.
- Plan 05-02 still owns `lib/crm/queries.ts:createBusiness` — it must supply a slug on every business INSERT it makes (the NOT NULL constraint is now live in the fixture/CI schema).
- Plan 05-03 (backfill script) can rely on `businesses.slug` already being NOT NULL/UNIQUE and `accounts.business_id` already existing as a nullable FK — no schema work remains for it to do.
- Plan 05-04 (live `agentbox3` deploy) still needs migration 057 applied to the real appliance Postgres — not done here, per the explicit Wave 1 gate. No follow-up codegen re-run is needed before that deploy (the real Docker path was already taken in this plan, not the hand-stub fallback).

---
*Phase: 05-backend-data-model-auto-create*
*Completed: 2026-07-28*

## Self-Check: PASSED

All 6 created/modified files confirmed present on disk. All 4 task commit hashes
(`c23692d`, `e2aa958`, `eb4b9a5`, `711aaf4`) confirmed present in `git log --oneline --all`.
