# Phase 5: Backend Data Model & Auto-Create - Context

**Gathered:** 2026-07-28
**Status:** Ready for planning

<domain>
## Phase Boundary

Every email account authorized on the AgentBOX appliance (any provider) is linked to a CRM
business automatically and idempotently, and every business carries a stable `slug` so
existing downstream references keep resolving.

Delivers: `mailbox.accounts.business_id` FK + backfill, a find-or-create auto-link helper
covering all three account-creation paths, `mailbox.businesses.slug` + legacy-slug seed.

**In scope (M5 requirements):** ENT-01, ENT-02, ENT-03, ENT-05, MAP-01, MAP-04, FILT-05.

**Explicitly NOT this phase:** manual business CRUD / rename / re-map / delete UI+API
(Phase 6), sidecar filter rewiring (Phase 7), gbrain digest bridge (Phase 8).

</domain>

<decisions>
## Implementation Decisions

### Auto-create trigger point (resolves the ROADMAP research disagreement)

- **D-01:** Hook the auto-link inside `dashboard/lib/queries-accounts.ts`, **not** in the
  OAuth callback. Codebase scout confirmed the ARCHITECTURE research was right and the
  STACK/PITFALLS recommendation was wrong: `dashboard/app/api/oauth/google/callback/route.ts`
  never creates an account — it only calls `saveToken()` against an `accountId` that already
  exists in the signed state. Hooking the callback would fire for zero new accounts.
- **D-02:** There is **no single choke point today** — `createAccount` (:310),
  `createImapAccount` (:128) and `createMicrosoftAccount` (:186) each own an independent
  `.insertInto('accounts')`. Introduce one internal `persistAccount()`-style helper inside
  `queries-accounts.ts` that all three delegate to, and attach the auto-link there. Do not
  scatter three copies of the hook.
- **D-03:** **The hook MUST cover the sentinel-adoption branch, not just INSERT.**
  `createImapAccount` / `createMicrosoftAccount` UPDATE the migration-033 seeded row
  (`primary@appliance.local`, `adopted: true`) instead of inserting when it is still
  unclaimed. An INSERT-only hook silently misses the first mailbox connected on every fresh
  appliance. Both the insert branch and the adopt branch must auto-link.
- **D-04:** Provider parity confirmed — auto-create applies to **all providers** (Gmail,
  IMAP, Microsoft), per ENT-01. This supersedes the narrower "Gmail authorized" language in
  the early research notes.
- **D-05:** Auto-create is silent (no connect-time prompt) and non-fatal: a failure to
  create/link the business must never fail the account connection. Log and leave
  `business_id` null; it is repairable in Phase 6.

### Naming + domain matching

- **D-06:** Business name resolution order: `accounts.display_label` when present, else the
  email domain. Matches the live data cleanly (all 6 live accounts have a display_label that
  is already the business name).
- **D-07:** **Domain matching skips free-mail domains.** Never attach two accounts to the same
  business merely because they share a public consumer domain (`gmail.com`, `googlemail.com`,
  `outlook.com`, `hotmail.com`, `live.com`, `yahoo.com`, `icloud.com`, `me.com`, `aol.com`,
  `proton.me`, `protonmail.com`, `msn.com`). Those accounts still get a business — named from
  `display_label` — they just never domain-match into an existing one. Rationale: Mike's
  personal inboxes are on gmail.com; without this rule the first one to connect would claim
  `gmail.com` and every later personal inbox would silently join that business.
  Keep the list in one exported constant so Phase 6/7 can reuse it.
- **D-08:** Idempotency per ENT-02: `INSERT … ON CONFLICT (name) DO NOTHING RETURNING id`
  plus a fallback `SELECT` when zero rows return. `businesses.name` is already globally
  UNIQUE (migration 053), so this is safe. Note `lib/crm/queries.ts:121 createBusiness()`
  is a bare `INSERT … RETURNING *` with **no conflict handling** — it will throw a unique
  violation if reused as-is. Add a get-or-create wrapper rather than changing the existing
  `createBusiness` contract (Phase 6 owns that surface).

### Backfill of live data

- **D-09:** Backfill links **all 6 live accounts**, creating the 3 missing businesses.
  Live state at time of decision — accounts: `mike@umbadvisors.com` (UMB Advisors),
  `mike@autocsr.com` (AutoCSR), `mike@altitudeguitar.com` (Altitude Guitar),
  `mike@jiffyautoglass.com` (Jiffy Auto Glass), `mike@elevatedadvisors.co` (Elevated
  Advisory), `mike@bonvillain-design.com` (Bonvillian Design). Existing businesses:
  `Altitude Guitar` (id 2), `UMB Advisors` (id 3), `AutoCSR` (id 4).
  → link 3 by name/domain match, create + link `Jiffy Auto Glass`, `Elevated Advisory`,
  `Bonvillian Design`. Result: zero unlinked accounts, so every entity filter is complete
  the moment Phase 7 lands.
- **D-10:** The backfill applies the *same* resolution rule as the runtime hook (display_label
  → domain, free-mail excluded). It is not a separate hand-written mapping table — one rule,
  exercised twice. This makes the backfill a live test of the hook logic.
- **D-11:** Backfill must be idempotent and re-runnable (`ADD COLUMN IF NOT EXISTS`,
  conflict-safe inserts) per the repo's migration convention.

### Slug

- **D-12:** `businesses.slug` is **frozen at creation** — generated once from the name, never
  regenerated on rename. Renaming is display-only. No cron job, digest reference, or job
  history can ever be orphaned by a rename. Accepted cost: a renamed business keeps its
  original slug internally (renaming "Bonvillian Design" → "BDS" keeps `bonvillain-design`).
  No separate slug-edit affordance in this phase.
- **D-13:** Slug generation = lowercase kebab of the name, ASCII-folded, non-alphanumerics
  collapsed to `-`, trimmed. Must be UNIQUE; on collision append `-2`, `-3`, … Column is
  `NOT NULL UNIQUE` after backfill (add nullable → backfill → set NOT NULL, or add with a
  generated default then constrain — planner's call).
- **D-14:** **Legacy slug seeding is one row, not eleven.** Live `~/.hermes/cron/jobs.json`
  on `agentbox3` holds 4 jobs; exactly one carries a business slug: `altitude`. The other 3
  have no business. Therefore seed `slug='altitude'` onto the existing `Altitude Guitar`
  business and stop. FILT-05's "file-aware operation with rollback" is over-engineered for
  this reality — verify `jobs.json` at plan time, but expect a single-row seed, not a file
  rewrite.
- **D-15:** The 11 hardcoded `ENTITY_OPTIONS` slugs in the sidecar
  (`heron, state, cde, krunchy, yes, future, umb, glue, myco, personal, unsorted`) are
  **Heron Labs' customer list, not Mike's businesses** — they are not seeded into the CRM.
  They die with `ENTITY_OPTIONS` in Phase 7. Note `altitude` is not even in that list, which
  confirms the hardcoded list was already drifted from live config.

### Claude's Discretion

- Exact migration split (one migration vs. separate FK / slug / backfill migrations).
- Whether `slug` lands NOT NULL immediately or after a backfill step.
- Naming of the internal shared helper and the free-mail-domain constant.
- Test layout, so long as the DB-gated `dbDescribe` idiom is honored.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Milestone definition
- `.planning/REQUIREMENTS.md` § "Milestone M5 — Unified Entities (AgentBOX fork)" — the 19
  `ENT/MAP/MANAGE/FILT/DIGEST` requirements and the locked milestone-level decisions.
- `.planning/ROADMAP.md` § "Phase 5: Backend Data Model & Auto-Create" — goal, the 5 success
  criteria, and the cross-repo deploy gate.
- `.planning/research/SUMMARY.md` — research synthesis; **note its hook-point recommendation
  is superseded by D-01/D-02/D-03 above**, which are grounded in the actual code.

### Code the phase touches
- `dashboard/lib/queries-accounts.ts` — the three account-creation functions
  (`createImapAccount:128`, `createMicrosoftAccount:186`, `createAccount:310`) and the
  sentinel-adoption branches. This is where the hook goes.
- `dashboard/lib/mail/connect-imap.ts:62` / `dashboard/lib/mail/connect-graph.ts:61` — the
  shared connect helpers that wrap the IMAP/Microsoft creates.
- `dashboard/lib/crm/queries.ts` — CRM data layer (raw `pg`, not Kysely).
  `createBusiness:121` has no conflict handling; `listBusinesses:114` is the read path.
- `dashboard/migrations/053-crm-businesses-v1-2026-06-05.sql` — `businesses` DDL, the
  `name UNIQUE` constraint, and the `departments.business_id ON DELETE SET NULL` pattern that
  `accounts.business_id` must mirror (MAP-01).
- `dashboard/migrations/033-add-account-id-multi-account-v1-2026-05-28.sql` — creates
  `accounts` and seeds the `primary@appliance.local` sentinel row that D-03 depends on.

### Conventions that gate the change
- `CLAUDE.md` § "Comment standard (migrations)" — every migration opens with WHAT / WHY /
  ROLLBACK. Schema-only unless explicitly a backfill (this phase *is* explicitly a backfill —
  say so in the header).
- `dashboard/test/fixtures/schema.sql` — canonical schema snapshot. **A new migration is
  invisible to codegen and CI unless the same DDL is mirrored into this file** (`accounts` at
  :1228, `businesses` at :1599, `departments` at :1606).
- `dashboard/migrations/runner.ts` — version = filename minus `.sql`; lexical sort; no down
  migrations. Next file is `057-`.
- `dashboard/lib/db/schema.ts` — **generated** by kysely-codegen. Adding `accounts.business_id`
  requires re-running `npm run db:codegen` (needs Docker) since `queries-accounts.ts` is Kysely.
  `lib/crm/queries.ts` is raw `pg` and does not.

### Downstream consumers (context only — not modified this phase)
- `~/.hermes/cron/jobs.json` on `agentbox3` — flat file, NOT Postgres. Source of the single
  live `altitude` slug (D-14).
- `UMB-Advisors/agentbox-sidecar` → `web/src/lib/entities.ts` — the `ENTITY_OPTIONS` list
  retired in Phase 7 (D-15).

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `departments.business_id` (migration 053): the exact FK shape `accounts.business_id` must
  mirror — nullable, `REFERENCES mailbox.businesses(id) ON DELETE SET NULL`. Copy it.
- `lib/crm/queries.ts:listBusinesses` / `createBusiness`: the CRM data layer to extend with a
  get-or-create, rather than opening a second access path to the same table.
- `dbDescribe` idiom (`test/helpers/db.ts`, used at `test/lib/queries-accounts.test.ts:29`):
  DB-touching suites skip rather than fail when no Postgres is present.
- `test/lib/queries-accounts.test.ts` already exercises `createAccount` against real Postgres —
  the natural home for the auto-link assertions.

### Established Patterns
- Migrations are plain SQL deltas on an app-created base, applied by `runner.ts`, tracked in
  `mailbox.migrations` by filename. Idempotent (`IF NOT EXISTS`) throughout.
- `lib/crm/*` uses raw `pg` via `getPool()`; `lib/queries-accounts.ts` uses Kysely. Both are
  legitimate — do not "unify" them as a side quest.
- CI (`.github/workflows/ci.yml`) applies `test/fixtures/schema.sql` to a Postgres service,
  then `lint → typecheck → test`. Lint is `biome check .` and runs FIRST — run the real CI
  order locally before pushing.

### Integration Points
- `POST /api/accounts` → `createAccount` (Gmail bare-row registration from the Accounts
  settings UI, `AccountsSettings.tsx:78`).
- `POST /api/accounts/imap` + `POST /api/internal/onboarding/imap-connect` → `connectImap()`.
- `POST /api/accounts/microsoft` + `POST /api/internal/onboarding/graph-connect` →
  `connectGraph()`.
- All five funnel into the three `queries-accounts.ts` writers — which is why the shared
  internal helper (D-02) is the correct seam.

### Landmines
- **Tests raw-INSERT into `mailbox.accounts`** (`test/lib/queries-followup.test.ts:49`,
  `test/routes/persona.test.ts:91`, `test/lib/gmail-p3.test.ts:166`) — they bypass the app
  hook entirely. Do not add a DB trigger expecting those rows to be linked, and do not assume
  test fixtures will carry `business_id`.
- `connect-imap.test.ts` / `connect-graph.test.ts` **fully mock `@/lib/queries-accounts`** —
  they will NOT catch a broken auto-link. Coverage has to live at the `queries-accounts` layer.
- `departments.name` is **globally UNIQUE**, not unique-per-business. Not this phase's
  problem, but it blocks any "auto-create a General department per business" idea in Phase 6.
- Migration header comments disagree with filenames (052 says "047", 053 says "048", 056 says
  "050"). Files were renumbered during the PR #239 reconciliation without updating headers.
  **Trust the filename.** Write the new header with the correct number.
- CI does not currently run `db:codegen:verify` despite the script comment claiming it does —
  schema drift will not be caught automatically. Run it by hand.

</code_context>

<specifics>
## Specific Ideas

- Mike's framing throughout M5: the CRM is the single source of truth, and entities should
  "come into existence" from connecting an inbox rather than being a separate hand-maintained
  list. Phase 5 is the half that makes that true at the data layer.
- The end-state he described: auto-created entity → renameable → departments addable → and
  the account re-mappable to a different business if the guess was wrong. Phase 5 delivers the
  auto-create + link; Phase 6 delivers the editing surface. Don't half-build Phase 6 here.

</specifics>

<deferred>
## Deferred Ideas

- **Full business merge** (combine two businesses and re-point all references) — named
  out-of-scope for all of M5.
- **Two-way gbrain ↔ CRM sync** — M5 is one-way (CRM → digest) only, Phase 8.
- **Connect-time "attach to existing or create new?" prompt** — explicitly rejected at the
  milestone level in favor of silent + editable (ENT-05).
- **Per-business department uniqueness** — `departments.name` being globally unique is a real
  constraint that will bite Phase 6 if departments are ever auto-created. Flagged, not fixed.
- **Editable slugs** — D-12 freezes slugs with no edit affordance. If that becomes painful,
  it is a Phase 6 addition, not a Phase 5 one.

</deferred>

---

*Phase: 5-Backend Data Model & Auto-Create*
*Context gathered: 2026-07-28*
