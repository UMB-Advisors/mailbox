# Pitfalls Research

**Domain:** Auth-triggered entity auto-provisioning + multi-source entity-list unification on a live, cross-repo, multi-storage-medium system (mailbox Postgres backend + agentbox-sidecar SPA + gbrain flat-file config)
**Researched:** 2026-07-11
**Confidence:** HIGH (codebase-grounded — read directly from live source: `mailbox` migrations 033/047/048, `dashboard/lib/oauth/google.ts`, `dashboard/app/api/crm/*`, `agentbox-sidecar/web/src/lib/entities.ts`, `agentbox-sidecar/src/agentbox_sidecar/features/{digest,cronext}.py`) with MEDIUM-confidence general-pattern backing from web research on idempotent provisioning and schema-migration practice.

## Critical Pitfalls

### Pitfall 1: `job.business` isn't a database column — it's a string in a flat JSON file, so "migrate slug→id" isn't a SQL migration at all

**What goes wrong:**
The instinct is to treat "unify `job.business` onto the CRM" as a standard FK-backfill migration (add a column, backfill, drop the old one). It isn't. Cron jobs (`agentbox-sidecar` `cronext.py`) are read from `<HERMES_HOME>/cron/jobs.json` on disk — one JSON blob per profile home (`_cron_profile_homes`) — not a Postgres table. `job.business` is a bare string slug (e.g. `"heron"`) written into that file by the sidecar SPA (`CronPage.tsx`, `setBusiness(asText(job.business) || asText(job.memory_entity))`) and read back for the "Business" grouping (`CronPage.tsx:305`). The CRM `businesses` table lives in a *different service* (mailbox `dashboard`, Postgres, migration 048), reached over HTTP through the sidecar's `/dashboard/api/crm/*` proxy (`web/src/lib/crm.ts`). There is no FK, no `ON DELETE`, no transaction spanning the two — a business renamed or deleted in the CRM has zero effect on the slug already baked into `jobs.json`, and nothing will ever surface that drift as an error.

**Why it happens:**
The mental model "unify onto CRM" implicitly assumes everything referencing an entity lives in the same database. Here one of the four consumers named in the milestone (Agent Jobs / `CronPage`) is backed by a file on a different host's filesystem, written by a different codebase, with no migration runner at all.

**How to avoid:**
Treat the jobs.json rewrite as its own explicit migration step, separate from any SQL migration: (1) resolve every existing `job.business` slug against the current `ENTITY_OPTIONS`→CRM-business mapping at rollout time (one-shot script, not a lazy runtime lookup, since profile homes can be plural and are only enumerable at runtime via `_cron_profile_homes`); (2) write the resolved `business_id` (and keep the slug as a legacy display fallback) back into each job record in `jobs.json`; (3) make the write idempotent/re-runnable since there's no transaction boundary to protect it — a partial rewrite (crash mid-file) must not corrupt `jobs.json` for the *other* jobs in the same file. Write to a temp file + atomic rename, not in-place.

**Warning signs:**
Any plan that says "ALTER TABLE jobs ADD COLUMN business_id" without first confirming where cron jobs actually persist. Also: any test plan that only checks the mailbox Postgres schema and never touches an actual `~/cron/jobs.json` fixture.

**Phase to address:**
Dedicated "slug→CRM-id backfill" phase, sequenced *before* the UI is pointed at CRM ids, with its own rollback (restore `jobs.json` from backup) independent of any SQL migration rollback.

---

### Pitfall 2: Auto-create hook reuses `saveToken`'s upsert, which can't distinguish "first connect" from "reconnect" — re-auth silently re-runs provisioning

**What goes wrong:**
`dashboard/lib/oauth/google.ts:saveToken` is already `INSERT ... ON CONFLICT (provider, account_id) DO UPDATE` — correctly idempotent for *token storage*, but it fires on every OAuth callback, first-connect and re-auth (expired refresh token, revoked+reconnect, scope-bump) alike, with no signal to the caller about which case happened. If the new auto-create-entity logic is bolted onto this same function without checking whether it already ran for this account, every re-auth becomes a re-provisioning event: renamed/merged businesses get silently recreated, or a second `businesses` row gets attempted (and fails the `UNIQUE(name)` constraint with a raw 500 the operator doesn't understand, since `POST /api/crm/businesses` has no conflict handling — see Pitfall 3).

**Why it happens:**
`saveToken` was written for the multi-account/oauth-tokens concern (migration 033), before "does this account already have a linked business" existed as a question. The natural place to hook is the OAuth callback route (`app/api/oauth/google/callback/route.ts`), but that route also has no first-connect/reconnect signal today — `verified.accountId` is resolved from signed state either way.

**How to avoid:**
Reuse the pattern already established in this exact codebase for the identical problem: `POST /api/internal/inbox-messages` distinguishes "was this a fresh INSERT or a dedupe-skip" via the Postgres `xmax = 0` trick on the upsert (documented in root `CLAUDE.md`, "Response (LOCKED)"). Do the same for account/business linkage: gate auto-create on `accounts.business_id IS NULL` (a new nullable column, not on "token save happened"), so re-auth against an account that already has a linked business is a guaranteed no-op regardless of how many times OAuth fires.

**Warning signs:**
Any auto-create implementation triggered directly inside `saveToken` or the callback route without first reading the account's current `business_id`.

**Phase to address:**
The phase that adds the auto-create hook — make "account already linked → no-op" the first unit test written, before the happy path.

---

### Pitfall 3: Auto-create name collision — `createBusiness` has no conflict handling, and `display_label`/domain-derived names collide easily

**What goes wrong:**
`mailbox.businesses.name` is `NOT NULL UNIQUE` (migration 048) and `POST /api/crm/businesses` (`createBusiness`) does no `ON CONFLICT` handling — a duplicate name throws a raw Postgres unique-violation that surfaces as an unhandled 500. Auto-creating a name from `display_label` or email domain is exactly the kind of input likely to collide: two Gmail accounts on the same company domain (`consulting@heronlabsinc.com` + `founder@heronlabsinc.com`), a re-run of onboarding after a manually-created business of the same name already exists (operator pre-created "Heron Labs" in Settings before ever connecting Gmail), or two accounts with an identical or blank `display_label`.

**Why it happens:**
`display_label` is operator-set free text (see `dashboard/lib/schemas/accounts.ts`), not validated for uniqueness anywhere upstream — the uniqueness constraint only exists at the CRM layer, and only as a hard DB constraint with no application-level pre-check today.

**How to avoid:**
Auto-create logic must (a) normalize the candidate name deterministically (trim/casefold) before comparing, (b) do a case-insensitive existence check first, and (c) on collision, **link to the existing business** rather than erroring or silently dropping the create — this is very likely the *desired* behavior anyway (second Gmail account for the same company should map to the existing entity, not spawn a duplicate). Wrap the actual insert in `ON CONFLICT (name) DO NOTHING RETURNING id`, then a follow-up `SELECT` on conflict, so the race between the pre-check and the insert (two accounts authorizing concurrently — Pitfall 4) can't slip through.

**Warning signs:**
Any manual QA pass that only tests auto-create with a single, uniquely-named account — the collision path won't show up until a second account for the same company is connected.

**Phase to address:**
Same phase as Pitfall 2 (auto-create hook) — collision handling and idempotency-on-reconnect are two faces of the same "don't assume this is the only account that will ever hit this code path" problem.

---

### Pitfall 4: Race condition — two near-simultaneous OAuth callbacks (or a double-click "Connect") both auto-create the same business

**What goes wrong:**
An application-level "check if business named X exists, if not create it" (read-then-write) has a classic TOCTOU race: two account-connect flows that resolve to the same candidate name, executing close together, can both pass the "does not exist" check before either commits the insert. The result is two `businesses` rows for the same real-world company, one of which becomes an orphan the operator has to notice and manually merge.

**Why it happens:**
Nothing here today enforces single-flight execution for account onboarding — the OAuth consent redirect + `Settings > Accounts` "Add account" flow is fully capable of being triggered twice (browser back-button retry, operator double-clicking "Learn voice," or genuinely two different Gmail accounts for the same company connected within the same onboarding session).

**How to avoid:**
Don't rely on a pre-check; rely on the DB constraint doing the deduplication (Pitfall 3's `ON CONFLICT (name) DO NOTHING RETURNING id` + fallback `SELECT`). This makes the race harmless by construction instead of trying to prevent the race from happening.

**Warning signs:**
Load/concurrency testing is unlikely to be part of manual UAT for this feature — explicitly write a test that fires two auto-create requests concurrently for the same candidate name and asserts exactly one `businesses` row results.

**Phase to address:**
Same phase as Pitfall 2/3.

---

### Pitfall 5: FK defaults (`ON DELETE SET NULL`) silently orphan departments/team members today — extending the model to accounts and cron-job references multiplies the blast radius

**What goes wrong:**
Migration 048 gives `departments.business_id` `ON DELETE SET NULL` (not CASCADE, not RESTRICT) — deleting a business today silently un-scopes every department that belonged to it rather than blocking the delete or asking the operator to reassign/merge. `DELETE /api/crm/businesses/[id]` has no pre-delete check for dependents at all (`deleteBusiness` is called unconditionally). Once this milestone adds `accounts.business_id` and (per Pitfall 1) a business_id reference baked into `jobs.json`, a business delete becomes a much bigger silent-orphan event: departments unassign (existing behavior), a connected Gmail account loses its entity mapping (new), and any cron job's linked business_id becomes a dangling reference in a file the SQL layer can't even see, let alone protect (no FK possible across a Postgres table and a JSON file on a different host).

**Why it happens:**
`ON DELETE SET NULL` was a reasonable default when departments were the only dependent — "unassigned" is a safe, visible fallback state in the departments UI. It stops being safe once accounts and cron jobs depend on the same row, because "unassigned account" and "orphaned cron job business reference" are not equally visible failure states.

**How to avoid:**
Before this milestone extends `business_id` to `accounts`, add an explicit "what depends on this business" check to the delete/merge path: block delete (or require explicit confirmation) when `accounts.business_id`, `departments.business_id`, or any cron job in `jobs.json` still references it. Ship a "merge businesses" operation (reassign all dependents from A→B, then delete A) as the supported path for the CDE/Krunchy/Yes-Cacao-style consolidation this milestone implies, rather than leaving bare delete as the only UI affordance.

**Warning signs:**
A "delete business" button that doesn't first query for dependent accounts/departments/jobs, or a merge feature that's SQL-only and doesn't also touch `jobs.json`.

**Phase to address:**
The phase that wires business_id onto `accounts` and exposes delete/merge in the UI — add an explicit dependents-check + merge operation as acceptance criteria, not just the FK column.

---

### Pitfall 6: Auto-create hook wired into only one of three account-creation paths (Gmail), leaving IMAP/Microsoft accounts silently inconsistent

**What goes wrong:**
`dashboard/lib/queries-accounts.ts` has three separate account-creation functions — `createAccount` (Gmail), `createImapAccount`, `createMicrosoftAccount` — each called from a different onboarding/settings flow. The milestone spec explicitly scopes auto-create to "when a Gmail account is authorized," but the CRM Settings > Accounts UI presents all three provider types uniformly. If the auto-create hook only lands in the Gmail path, an operator connecting an IMAP or Microsoft account gets a silently different experience (no entity ever appears) with no error, no explanation, and no obvious place in the UI to notice the asymmetry — they'll file it as "the business didn't show up" rather than recognizing it as an intentional scope boundary.

**Why it happens:**
Three near-identical functions in the same file make it easy to add logic to one and forget the other two, especially under time pressure — nothing enforces that all three call a shared post-create hook.

**How to avoid:**
Factor the auto-create call into a single shared helper (`linkOrCreateBusinessForAccount(accountId, displayLabel)`) called from all three creation functions, even if IMAP/Microsoft initially route to a no-op or a "prompt operator to pick a business" behavior instead of full auto-create — make the scope decision explicit in code, not an accident of where the hook got added.

**Warning signs:**
Grep for the new hook call after implementation — it should appear exactly once (in a shared helper) or exactly three times (deliberately, once per creation function) with matching logic. If it appears once inline in `createAccount` only, that's the gap.

**Phase to address:**
The auto-create phase — make "connect via IMAP, verify entity behavior is a deliberate choice" an explicit UAT case, not an afterthought.

---

### Pitfall 7: Two-of-three unification — fixing `ENTITY_OPTIONS` + `job.business` but leaving the gbrain digest slug axis (`AGENTBOX_ENTITY_SLUGS`/`entities.json`) untouched creates a *worse* three-way drift than today's two-way drift

**What goes wrong:**
There are currently three independent entity-slug sources: (1) the hardcoded `ENTITY_OPTIONS` array duplicated across the sidecar frontend (`web/src/lib/entities.ts`, itself a manually-synced copy of a backend list per its own doc comment), (2) `job.business` slugs in `jobs.json`, and (3) the gbrain digest axis read via `AGENTBOX_ENTITY_SLUGS` env or `$HERMES_HOME/entities.json`, which is **written by a fourth, separate repo** (`UMB-Advisors/agentbox-seed`, "the org layer... writes entities.json on apply" per `digest.py`'s own comment) and consumed by `_entity_slugs()` in `digest.py` for the Daily Brief entity filter. If this milestone unifies (1) and (2) onto the CRM but treats (3) as out of scope or "bridge later," the digest filter and the jobs/proposals filter can now disagree about which entities exist — a worse state than today, where at least all UI surfaces read the same static list.

**Why it happens:**
The milestone's own scope note says the gbrain axis reconciliation is "decision in scope" but leaves the mechanism open (unify/derive/bridge) — it's the one axis owned by a repo (`agentbox-seed`) this milestone doesn't otherwise touch, so it's the easiest one to defer, and deferring it is exactly what produces the three-way split.

**How to avoid:**
Make an explicit decision (not a deferral) in the discuss-phase for this milestone: either (a) `agentbox-seed`'s `entities.json` becomes generated *from* the CRM (CRM is upstream, seed script reads `/api/crm/businesses` and writes the file — closes the loop), or (b) it stays independent and `_entity_slugs()` is changed to treat CRM as the source of truth with `entities.json` as a fallback only, with an explicit reconciliation warning logged on any mismatch. "Bridge it later" should not be the default outcome of an unnamed decision.

**Warning signs:**
Roadmap or plan documents that mention `entities.json` only as a footnote, or that don't name which repo's migration owns writing to it.

**Phase to address:**
Should get its own phase (or an explicit line item in the CRM-unification phase) — this is squarely what the milestone's own "Reconcile the separate gbrain digest entity axis" bullet is calling out, and it's the item most likely to get silently dropped because it spans a repo this milestone doesn't otherwise open.

---

### Pitfall 8: Default-on auto-create with no opt-out turns "connect a 4th mailbox for the same company" into "spawn a 4th business"

**What goes wrong:**
If auto-create fires unconditionally on every successful Gmail auth, connecting an additional inbox for a company that already has a CRM business (e.g., a new `orders@heronlabsinc.com` alias added after "Heron Labs" already exists from `founder@heronlabsinc.com`) either (a) collides on name (Pitfall 3, if names happen to match) or (b) creates a *second*, differently-named business for the same real company if the derived name differs (`display_label` set to "Orders Inbox" vs the domain-derived "Heron Labs"). There's no point in the connect flow today where the operator is asked "is this a new company, or another inbox for an existing one?"

**Why it happens:**
"Default OFF, opt-in" is this project's own established pattern for exactly this class of risk — see the live auto-send rules requirement ("Configurable auto-send rules (default OFF, per-category opt-in after trust-building)" in `.planning/PROJECT.md`). Entity auto-create is a structurally similar high-blast-radius default; it's easy to build it as unconditionally-on because the milestone framing ("entities come into existence automatically") reads as a hard requirement rather than a default-with-override.

**How to avoid:**
Surface a lightweight confirm/pick step in the account-connect flow: after auth succeeds, show the derived candidate name + a typeahead of existing businesses, defaulting to "create new" but making "attach to existing" a one-click alternative before the row is committed — not a separate settings toggle nobody will find, but an inline moment in the flow that already redirects the operator back to `/settings/accounts` (`accountsGmailRedirect`, MBOX-399) where this confirmation naturally slots in.

**Warning signs:**
A design that treats "auto-create" as fully silent/background — if the operator never sees a moment to say "no, that's the same company," this pitfall is live.

**Phase to address:**
The auto-create phase — the confirm step is a UI requirement, not a follow-on nicety.

---

### Pitfall 9: Cross-repo deploy drift — sidecar and mailbox dashboard have entirely different deploy mechanisms, hosts, and cadences

**What goes wrong:**
`agentbox-sidecar` deploys via `pnpm build` → `rsync` → `systemctl --user restart agentbox-sidecar` on `agentbox2` (100.127.2.54) — a manual/scripted procedure, no CI gate tying it to the mailbox repo. `mailbox`'s dashboard deploys via `git pull && docker compose up -d --build` on the `mailbox1` Jetson appliance, a *different physical box*. These are two different repos, two different hosts, two different people/timings pushing. If the sidecar ships a build expecting `GET /api/crm/businesses` to return a new field (or `accounts` list to include `business_id`) before the mailbox migration + route change is deployed to `mailbox1`, the sidecar UI breaks (undefined field, filter shows nothing) with no compile-time signal — it's a same-origin HTTP call at runtime, not a shared type import.

**Why it happens:**
There is no shared package, no generated client, and no integration test spanning both repos today — `web/src/lib/crm.ts`'s TypeScript interfaces (`Business`, `Department`, `TeamMember`) are hand-maintained copies of what the mailbox dashboard's Kysely-typed routes actually return, exactly the same "manually keep two things in sync" pattern already flagged as fragile in `entities.ts`'s own comment.

**How to avoid:**
Sequence deploys deliberately for this milestone: land and deploy the mailbox-side schema/route changes (additive, backward-compatible — new nullable columns, new fields appended to existing response shapes, never a removed/renamed field) *before* the sidecar build that starts reading them. Treat every new CRM field consumed by the sidecar as additive-only until the sidecar deploy is confirmed live, mirroring this repo's own migration-033 "NON-BREAKING BY DESIGN" playbook (new columns with defaults, existing callers unaffected). Add a smoke check analogous to the existing `mailbox-n8n-verify` pattern — a scripted probe that hits `/api/crm/businesses` from the sidecar side post-deploy and asserts the expected shape, rather than discovering drift from an operator bug report.

**Warning signs:**
A plan step that says "update the CRM response shape" without a corresponding "confirm mailbox1 is deployed and serving the new shape before deploying agentbox2."

**Phase to address:**
Cuts across every phase that touches both repos — call it out explicitly in each such phase's plan as an ordering constraint (mailbox deploy → verify → sidecar deploy), not a one-time note.

---

### Pitfall 10: Retiring the hardcoded `ENTITY_OPTIONS` list requires touching four separate consumers, and missing one silently reverts the unification

**What goes wrong:**
`ENTITY_OPTIONS` (`agentbox-sidecar/web/src/lib/entities.ts`) is imported in four places today: `ProposalsView.tsx`, `CronPage.tsx` (twice — two different dropdowns), and `DailyBriefPage.tsx`. Its own doc comment already documents the failure mode this milestone is meant to fix ("Keep the two in sync — the backend asserts its own slug/label parity"). If the unification work replaces the import in three of the four call sites but misses one (easy, since two of the four are in the same 1500+-line `CronPage.tsx`), that one surface silently keeps showing the stale hardcoded list — including entities that no longer exist in the CRM and excluding any newly auto-created ones — with no error, just a dropdown that looks plausible but is wrong.

**Why it happens:**
Nothing enforces "no remaining imports of `ENTITY_OPTIONS`" as a gate — it's a manual grep-and-replace across files that don't obviously relate to each other from a diff-review standpoint (a proposals view and a cron page don't look like they'd share a bug).

**How to avoid:**
After wiring all four consumers to the CRM-backed source, delete `entities.ts` entirely (or reduce it to a thin deprecated shim that throws/logs if imported) so any missed call site is a build failure, not a silent revert. Grep for `ENTITY_OPTIONS` and `ENTITY_SLUGS` as an explicit verification step before calling the phase done.

**Warning signs:**
`entities.ts` still exists and is still importable after the phase claims "unified" — that's the tell that at least one consumer might still be on the old path.

**Phase to address:**
The unification phase itself — make "grep returns zero results for `ENTITY_OPTIONS` imports outside a deleted/shim file" a literal verification step.

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|-----------------|------------------|
| Keep `job.business` as a slug string in `jobs.json`, add a parallel `business_id` field without removing the slug | No risky rewrite of the cron file format; CronPage keeps working if the id lookup fails | Two sources of truth per job forever; a rename in CRM won't update the slug, so the two can visibly disagree in the UI | Acceptable **temporarily**, as an expand-phase step — must have a named contract date/phase in which the slug field is dropped, not left indefinitely |
| Auto-create businesses with no confirm-before-create UI step (fully silent) | Faster to ship, matches the literal "entities come into existence automatically" milestone framing | Every subsequent multi-account-per-company case (Pitfall 8) becomes cleanup work an operator has to notice and merge manually | Never — this project already has a "default OFF for high-blast-radius automation" norm (auto-send rules); entity creation is the same class of risk |
| Leave `entities.json` (gbrain digest axis) unreconciled this milestone, note it as "future work" | Keeps this milestone's scope to two repos (mailbox + sidecar) instead of three (+ agentbox-seed) | Introduces a three-way slug disagreement that's strictly worse than today's two-way one (Pitfall 7) | Only acceptable if the *decision* (unify/derive/bridge) is made and documented now, with the mechanism deferred — not if the decision itself is deferred |
| Hard-delete a business row with `ON DELETE SET NULL` cascading silently | Simple to implement, matches the existing departments behavior | Silent data-integrity loss compounds as more tables (accounts, and the out-of-DB `jobs.json`) gain a `business_id` dependency | Never for this milestone — the dependent surface area is growing specifically because of this milestone's own scope |

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|-----------------|-------------------|
| Gmail OAuth callback (`app/api/oauth/google/callback/route.ts`) | Treating every successful `saveToken` call as "a new account was connected" and firing auto-create unconditionally | Gate on `accounts.business_id IS NULL`, not on "the OAuth callback ran" — re-auth fires the same code path |
| `agentbox-sidecar` ↔ mailbox dashboard (`/dashboard/api/crm/*` proxy) | Assuming both repos deploy together because they're logically one feature | They deploy to different hosts on different cadences (Pitfall 9) — sequence backend-first, additive-only |
| `agentbox-seed` (org layer) → `entities.json` | Assuming this milestone's CRM unification automatically covers the gbrain digest axis because "it's all entities" | It's a fourth repo with its own write path; requires an explicit decision, not inherited scope |
| Cron jobs (`~/cron/jobs.json`, multiple profile homes via `_cron_profile_homes`) | Migrating the "primary" profile home's jobs.json and assuming that's all of them | Enumerate all profile homes at migration time; the function already exists (`_cron_profile_homes`) — use it, don't hardcode one path |

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|-----------------|
| Re-reading/rewriting the entire `jobs.json` file on every job save/business-link update | Fine at today's job counts; becomes a full-file read-modify-write race as job count grows or as multiple sidecar tabs edit concurrently | Keep the atomic temp-file+rename write pattern (Pitfall 1) even at small scale, since it's cheap insurance, not a scale-driven optimization | Not a near-term concern at this system's scale (single appliance, small job counts) — flagged only because the migration touches this file directly |
| N+1 dependents-check on business delete (querying accounts/departments/jobs separately per delete click) | Not currently a concern (single-appliance, low request volume) | Fine to implement as separate sequential queries given current scale; don't over-engineer a single SQL join for this | Only relevant if this model is ever extended beyond a single appliance's dataset size |

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| New CRM-linked account routes (e.g. an account→business PATCH endpoint) not wired through the sidecar's session-header pattern (`setSessionHeader`, MBOX-477 session-gating on `/dashboard/api/*`) | Requests silently 401 through the proxy while working fine when hit directly against the mailbox dashboard in dev — a hard-to-reproduce "works on the appliance API, fails through the sidecar UI" bug | Any new `/api/crm/*` route consumed by the sidecar must be exercised through the actual proxy path in testing, not just curled directly against `mailbox-dashboard:3001` |
| Auto-create logic trusting `display_label` (operator-editable free text) as an implicit uniqueness/identity signal | An operator could rename `display_label` to collide with (or impersonate) another business's name, causing an unintended merge-by-name | Treat `display_label`/domain-derived name only as a *default suggestion* for a new business name, never as an automatic linking key across unrelated accounts without confirmation (ties to Pitfall 8) |

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-------------------|
| Auto-created business silently appears with a domain-derived name the operator wouldn't have chosen (e.g. "Heronlabsinc" instead of "Heron Labs") | Operator has to hunt through Settings > Businesses to notice and rename it; erodes trust in "automatic" | Prefer `display_label` over raw domain when available; surface the confirm-before-create moment from Pitfall 8 so the name is reviewed once, at connect time |
| Deleting a business with dependent departments/accounts just silently unassigns them (current `ON DELETE SET NULL` behavior, extended) | Operator doesn't discover the departments/accounts lost their business link until they notice a filter behaving oddly, much later | Block delete (or require explicit "reassign these N departments / M accounts first") per Pitfall 5 |
| Four separate dropdowns (`ProposalsView`, `CronPage` x2, `DailyBriefPage`) each independently reading entity options | If unification misses one, the operator sees *different* entity lists in different parts of the same app with no indication which is authoritative | Single shared hook/query (e.g. a `useBusinesses()` fetching `/api/crm/businesses` once, memoized) consumed by all four, so there's structurally one place to get it right |

## "Looks Done But Isn't" Checklist

- [ ] **Auto-create on Gmail auth:** Often missing the reconnect/re-auth no-op guard — verify by re-running OAuth consent on an already-linked account and confirming zero new `businesses` rows.
- [ ] **Auto-create on Gmail auth:** Often missing coverage for the other two account-creation paths (`createImapAccount`, `createMicrosoftAccount`) — verify by tracing the hook call site across all three functions, or confirming the scope exclusion is deliberate.
- [ ] **Slug→CRM-id unification:** Often tested only against the mailbox Postgres schema — verify by pointing the migration script at a real `~/cron/jobs.json` fixture with multiple profile homes and confirming every job resolves.
- [ ] **Entity list unification:** Often leaves one of the four sidecar consumers (`ProposalsView`, `CronPage` x2, `DailyBriefPage`) on the old hardcoded list — verify by grepping for zero remaining `ENTITY_OPTIONS`/`ENTITY_SLUGS` imports.
- [ ] **Business delete/merge:** Often ships delete without a dependents check — verify by attempting to delete a business that has at least one department, one linked account, and one referencing cron job, and confirming the UI surfaces (not silently drops) the conflict.
- [ ] **gbrain digest axis:** Often left as "future work" with no explicit decision recorded — verify a written decision exists (unify / derive / bridge) even if the mechanism ships later.
- [ ] **Cross-repo deploy:** Often verified only in one repo's dev environment — verify the mailbox-side change is live on `mailbox1` (via `/api/system/status` git_state, per root `CLAUDE.md`'s existing drift-check pattern) before the sidecar build lands on `agentbox2`.

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|-----------------|
| Duplicate business rows from a race or a re-auth bug (Pitfalls 2/4) | LOW | Merge via the merge operation from Pitfall 5 (reassign dependents to the surviving row, delete the duplicate) — cheap if the merge tooling was built; expensive manual SQL surgery if it wasn't |
| Orphaned cron job business references after a business delete (Pitfall 5/1) | MEDIUM | `jobs.json` retains the legacy slug field (per Pitfall 1's recommendation) as a fallback display value, so the job doesn't disappear from the UI — reattach to a business manually via the CronPage business picker |
| Sidecar deployed ahead of mailbox backend, CRM fields missing (Pitfall 9) | LOW | Roll the sidecar deploy back to the prior build (rsync from the last known-good artifact) or fast-follow the mailbox deploy — no data was written incorrectly, it's a read-path failure only |
| gbrain digest axis left unreconciled and now visibly disagrees with CRM (Pitfall 7) | MEDIUM | Run a one-off reconciliation pass: diff `entities.json`'s slugs against `businesses.name`, manually align, then implement the deferred mechanism decision |
| A missed `ENTITY_OPTIONS` consumer reverts to the stale list (Pitfall 10) | LOW | Delete `entities.ts` (forcing a compile error at the missed import) rather than patching the missed call site in isolation — surfaces any *other* missed spots too |

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|-------------------|---------------|
| 1. `job.business` lives in a flat file, not a DB row | Slug→CRM-id backfill phase (dedicated, before UI cutover) | Run the backfill script against a real multi-profile-home `jobs.json` fixture; confirm atomic write (temp+rename) under a simulated crash |
| 2. Auto-create not idempotent on re-auth | Auto-create hook phase | Re-run OAuth consent on an already-linked account; assert zero new `businesses` rows, reusing the `xmax=0`-style insert-vs-noop signal |
| 3. Name collision on auto-create | Auto-create hook phase | Connect two accounts whose derived names collide (same domain); assert one `businesses` row, both accounts linked to it |
| 4. Race on concurrent auto-create | Auto-create hook phase | Concurrency test: fire two auto-create requests for the same candidate name in parallel; assert exactly one row |
| 5. FK `ON DELETE SET NULL` orphans dependents | Business_id-on-accounts phase | Attempt delete on a business with dependents (department + account + referencing cron job); assert the UI blocks or requires explicit reassignment |
| 6. Auto-create hook missing on IMAP/Microsoft paths | Auto-create hook phase | Trace/grep the hook call site across `createAccount`/`createImapAccount`/`createMicrosoftAccount`; confirm shared helper or deliberate exclusion |
| 7. gbrain digest axis left as 3rd unreconciled source | CRM-unification phase (or a named sub-phase) | Confirm a written decision (unify/derive/bridge) exists in `CONTEXT.md`/`PLAN.md`, not just a TODO |
| 8. Default-on auto-create, no opt-out | Auto-create hook phase | UAT: connect a second mailbox for an existing company; confirm the flow offers "attach to existing" before committing a new row |
| 9. Cross-repo deploy drift (sidecar ahead of/behind mailbox) | Every phase touching both repos | Explicit ordering constraint in each such phase's plan + a post-deploy smoke probe against `/api/crm/businesses` from the sidecar side |
| 10. Missed `ENTITY_OPTIONS` consumer | Entity-list unification phase | Grep returns zero hits for `ENTITY_OPTIONS`/`ENTITY_SLUGS` outside a deleted/shim file |

## Sources

- Direct source inspection (HIGH confidence, primary source): `mailbox/dashboard/migrations/033-add-account-id-multi-account-v1-2026-05-28.sql`, `047-create-job-instances-v1-2026-06-07.sql` (departments/team/contacts tables), `048`/`052`/`053-*.sql` (businesses table + FK), `mailbox/dashboard/lib/oauth/google.ts`, `mailbox/dashboard/app/api/oauth/google/callback/route.ts`, `mailbox/dashboard/app/api/crm/businesses/route.ts` + `[id]/route.ts`, `mailbox/dashboard/lib/queries-accounts.ts`, `agentbox-sidecar/web/src/lib/entities.ts`, `agentbox-sidecar/web/src/lib/crm.ts`, `agentbox-sidecar/web/src/pages/CronPage.tsx`, `agentbox-sidecar/web/src/components/ScopeFilter.tsx`, `agentbox-sidecar/src/agentbox_sidecar/features/digest.py`, `agentbox-sidecar/src/agentbox_sidecar/features/cronext.py`, root `mailbox/CLAUDE.md` (STAQPRO-135 `xmax=0` pattern, migration-comment convention, deploy-drift `/api/system/status` pattern), `agentbox-sidecar/CLAUDE.md` (deploy mechanism, branch protection).
- General-pattern web research (MEDIUM confidence, cross-referenced against multiple independent sources, not project-specific): expand-contract / dual-write schema migration pattern (DeployHQ, PlanetScale, CodeOpinion "Database Migration Strategies" writeups); idempotent upsert via unique-constraint + `ON CONFLICT DO UPDATE` for reconnect/retry safety (Google Cloud "What is Idempotency," Zuplo idempotency-keys guide, Salesforce idempotent-record-writes docs); `ON DELETE SET NULL`/`CASCADE` as silent-failure-mode FK defaults requiring explicit application handling (general RDBMS design-pattern consensus, no single authoritative source — treat as engineering-judgment-level confidence, not verified against a canonical source).

---
*Pitfalls research for: MailBox One / AgentBOX fork — Unified Entities milestone*
*Researched: 2026-07-11*
