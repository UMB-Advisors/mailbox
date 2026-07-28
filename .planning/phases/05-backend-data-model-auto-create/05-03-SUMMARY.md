---
phase: 05-backend-data-model-auto-create
plan: 03
subsystem: crm
tags: [postgres, kysely, auto-link, backfill, vitest]

# Dependency graph
requires:
  - phase: 05-01
    provides: "mailbox.accounts.business_id (nullable FK) + mailbox.businesses.slug (NOT NULL UNIQUE)"
  - phase: 05-02
    provides: "lib/crm/auto-link.ts — linkAccountToBusiness / findOrCreateBusiness (D-16 fixed resolution order)"
provides:
  - "persistAccountLink() — module-internal seam in lib/queries-accounts.ts, exactly one call site per creator (createAccount, createImapAccount, createMicrosoftAccount), positioned after the insert-or-adopt branch resolves"
  - "dashboard/scripts/business-link-backfill.ts — idempotent, dry-run-capable, exit-code-gated one-shot account→business linker behind npm run business:backfill"
  - "real-Postgres test coverage proving both the insert branch and the sentinel-adopt branch link a business, plus the ENT-05 non-fatal guarantee"
affects: ["05-04"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "vi.mock with importOriginal wrapping a single named export as vi.fn(actual.impl) — lets one test file exercise the real DB-backed implementation for every case except a single mockRejectedValueOnce override, with zero manual reset needed"
    - "Backfill scripts share the app's lib/db.ts getPool() singleton (not a bespoke `new Pool()`) when the script also calls into lib/*.ts modules that use the same pool internally"

key-files:
  created:
    - dashboard/scripts/business-link-backfill.ts
  modified:
    - dashboard/lib/queries-accounts.ts
    - dashboard/test/lib/queries-accounts.test.ts
    - dashboard/package.json

key-decisions:
  - "Test ordering inside the new dbDescribe block is load-bearing, not incidental: beforeAll moves the fixture-seeded default account off the migration-033 sentinel address up front (a fresh DB always seeds it there), so every insert-branch case is order-independent; only the dedicated ADOPT case re-arms the sentinel for its own single call. A prior draft that restored the row to its true original value in afterEach (matching the plan's literal wording) re-armed the sentinel mid-block and silently flipped a later insert-branch case into an adopt — fixed by moving full-row restoration to a single afterAll instead."
  - "Defensively guarded against ever queuing the shared default account for deletion: createdAccountIds.add(id) is skipped whenever id === originalDefaultId. A first draft without this guard deleted the entire default account row when a test assertion failed mid-run and the returned id happened to equal the default's (root-caused via direct DB inspection after a corrupted-container run), which is exactly the kind of afterAll-cleanup bug this guard closes for good regardless of future test-order changes."
  - "Backfill script uses lib/db.ts's shared getPool() (matching queries-accounts.ts/auto-link.ts) rather than instantiating its own `new Pool()` the way scripts/rag-backfill.ts does — the script's own SELECT/count queries and linkAccountToBusiness's internal queries then share one connection pool with consistent settings."
  - "The pre-existing CRUD test block (queries-accounts.test.ts, not authored by this plan) now has a real side effect it never had before: createAccount auto-links a business. Its afterAll was extended to look up and delete each created account's business_id before deleting the account (FK is ON DELETE SET NULL from accounts, so deleting the account first would silently orphan the business forever) — otherwise the 'Consulting' test business leaks permanently into the shared test database."

requirements-completed: [ENT-01, ENT-03, ENT-05, MAP-04]

coverage:
  - id: D1
    description: "createAccount, createImapAccount (both insert and sentinel-adopt branches), and createMicrosoftAccount each call persistAccountLink exactly once, after their branch resolves — not inside either branch — closing the D-03 failure mode where an insert-only hook silently misses the first mailbox connected on every fresh appliance"
    requirement: ENT-01
    verification:
      - kind: unit
        ref: "dashboard/test/lib/queries-accounts.test.ts#createAccount links a new business named after display_label (ENT-01)"
        status: pass
      - kind: unit
        ref: "dashboard/test/lib/queries-accounts.test.ts#createImapAccount insert branch links a business (D-04)"
        status: pass
      - kind: unit
        ref: "dashboard/test/lib/queries-accounts.test.ts#createImapAccount sentinel-ADOPT branch links a business too (D-03)"
        status: pass
      - kind: unit
        ref: "dashboard/test/lib/queries-accounts.test.ts#createMicrosoftAccount insert branch links a business (D-04 provider parity)"
        status: pass
      - kind: other
        ref: "grep -c 'await persistAccountLink(' lib/queries-accounts.ts -> 3"
        status: pass
    human_judgment: false
  - id: D2
    description: "An account connecting on a domain where a sibling account is already linked attaches to that same business (sibling-domain lookup, D-16)"
    requirement: ENT-03
    verification:
      - kind: unit
        ref: "dashboard/test/lib/queries-accounts.test.ts#a second account on an already-linked non-free-mail domain attaches to the same business (ENT-03, D-16)"
        status: pass
    human_judgment: false
  - id: D3
    description: "A failure inside the auto-link seam leaves the account connected with business_id null and the creator's normal return contract intact"
    requirement: ENT-05
    verification:
      - kind: unit
        ref: "dashboard/test/lib/queries-accounts.test.ts#a rejecting linkAccountToBusiness leaves the account connected with business_id null (ENT-05, D-05)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Idempotent, re-runnable backfill links every eligible account by executing the same runtime rule (no hand-written mapping table), supports a read-only dry run, and exits non-zero when any account is left unlinked"
    requirement: MAP-04
    verification:
      - kind: unit
        ref: "node -e check on package.json business:backfill script entry"
        status: pass
      - kind: other
        ref: "BACKFILL_DRY_RUN=1 against seeded local Postgres mirroring D-09's live 6-account/3-existing-business scenario: all 6 resolved correctly (3 reuse, 3 create), zero writes"
        status: pass
      - kind: other
        ref: "live run against the same seed: all 6 linked, 3 businesses created, exit 0; second consecutive run: 0 processed, 0 created, exit 0 (idempotent)"
        status: pass
    human_judgment: false
  - id: D5
    description: "Full CI-order gate (lint -> typecheck -> test) passes twice consecutively against a fixture-bootstrapped Postgres, with the four DB-gated suites provably executing real cases rather than skipping, and the two fully-mocked connect suites unedited"
    verification:
      - kind: other
        ref: "npm run lint && npm run typecheck && npm test against postgres:17-alpine bootstrapped from test/fixtures/schema.sql — 127 files / 1330 tests passed, twice in a row"
        status: pass
      - kind: other
        ref: "test/lib/queries-accounts.test.ts (18), test/lib/crm-auto-link.test.ts (32), test/schema-invariants.test.ts (33), test/lib/job-outcomes.test.ts (5) — 88 executed cases, 0 skips"
        status: pass
      - kind: other
        ref: "git diff --name-only -- test/connect-imap.test.ts test/connect-graph.test.ts -> 0 lines changed"
        status: pass
    human_judgment: false

duration: ~70min
completed: 2026-07-28
status: complete
---

# Phase 5 Plan 3: Runtime Auto-Link Seam + Idempotent Backfill Summary

**Wired plan 05-02's `linkAccountToBusiness` into all three account-creation paths through a single `persistAccountLink` seam positioned after each creator's insert-or-adopt branch resolves, and shipped an idempotent, dry-run-capable backfill script that links live accounts using that identical runtime rule.**

## Performance

- **Duration:** ~70 min
- **Tasks:** 3 completed
- **Files modified:** 4 (1 created, 3 modified)

## Accomplishments

- `dashboard/lib/queries-accounts.ts` — new module-internal `persistAccountLink()` delegating to `linkAccountToBusiness` inside its own try/catch (a second, independent non-fatal guard on top of that function's own D-05 guarantee). `createImapAccount` and `createMicrosoftAccount` restructured so both branches of the sentinel-adopt-or-insert if/else assign into one `result` and fall through to a single tail where the seam is called exactly once — the structural defense against wiring the insert path and forgetting the adopt path (D-02/D-03). `createAccount` calls the same seam once after its INSERT succeeds, still inside the existing try so `isUniqueViolation` keeps owning the duplicate-email path. `await persistAccountLink(` appears exactly 3 times in the file. External contracts unchanged — `test/connect-imap.test.ts` / `test/connect-graph.test.ts` (which fully mock this module) pass unedited.
- `dashboard/test/lib/queries-accounts.test.ts` — new `dbDescribe('auto-link business (persistAccountLink seam)')` block, 8 real-Postgres cases: `createAccount` names a business from `display_label`; `createImapAccount` links on both the insert branch and the sentinel-adopt branch (D-03, proven by temporarily re-arming `primary@appliance.local` on the shared default row); `createMicrosoftAccount` insert-branch parity (D-04); sibling-domain attach (ENT-03/D-16); free-mail isolation (D-07); idempotent find-or-create-by-name (ENT-02); and the ENT-05/D-05 non-fatal guarantee via a `vi.mock` that calls through to the real implementation by default and overrides with `mockRejectedValueOnce` for exactly one case. Also extended the pre-existing CRUD block's `afterAll` to look up and delete each created account's now-possible `business_id` before deleting the account — that block didn't leak business rows before this plan, and would have started leaking one ("Consulting") without this fix.
- `dashboard/scripts/business-link-backfill.ts` — one-shot script whose only linking path is a call to `linkAccountToBusiness`; no hand-written name-to-business mapping anywhere in the file (D-10). Candidate query filters `business_id IS NULL` and excludes the sentinel address (D-11). Serial iteration (not parallel) since `findOrCreateBusiness`/`generateUniqueSlug` both read-then-write. `BACKFILL_DRY_RUN=1` resolves and reports each account's target via the read-only primitives (`extractEmailDomain`, `isFreeMailDomain`, `findBusinessIdBySiblingDomain`, `resolveBusinessName`) without ever calling a write path. Exits non-zero when any candidate account is left unlinked after a live run — the machine-checkable gate plan 05-04's deploy step relies on. Registered as `business:backfill` in `dashboard/package.json`.

## Task Commits

1. **Task 1 (TDD) — RED:** `5128531` (test) — new `dbDescribe` block + the pre-existing CRUD block's business-cleanup fix. Confirmed failing against the un-hooked `queries-accounts.ts` (every `business_id`-non-null assertion failed with `null`) before any seam code existed.
2. **Task 1 — GREEN:** `b4ea1f6` (feat) — `persistAccountLink` seam + all three call sites. All 8 new cases pass; full CRUD + auto-link + guard suite (18 cases) green twice consecutively against a fresh throwaway Postgres with zero leaked rows.
3. **Task 2: Idempotent account-to-business backfill script** — `cae1208` (feat) — `scripts/business-link-backfill.ts` + `package.json` script entry. Verified against a local Postgres seeded to mirror D-09's exact live scenario (6 accounts, 3 pre-existing businesses): dry run reported 3 reuse / 3 create correctly with zero writes; live run linked all 6 (3 businesses created, exit 0); second live run reported 0 processed / 0 created, exit 0.
4. **Task 3: Full CI-order gate against a real Postgres** — no code changes; verification-only. `npm run lint && npm run typecheck && npm test` (in that order) against a `postgres:17-alpine` container bootstrapped from `test/fixtures/schema.sql` (same path CI takes): 127 files / 1330 tests passed, twice in a row. The four DB-gated suites reported real executed-case counts (`queries-accounts.test.ts` 18, `crm-auto-link.test.ts` 32, `schema-invariants.test.ts` 33, `job-outcomes.test.ts` 5 — 88 total, 0 skips), and `test/connect-imap.test.ts` / `test/connect-graph.test.ts` show zero diff against the phase's starting commit.

**Plan metadata:** (this commit, forthcoming) `docs(05-03): complete plan`

## Files Created/Modified

- `dashboard/lib/queries-accounts.ts` — `persistAccountLink` seam + three call sites (modified)
- `dashboard/test/lib/queries-accounts.test.ts` — new auto-link test block + CRUD-block cleanup fix (modified)
- `dashboard/scripts/business-link-backfill.ts` — the backfill script (created)
- `dashboard/package.json` — `business:backfill` script entry (modified)

## Decisions Made

See `key-decisions` in frontmatter for the two test-design decisions (sentinel-ordering fix, default-account deletion guard) and the two implementation decisions (shared `getPool()` in the backfill script, extending the pre-existing CRUD block's cleanup). All four were necessary to make the plan's own acceptance criteria hold (order-independent tests, zero leaked rows, a genuinely idempotent backfill) — none are scope creep beyond what "no code changes outside this plan's stated files" allows, since all four land inside files already in this plan's `files_modified` list.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Test-block sentinel-ordering bug that would have made insert-branch coverage flaky**
- **Found during:** Task 1, first RED-to-GREEN pass
- **Issue:** A first draft of the new `dbDescribe` block followed the plan's literal wording — force the sentinel in the ADOPT test, restore the row's true original values (including its original `email_address`, which on a fresh fixture-bootstrapped DB literally *is* the sentinel) in `afterEach`. That restore re-armed the sentinel after every test, so the very next test to call `createImapAccount`/`createMicrosoftAccount` re-adopted it instead of inserting, flipping `adopted` to `true` where the test expected `false`.
- **Fix:** Moved the sentinel-avoidance to `beforeAll` (move the default row off the sentinel once, up front, onto a stamped placeholder address) and moved full-row restoration to a single `afterAll`. The dedicated ADOPT test still re-arms the sentinel for its own one call, but nothing un-does that placeholder between other tests.
- **Files modified:** `dashboard/test/lib/queries-accounts.test.ts`
- **Verification:** All 18 cases in the file pass, twice consecutively, against a fresh throwaway Postgres.
- **Committed in:** `5128531` (Task 1 RED commit — the block was corrected before ever being committed in its broken form)

**2. [Rule 1 - Bug] `afterAll` cleanup queued the shared default account for deletion under an assertion-order edge case**
- **Found during:** Task 1, while iterating on the sentinel-ordering fix above
- **Issue:** An intermediate draft called `createdAccountIds.add(id)` before asserting `adopted === false` in the Microsoft insert-branch test. When ambient state (from the ordering bug above) caused that call to actually take the ADOPT branch instead, `id` equaled the shared default account's id, and it got queued into `createdAccountIds` before the assertion threw — the block's `afterAll` then deleted the entire default account row, corrupting the throwaway test database (`getDefaultAccountId()` started throwing "no default account" for every subsequent test/run).
- **Fix:** Added a defensive guard (`if (id !== originalDefaultId) createdAccountIds.add(id);`) on both insert-branch tests, so the shared default account can never be queued for deletion regardless of which branch a future regression causes it to take. Also rebuilt the throwaway Postgres container from a clean `schema.sql` apply to recover from the corrupted state.
- **Files modified:** `dashboard/test/lib/queries-accounts.test.ts`
- **Verification:** Directly inspected the DB after the fix (`SELECT id, email_address, is_default FROM mailbox.accounts`) — exactly one row, `is_default=true`, restored to `primary@appliance.local` — across two consecutive full runs.
- **Committed in:** `5128531` (Task 1 RED commit)

**3. [Rule 1 - Bug] Pre-existing CRUD test block started leaking a business row as a side effect of this plan's own seam**
- **Found during:** Task 1, post-GREEN leak check
- **Issue:** `queries-accounts.test.ts`'s pre-existing (plan 05-01/05-02-era) CRUD suite creates an account with `display_label: 'Consulting'` via `createAccount`. That call now auto-links a business as a side effect of this plan's seam; the suite's `afterAll` only ever deleted accounts, so the "Consulting" business row leaked permanently into the shared test database on every run.
- **Fix:** Extended that `afterAll` to look up each created account's `business_id` before deleting the account (the FK is `ON DELETE SET NULL` from `accounts`, so deleting the account first would silently orphan the business forever) and delete the business too.
- **Files modified:** `dashboard/test/lib/queries-accounts.test.ts`
- **Verification:** `SELECT * FROM mailbox.businesses` returned 0 rows after two consecutive full test-file runs against a fresh container (previously showed the leaked "Consulting" row).
- **Committed in:** `5128531` (Task 1 RED commit)

---

**Total deviations:** 3 auto-fixed (all Rule 1 — bugs discovered and fixed during this plan's own test-authoring process, not pre-existing issues in code outside this plan's scope)
**Impact on plan:** All three fixes were necessary for the plan's own acceptance criteria (order-independent, leak-free, twice-repeatable tests) to hold. No scope creep — all changes landed inside `dashboard/test/lib/queries-accounts.test.ts`, already in this plan's `files_modified` list.

## Issues Encountered

- While iterating on the test file (see Deviation #2 above), a buggy intermediate draft deleted the throwaway container's seeded default account, corrupting that specific Postgres container's state. Recovered by tearing down and re-bootstrapping a fresh `postgres:17-alpine` container from `test/fixtures/schema.sql` — no impact on any persistent or live database; the corrupted container was a disposable local Docker container created solely for this plan's verification, never the pre-existing `mailbox-postgres-1` container already running on this machine (confirmed untouched throughout, per the plan's explicit boundary).
- No other blocking issues. Docker was available throughout; the real container-based verification path was used for every task, never a hand-stub fallback.

## User Setup Required

None — no external service configuration required. Per the plan's explicit boundary, the backfill was run and proven only against local throwaway/seeded Postgres containers; it was never run against the live `agentbox3` database. That gated live run is plan 05-04.

## Next Phase Readiness

- Plan 05-04 (live `agentbox3` deploy) can now: (1) apply migration 057 (already written in plan 05-01) to the live appliance Postgres, (2) confirm the app image running there includes this plan's `persistAccountLink` seam so newly connected mailboxes auto-link going forward, then (3) run `BACKFILL_DRY_RUN=1 npm run business:backfill` against the live database first, inspect the dry-run report against the real 6 accounts / 3 existing businesses, and only then run it live. The script's non-zero exit on any remaining unlinked account is the gate 05-04 should check rather than parsing prose output.
- No schema work remains for any future plan in this phase — `accounts.business_id` and `businesses.slug` were fully delivered in plan 05-01, and the resolution rule in plan 05-02 is now the single source of truth exercised identically by both the runtime hook and the backfill.
- Phase 6 (manual business CRUD / rename / re-map UI+API) can build on `accounts.business_id` and `businesses.slug` as stable, already-populated columns for every account this backfill (and the live connect flow) touches.

---
*Phase: 05-backend-data-model-auto-create*
*Completed: 2026-07-28*

## Self-Check: PASSED

All 4 created/modified files confirmed present on disk (`dashboard/lib/queries-accounts.ts`, `dashboard/test/lib/queries-accounts.test.ts`, `dashboard/scripts/business-link-backfill.ts`, `dashboard/package.json`). All 3 task commit hashes (`5128531`, `b4ea1f6`, `cae1208`) confirmed present in `git log --oneline --all`.
