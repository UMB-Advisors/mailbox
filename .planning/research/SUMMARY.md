# Project Research Summary

**Project:** MailBox One / AgentBOX fork — "Unified Entities" milestone (M5)
**Domain:** Cross-repo CRM entity unification on a live Next.js/Kysely/Postgres dashboard + a separate React/FastAPI sidecar + a flat-file cron/gbrain layer
**Researched:** 2026-07-11
**Confidence:** HIGH

## Executive Summary

This milestone is pure wiring, not new capability. Everything it needs — `mailbox.businesses`, `mailbox.departments.business_id`, the CRM API surface, the sidecar's `crmApi.listBusinesses()` client — already exists and works in production for departments. The one missing link is `mailbox.accounts.business_id`; adding it (a nullable FK, `ON DELETE SET NULL`, identical in shape to the already-shipped `departments.business_id`) is the load-bearing schema change everything else depends on. Zero new runtime dependencies are needed anywhere in either repo.

The real difficulty isn't the schema — it's that this milestone touches **four independent "which company is this for" data sources** that have never been reconciled: (1) `mailbox.businesses` (the CRM, source of truth going forward), (2) `mailbox.accounts` (no link today), (3) the sidecar's hardcoded `ENTITY_OPTIONS` slug array (duplicated across 4 UI consumers), and (4) `job.business` — a bare string living in a flat JSON file (`jobs.json`) on a different host, with no Postgres row, no FK, and no migration hook. A fifth axis, the gbrain digest entity slugs (`entities.json`, owned by a completely separate `agentbox-seed` repo), is explicitly called out as "reconcile" in scope but is the easiest one to silently defer — doing so would leave the system in a *worse* three-way-drift state than today's two-way drift.

Recommended approach: nullable FK column + idempotent auto-provision helper (guarded on `business_id IS NULL`, not on "OAuth fired") called from all three account-creation paths; add a `slug` column to `businesses` and seed it with every string currently live in `job.business`/digest slugs *before* any UI is repointed, so old data keeps resolving; then swap the sidecar's 4 hardcoded-list consumers to a CRM-backed hook one at a time, deleting `entities.ts` at the end so a missed consumer is a build failure, not a silent revert. Main risks: (a) auto-create running twice on re-auth or racing into duplicate businesses — solved by `ON CONFLICT (name) DO NOTHING RETURNING id` + idempotency guard, not a pre-check; (b) deleting a business orphaning accounts/departments/cron-job references now that the dependent surface has grown — needs an explicit dependents-check before delete, not silent `SET NULL` forever; (c) the two repos (`mailbox` on the Jetson via `docker compose`, `agentbox-sidecar` via `rsync`+`systemd` on a different host) deploying out of order, breaking the sidecar UI at runtime with no compile-time signal — mitigated by additive-only, backend-first sequencing.

## Key Findings

### Recommended Stack

No new packages. Reuse Kysely (`^0.28.16`) + plain-SQL migrations for the new `accounts.business_id` column, `pg`/raw-SQL for the CRM query layer (already the convention in `dashboard/lib/crm/queries.ts`), `zod` (`^4.4.1`) for the new "assign account to business" request schema, and a plain `useState`/`useEffect` hook on the sidecar side (matching the existing `useDepartments()` pattern) — not React Query/SWR, which the sidecar doesn't use anywhere today.

**Core technologies:**
- Kysely + plain `.sql` migrations — add one nullable INTEGER FK column; `kysely-codegen` already generates the `Businesses`/`Departments`/`Accounts` types.
- `pg` raw pool (CRM layer) — kept as-is; not worth a mid-feature refactor to Kysely.
- Plain React hook (`useBusinesses()`/`useEntityOptions()`) — mirrors the sidecar's existing, already-working `useDepartments()`.

### Expected Features

**Must have (table stakes):**
- Auto-create a business when a Gmail account is authorized, default ON, idempotent
- Domain/duplicate check at auto-create time (must ship in the *same* phase as auto-create, not later)
- Renaming/adding departments to an auto-created business (already works once `business_id` exists)
- Manual "New Business" creation with no inbox (holding-company/departments-only use case)
- Re-map / un-map an account to a different business (single `UPDATE`, never cascade-delete)
- Every business/department picker across the sidecar reads the one CRM source

**Should have (differentiators):**
- Smart default naming precedence: `display_label` → domain-derived Title Case → generic fallback
- "Link to existing business?" suggestion (not silent auto-create) when a domain match is found
- One-way bridge: CRM `businesses` → gbrain digest entity axis (`entities.json`), additive only

**Defer (v2+):**
- Business merge tool (reparent departments/accounts, pick surviving name) — no near-term requirement forces this if the duplicate check ships on time
- Full two-way sync between CRM and `agentbox-seed`'s `entity_map.yaml` — cross-repo ownership question, explicitly out of scope
- Any RBAC/multi-tenant auth semantics on businesses — this is a single-operator appliance, not a security boundary

### Architecture Approach

Backend-first, additive-only build order across two repos with no shared types and no CI gate tying them together: (A) mailbox-side migration (`accounts.business_id` + `businesses.slug` + legacy-slug seed + an `operator_settings.auto_create_business_enabled` toggle) and the shared `resolveOrCreateBusiness()` helper called from all three account-creation functions; (B) CRM API surface exposing the new fields; (C) sidecar swaps its 4 hardcoded-list consumers to a CRM-backed hook, hard-dependent on Phase A's slug seed already being live; (D) a lower-priority, independent gbrain-bridge sync step that leaves `digest.py`'s read path completely unchanged.

**Major components:**
1. `mailbox.accounts.business_id` (new nullable FK, `ON DELETE SET NULL`) — the join every other component reads
2. `resolveOrCreateBusiness()` / `ensureBusinessForAccount()` (new, `dashboard/lib/crm/`) — idempotent auto-provision helper, called from `createAccount()`, `createImapAccount()`, and the OAuth callback (or all three creation functions, per architecture research's slightly different hook-point recommendation — see Gaps below)
3. `agentbox-sidecar` `useEntityOptions()`/`useBusinesses()` hook — replaces `ENTITY_OPTIONS`, mirrors already-working `useDepartments()`
4. `businesses.slug` + legacy-slug seed — back-compat bridge so existing `job.business` strings in `jobs.json` keep resolving through the new CRM-backed picker
5. Sidecar-side `crm_sync.py` (Phase D, deferred/lower-priority) — one-way sync from CRM businesses to `$HERMES_HOME/entities.json`, never making the gbrain daemon depend on the dashboard being reachable

### Critical Pitfalls

1. **`job.business` is a string in a flat file (`jobs.json`), not a DB row** — there is no SQL migration path for it. Treat the slug→CRM seed as its own explicit, atomic (temp-file+rename), re-runnable migration step, executed across every profile home (`_cron_profile_homes`), before the sidecar UI is repointed.
2. **Auto-create must gate on `business_id IS NULL`, not on "OAuth/token-save fired"** — `saveToken()` is a correct `ON CONFLICT DO UPDATE` for *token* idempotency but fires identically on first-connect and reconnect/re-auth; without the FK-state gate, every re-auth silently re-provisions or duplicates a business.
3. **Name collisions on auto-create are the norm, not the edge case** — `businesses.name` is `NOT NULL UNIQUE` with zero conflict handling today. Use `ON CONFLICT (name) DO NOTHING RETURNING id` + fallback `SELECT`, which also closes the concurrent-double-auth race — never rely on a pre-check read.
4. **Extending `ON DELETE SET NULL` to accounts (and the out-of-DB `jobs.json`) multiplies the blast radius of a business delete** — add an explicit dependents-check (or a supported merge operation) before delete ships, rather than leaving bare delete as the only affordance once accounts/cron jobs also depend on the row.
5. **Fixing 2 of the 3 entity axes (CRM + `job.business`) while leaving the gbrain digest slug list untouched creates a worse, 3-way drift than today's 2-way drift.** The mechanism can be deferred; the *decision* (unify / derive / bridge) must not be — make it explicit in discuss-phase, not left as an implicit "future work" footnote.
6. **Missing even one of the sidecar's 4 hardcoded-list consumers (`ProposalsView`, `CronPage` x2, `DailyBriefPage`) silently reverts that one surface to the stale list** with no error. Delete `entities.ts` (or reduce to a throwing shim) after the swap so a missed import is a build failure.
7. **Cross-repo deploy drift** — `mailbox` (Jetson, `docker compose`) and `agentbox-sidecar` (different host, `rsync`+`systemd`) deploy independently on different cadences with no shared types. Every new/changed field consumed by the sidecar must be additive-only and confirmed live on the mailbox side before the sidecar build ships.

## Implications for Roadmap

Based on research, suggested phase structure (4 phases, strictly ordered — each phase's schema/data is a hard prerequisite for the next):

### Phase 1: Backend data model + auto-create (mailbox repo)
**Rationale:** Every other phase reads either the new FK, the new slug column, or the seed data — this must land and soak first.
**Delivers:** `accounts.business_id` migration (nullable FK, `ON DELETE SET NULL`), `businesses.slug` column + legacy-slug seed (`heron`, `state`, `cde`, `krunchy`, `yes`, `future`, `umb`, `glue`, `myco`, `personal`, `unsorted`, ...), `operator_settings.auto_create_business_enabled` toggle, the shared idempotent `resolveOrCreateBusiness()`/`ensureBusinessForAccount()` helper wired into all three account-creation paths (`createAccount`, `createImapAccount`, and — per architecture research — the OAuth callback for the first-boot no-`createAccount` case), and a business picker/reassign UI on Settings → Accounts (also closes the "6 live accounts need a deliberate one-time manual map" gap — do NOT heuristic-backfill this in the migration).
**Addresses:** auto-create on Gmail connect, domain/duplicate check, manual no-inbox business creation, re-map/un-map.
**Avoids:** Pitfalls 2, 3, 4, 5 (idempotency-on-reconnect, name collision, race, orphan-on-delete).

### Phase 2: CRM API surface (mailbox repo)
**Rationale:** Thin, low-risk surface work; keeping it separate from Phase 1 lets the schema migration verify against live data before any consumer reads it.
**Delivers:** `GET /api/crm/businesses` includes `slug`; `GET /api/accounts` includes `business_id` (and optional `?business_id=` filter).
**Uses:** existing Kysely-typed route pattern, no new stack elements.
**Implements:** the CRM API component boundary.

### Phase 3: Sidecar filter-wiring (agentbox-sidecar repo)
**Rationale:** Hard dependency on Phase 1's legacy-slug seed — shipping this before the seed exists breaks label resolution for every existing cron job, Daily Brief entry, and proposal.
**Delivers:** `useEntityOptions()` hook (mirrors `useDepartments()`), swapped into all 4 confirmed consumers (`CronPage.tsx` x2, `DailyBriefPage.tsx`, `ProposalsView.tsx`), then deletion of `web/src/lib/entities.ts` so a missed import fails the build.
**Addresses:** single-source-of-truth entity pickers (the milestone's named, concrete bug).
**Avoids:** Pitfall 10 (missed consumer), Pitfall 9 (deploy-order — verify mailbox side is live via `/api/system/status` before this deploy).

### Phase 4: gbrain digest axis bridge (agentbox-sidecar repo, Python side)
**Rationale:** Touches a different, higher-risk-per-line process boundary (the gbrain daemon on a separate on-Jetson process with its own file contract); not load-bearing for the rest of the milestone's UI-facing goals; sequencing last lets the CRM business list stabilize post-Phase-1/3 renames before becoming someone else's sync source.
**Delivers:** a small, additive CRM → `$HERMES_HOME/entities.json` one-way sync step (e.g. `crm_sync.py`, on startup/interval), with `digest.py`'s existing read path completely untouched.
**Addresses:** the milestone's explicit "reconcile the gbrain digest entity axis" requirement, without a full two-way merge with the separately-owned `agentbox-seed` repo.
**Avoids:** Pitfall 7 (unreconciled 3rd axis) and the anti-pattern of making the digest daemon depend on the dashboard being reachable.

### Phase Ordering Rationale

- Strict backend → API → frontend → cross-process-bridge dependency chain — each phase's schema/data is a literal prerequisite for the next, confirmed identically by both STACK and ARCHITECTURE research.
- Auto-create and its duplicate-check must ship together within Phase 1, not split across phases — shipping auto-create without the domain-match check guarantees a known duplicate-business bug window (FEATURES research, Dependency Notes).
- The legacy-slug seed is a hard gate on Phase 3, not a nice-to-have — it is the only thing standing between "sidecar reads live CRM data" and "every historical job/digest/proposal record loses its label" (Pitfall 1, Architecture Q3).
- The gbrain bridge is sequenced last specifically because it is the one item most likely to be silently dropped by accident (a 4th, separately-owned repo) — putting it as its own explicit phase, rather than a footnote inside Phase 3, is a deliberate mitigation for Pitfall 7.

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 1:** the exact hook-point recommendation differs slightly between STACK/PITFALLS research (OAuth callback + 2 other call sites) and ARCHITECTURE research (`createAccount()` only, treating callback as attach-only) — resolve this discrepancy explicitly in discuss-phase before planning, it changes where the idempotent helper is called from.
- **Phase 4:** cross-repo, cross-language (Python) sync design against a repo (`agentbox-seed`) this milestone doesn't otherwise open — needs its own scoped research/discuss pass on sync trigger (startup vs. interval vs. CRM-mutation webhook) before planning.

Phases with standard patterns (skip research-phase):
- **Phase 1 (schema portion):** direct precedent already shipped (`departments.business_id`, migration 053) — copy, don't research.
- **Phase 2:** standard additive API-field addition, no open questions.
- **Phase 3:** direct precedent already shipped and working (`useDepartments()`) — copy the pattern.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All findings verified directly against live repo code (migrations, `queries-accounts.ts`, `crm/queries.ts`, `entities.ts`), not inferred; zero new dependencies is a strong, well-grounded conclusion. |
| Features | MEDIUM | Patterns cross-checked against Front/HubSpot/WorkOS/Clerk docs via web search, but no vendor source was deep-crawled — treat competitor specifics as directional; the repo-grounded parts (schema, MVP scope) are solid. |
| Architecture | HIGH | All findings from direct code/migration inspection; no external sources needed. One internal disagreement with Pitfalls research on exact hook placement (see Research Flags) needs resolving in discuss-phase. |
| Pitfalls | HIGH | Codebase-grounded from live source across both repos; general-pattern backing (idempotent upserts, expand-contract migrations, FK-default risk) is MEDIUM-confidence but only supports already-repo-grounded conclusions, not load-bearing on its own. |

**Overall confidence:** HIGH

### Gaps to Address

- **Auto-create hook placement disagreement:** STACK/PITFALLS research recommends 3 call sites (OAuth callback for first-boot, plus `createAccount`/`createImapAccount`); ARCHITECTURE research recommends hooking `createAccount()`/`createImapAccount()`/`createMicrosoftAccount()` only, treating the OAuth callback as pure token-attach with no creation semantics. Resolve in discuss-phase — likely by confirming whether the first-boot onboarding wizard's Gmail tab (currently a stub, per Architecture research) will ever exercise a path with no prior `createAccount()` call.
- **IMAP/Microsoft parity:** the milestone spec explicitly scopes auto-create to "Gmail authorized," but all research agrees the 3-function structure of `queries-accounts.ts` makes it easy to accidentally scope-limit to Gmail only. Discuss-phase should make the IMAP/Microsoft behavior (full auto-create vs. deliberate no-op vs. prompt) an explicit, written decision, not an implementation accident (Pitfall 6).
- **Inline "attach to existing vs. create new" UX at connect time:** flagged by both Features and Pitfalls research as the single biggest risk of a fully-silent default-on auto-create (Pitfall 8) but not yet a designed UI flow — needs discuss-phase/spec-phase attention before Phase 1 planning locks the API shape.
- **gbrain bridge sync trigger:** startup-only vs. interval vs. CRM-mutation-triggered refresh is explicitly left open by Architecture research — needs its own research/discuss pass in Phase 4.

## Sources

### Primary (HIGH confidence — direct code inspection, both repos)
- `dashboard/migrations/033-*.sql`, `047-*.sql`, `048-*.sql`, `052-*.sql`, `053-*.sql`, `038-*.sql` — accounts/businesses/departments schema history
- `dashboard/lib/queries-accounts.ts`, `lib/crm/queries.ts`, `lib/oauth/google.ts`, `lib/db/schema.ts`
- `dashboard/app/api/oauth/google/callback/route.ts`, `app/api/oauth/google/[provider]/connect/route.ts`, `app/api/accounts/route.ts`, `app/api/crm/businesses/route.ts` + `[id]/route.ts`, `app/onboarding/email-connect/page.tsx`
- `agentbox-sidecar/web/src/lib/entities.ts`, `lib/crm.ts`, `lib/departments.ts`, `pages/{CronPage,DailyBriefPage}.tsx`, `components/ProposalsView.tsx`, `components/ScopeFilter.tsx`
- `agentbox-sidecar/src/agentbox_sidecar/features/{digest,cronext}.py`
- Root `CLAUDE.md` (this repo) and `dashboard/CLAUDE.md`, `agentbox-sidecar/CLAUDE.md` — live version pins, `xmax=0` idempotency pattern, deploy mechanisms

### Secondary (MEDIUM confidence)
- Front Help docs (shared inbox / channel model), HubSpot connected-inbox docs (disconnect vs. delete), WorkOS AuthKit + Clerk Organizations docs (JIT provisioning, domain-match-before-create pattern) — cross-referenced for the feature-landscape/anti-features section, not project-specific
- General web research on expand-contract migration pattern and idempotent-upsert-via-unique-constraint (DeployHQ/PlanetScale/CodeOpinion, Google Cloud/Zuplo/Salesforce idempotency docs) — supports pitfalls already independently grounded in this repo's code

---
*Research completed: 2026-07-11*
*Ready for roadmap: yes*
