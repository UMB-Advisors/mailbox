---
phase: 05-backend-data-model-auto-create
plan: 02
subsystem: crm
tags: [crm, postgres, kysely, auto-link, slug, vitest]

# Dependency graph
requires: ["05-01"]
provides:
  - "dashboard/lib/crm/auto-link.ts — the single account→business resolution rule (linkAccountToBusiness), consumed by plan 05-03's runtime hook and backfill script"
  - "findOrCreateBusiness(name): Promise<{ id: number; created: boolean }> — idempotent get-or-create by name, D-08 shape"
  - "generateSlug/generateUniqueSlug — D-13 slug generation, proven byte-parity with migration 057's SQL backfill expression"
  - "lib/crm/queries.ts createBusiness compatible with the NOT NULL businesses.slug column"
affects: ["05-03"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Pure resolution primitives (name/domain/slug, no I/O) colocated in the same module as their DB-backed callers, matching lib/classification/preclass.ts's file-header WHAT/WHY style"
    - "D-16 fixed resolution order implemented as an explicit sequential branch inside one try/catch entry point, rather than scattered across callers"

key-files:
  created:
    - dashboard/lib/crm/auto-link.ts
    - dashboard/test/lib/crm-auto-link.test.ts
  modified:
    - dashboard/lib/crm/queries.ts

key-decisions:
  - "Verified against a throwaway postgres:17-alpine container (bootstrapped from test/fixtures/schema.sql, port 15432) rather than the stale local mailbox-postgres-1/mailbox_demo container found running on this machine (still on migration 048, unrelated to this repo's current schema) — never touched that container"
  - "Split the single logical auto-link.ts module into three additive commits (pure primitives / DB-backed layer / queries.ts compat fix) to preserve atomic per-task commits despite the natural file overlap across the plan's three tasks"

requirements-completed: [ENT-01, ENT-02, ENT-03, ENT-05, FILT-05]

coverage:
  - id: D1
    description: "Resolving a business for an account follows exactly one rule, in exactly one place (linkAccountToBusiness), implementing D-16's fixed order"
    requirement: ENT-01
    verification:
      - kind: unit
        ref: "dashboard/test/lib/crm-auto-link.test.ts#linkAccountToBusiness creates (or finds) a business by resolved name when no sibling exists (ENT-01)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Calling the linker twice for the same account or business name creates exactly one business"
    requirement: ENT-02
    verification:
      - kind: unit
        ref: "dashboard/test/lib/crm-auto-link.test.ts#findOrCreateBusiness is idempotent (ENT-02)"
        status: pass
    human_judgment: false
  - id: D3
    description: "An account whose domain has a linked sibling attaches to that business via the sibling-account lookup (D-16), not name matching; free-mail domains never domain-match"
    requirement: ENT-03
    verification:
      - kind: unit
        ref: "dashboard/test/lib/crm-auto-link.test.ts#linkAccountToBusiness attaches to a sibling business without creating a new one (ENT-03, D-16)"
        status: pass
      - kind: unit
        ref: "dashboard/test/lib/crm-auto-link.test.ts#two free-mail accounts with different labels end up on two different businesses (D-07, Pitfall 3)"
        status: pass
      - kind: unit
        ref: "dashboard/test/lib/crm-auto-link.test.ts#a linked first free-mail account still does not domain-match a second (D-07)"
        status: pass
    human_judgment: false
  - id: D4
    description: "A failure anywhere inside the linker resolves normally and never throws into the caller"
    requirement: ENT-05
    verification:
      - kind: unit
        ref: "dashboard/test/lib/crm-auto-link.test.ts#linkAccountToBusiness — non-fatal on internal failure (ENT-05, D-05) — resolves normally when the underlying database call throws"
        status: pass
    human_judgment: false
  - id: D5
    description: "Every business created carries a unique slug generated once from its name (frozen at creation); generateSlug matches migration 057's SQL backfill byte-for-byte; POST /api/crm/businesses still works against the NOT NULL column"
    requirement: FILT-05
    verification:
      - kind: unit
        ref: "dashboard/test/lib/crm-auto-link.test.ts#SQL/TS slug parity: generateSlug matches migration 057s backfill expression for all six live names"
        status: pass
      - kind: unit
        ref: "dashboard/test/lib/crm-auto-link.test.ts#collision-suffixes the slug on a repeat base (-2, then -3)"
        status: pass
      - kind: unit
        ref: "dashboard/test/lib/crm-auto-link.test.ts#createBusiness returns a row with a non-empty unique slug"
        status: pass
      - kind: unit
        ref: "dashboard/test/lib/crm-auto-link.test.ts#updateBusiness rename leaves the slug unchanged (D-12)"
        status: pass
    human_judgment: false

duration: 50min
completed: 2026-07-28
status: complete
---

# Phase 5 Plan 2: Account→Business Auto-Link Summary

**Built the single shared account→business resolution rule (`dashboard/lib/crm/auto-link.ts`) implementing D-16's binding fixed order — sentinel skip, free-mail gate, sibling-account domain attach, then idempotent find-or-create by resolved name — and made the existing manual `createBusiness` path compatible with the NOT NULL `businesses.slug` column added in plan 05-01.**

## Performance

- **Duration:** ~50 min
- **Tasks:** 3 completed

## Accomplishments

- `dashboard/lib/crm/auto-link.ts` — one module holding the entire resolution rule:
  - Pure primitives: `FREE_MAIL_DOMAINS` (exactly the 12 D-07 hosts), `extractEmailDomain`, `isFreeMailDomain`, `resolveBusinessName` (D-06: `display_label` wins, else domain — structurally cannot reference the free-mail set, closing Pitfall 3), `generateSlug` (D-13: NFD-normalized ASCII fold, kebab-case, `'business'` fallback for an all-symbol name).
  - DB-backed layer: `generateUniqueSlug` (probes `mailbox.businesses.slug`, appends `-2`/`-3`/… on collision, capped at 100 attempts), `findBusinessIdBySiblingDomain` (D-16's exact `split_part` lookup — the literal ENT-03 implementation, no `businesses.domain` column needed), `findOrCreateBusiness` (D-08's `ON CONFLICT (name) DO NOTHING RETURNING id` + fallback `SELECT`, `{ id, created }` shape), `linkAccountToBusiness` (the single entry point — sentinel skip → free-mail gate → sibling-domain attach → find-or-create by name → Kysely `accounts.business_id` write, whole body wrapped in one try/catch per D-05/ENT-05).
- Did **not** copy `05-RESEARCH.md`'s stale `linkAccountToBusiness` example (it predates D-16 and has no sibling lookup) — implemented D-16's order from the CONTEXT.md spec directly.
- `dashboard/lib/crm/queries.ts` — `Business.slug: string` added; `createBusiness` now computes a slug via `generateUniqueSlug` (one-directional import from `./auto-link`, no cycle) and supplies it in the INSERT. Signature, return type, and the duplicate-name throw are byte-identical to before (Pitfall 5 — Phase 6 still owns this surface). `updateBusiness`'s patch shape is untouched, with a comment recording D-12 (slugs frozen at creation) so it isn't "fixed" later.
- `dashboard/test/lib/crm-auto-link.test.ts` — 32 cases total: 19 pure-function (ungated, run on every CI machine) + 13 DB-gated (skip cleanly without `TEST_POSTGRES_URL`). DB-gated coverage includes: idempotency, slug population, direct `generateUniqueSlug` probe, real collision-suffix proof (`-2`/`-3` via two names whose slugs collapse to the same base), SQL-injection parameterization proof (literal `DROP TABLE` payload as a business name, table survives), sibling-domain lookup (hit + null), sibling-attach short-circuiting find-or-create, name-based create when no sibling exists, two free-mail-domain isolation cases (D-07), the SQL/TS slug parity gate against migration 057's exact backfill expression for all six live business names, and the two Task 3 cases (`createBusiness` slug population, `updateBusiness` rename leaves slug unchanged).

## Task Commits

1. **Task 1: Pure resolution primitives** — `8ebd8e8` (feat) — `FREE_MAIL_DOMAINS`, `extractEmailDomain`, `isFreeMailDomain`, `resolveBusinessName`, `generateSlug` + the full ungated unit-test block (18 cases). Verified with `npx vitest run` + `npm run lint` + `npm run typecheck` before committing.
2. **Task 2: Database layer** — `c3bb28d` (feat) — `generateUniqueSlug`, `findBusinessIdBySiblingDomain`, `findOrCreateBusiness`, `linkAccountToBusiness` + the DB-gated test block (excluding the two `createBusiness`/`updateBusiness` cases, added in Task 3). Verified twice back-to-back against a throwaway `postgres:17-alpine` container (30 tests passing both runs, zero leaked rows afterward) plus `lint`/`typecheck`.
3. **Task 3: `createBusiness` slug compatibility** — `a926655` (fix) — `Business.slug`, `createBusiness`'s slug-populated INSERT, the D-12 comment on `updateBusiness`, and the two new DB-gated test cases. Verified with the full real CI order: `npm run lint && npm run typecheck && npm test` — **1322/1322 pass** with `TEST_POSTGRES_URL` set (DB cases execute), **1072 pass + 250 skip cleanly** without it.

**Plan metadata:** (this commit, forthcoming) `docs(05-02): complete plan`

## Files Created/Modified

- `dashboard/lib/crm/auto-link.ts` — the new module (created)
- `dashboard/test/lib/crm-auto-link.test.ts` — full test coverage (created)
- `dashboard/lib/crm/queries.ts` — `Business.slug` + `createBusiness` compat fix (modified)

## Exported Signatures for Plan 05-03

Plan 05-03's runtime hook (`queries-accounts.ts`'s shared `persistAccount()`-style seam) and backfill script both call these two directly:

```typescript
export interface LinkAccountToBusinessInput {
  accountId: number;
  email: string;
  displayLabel: string | null;
}
export async function linkAccountToBusiness(input: LinkAccountToBusinessInput): Promise<void>

export interface FindOrCreateBusinessResult {
  id: number;
  created: boolean;
}
export async function findOrCreateBusiness(name: string): Promise<FindOrCreateBusinessResult>
```

`linkAccountToBusiness` never throws (D-05/ENT-05) — plan 05-03's own call sites should still wrap it in a defensive try/catch per the plan's threat register (T-05-06), so a future refactor of this function alone can't silently revoke the non-fatal guarantee for all three callers at once.

## Decisions Made

- **Test infra:** found a stale, unrelated local `mailbox-postgres-1` Docker container (`mailbox_demo` database, still on migration 048) already running on this machine. Did not touch it — spun up a dedicated throwaway `postgres:17-alpine` container on port 15432, bootstrapped from `dashboard/test/fixtures/schema.sql` (the same path CI takes), ran the full suite against it, then removed the container. No live/remote database was touched, per the plan's hard boundary.
- **Commit structure:** the plan's three tasks share heavy file overlap (all three touch `auto-link.ts` and/or the same test file) because the natural unit of work is one cohesive module. Reconstructed each task's file slice incrementally so each commit is genuinely additive and independently verifiable (lint + typecheck + tests all green at each commit), rather than one large commit or three commits with unrelated diffs.
- Kept `resolveBusinessName` structurally free of any reference to `FREE_MAIL_DOMAINS` (separate function, no shared state) so Pitfall 3 (free-mail leaking into naming) is enforced by code structure, not just a comment.

## Deviations from Plan

None — plan executed exactly as written. `05-RESEARCH.md`'s stale `linkAccountToBusiness` example was correctly identified and not used, per the plan's explicit prohibition.

## Known Stubs

None.

## Threat Flags

None — this plan adds no new HTTP route, no new authorization boundary, and no surface outside what the plan's own `<threat_model>` already enumerates (T-05-05 SQL injection, T-05-06 non-fatal DoS, T-05-07 unbounded loop — all three closed by the tests listed above).

## Issues Encountered

None blocking. The stale local `mailbox-postgres-1` container (see Decisions Made) was noted but not an issue — just avoided.

## User Setup Required

None — no external service configuration required. Local-only verification per the plan's explicit gate (the `agentbox3` deploy is plan 05-04, untouched here).

## Next Phase Readiness

- Plan 05-03's runtime hook (inside `queries-accounts.ts`'s shared internal seam) and backfill script can now import `linkAccountToBusiness` and `findOrCreateBusiness` directly from `dashboard/lib/crm/auto-link.ts` — both are fully implemented, tested, and non-fatal.
- `POST /api/crm/businesses` (the live manual-create route) works against the NOT NULL `businesses.slug` column with no route-level change needed — verified by the full test suite passing and by direct inspection that `app/api/crm/businesses/route.ts` is unmodified.
- No import cycle exists: `lib/crm/queries.ts` imports from `lib/crm/auto-link.ts`; `auto-link.ts` imports nothing from `queries.ts` or from `lib/queries-accounts.ts` (confirmed by grep before committing), leaving plan 05-03 free to have `queries-accounts.ts` import `auto-link.ts` without a reverse-direction conflict.

---
*Phase: 05-backend-data-model-auto-create*
*Completed: 2026-07-28*

## Self-Check: PASSED

All 3 files (`dashboard/lib/crm/auto-link.ts`, `dashboard/test/lib/crm-auto-link.test.ts`, `dashboard/lib/crm/queries.ts`) confirmed present/modified on disk. All 3 task commit hashes (`8ebd8e8`, `c3bb28d`, `a926655`) confirmed present in `git log --oneline --all`.
