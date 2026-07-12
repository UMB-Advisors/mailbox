# Stack Research

**Domain:** Wiring milestone — entity unification on an existing Next.js/Kysely/Postgres dashboard + a separate React/FastAPI sidecar
**Researched:** 2026-07-11
**Confidence:** HIGH (all findings verified directly against the live repo code, not inferred)

## Headline Answer

**No new runtime dependency is needed anywhere in this milestone.** Every piece — auto-create-on-auth, the account↔business link, and the entity-filter unification — is wiring across four modules that already exist and already do 90% of this job:

- `dashboard/lib/queries-accounts.ts` (`createAccount`, `createImapAccount`)
- `dashboard/lib/oauth/google.ts` (`saveToken`, the `google_gmail` OAuth callback branch)
- `dashboard/lib/crm/queries.ts` (`createBusiness`, already has `Business`/`Department` types + `departments.business_id` precedent)
- `agentbox-sidecar/web/src/lib/crm.ts` (`crmApi.listBusinesses()`, already fully wired end-to-end)

The only "stack decision" left is a schema micro-decision (column vs. link table — see below) and where exactly to place three call sites of one new idempotent helper function.

## Recommended Stack

### Core Technologies (unchanged — reuse as-is)

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| Kysely | ^0.28.16 (already installed) | Typed query builder for the new `accounts.business_id` FK + all reads | `Accounts`, `Businesses`, `Departments` are all already present in the generated `dashboard/lib/db/schema.ts` DB type (confirmed by grep — `businesses: Businesses`, `departments: Departments`, `accounts: Accounts` all exist at lines 515-535). Adding one nullable column is a `kysely-codegen` re-run away, no new tooling. |
| `pg` (raw Pool) | ^8.13.1 (already installed) | CRM query layer | `dashboard/lib/crm/queries.ts` currently uses raw `getPool()` (its own header comment says CRM tables predate the Kysely codegen pass) even though the type IS now in `schema.ts` — safe to keep as-is for this milestone; not worth a refactor mid-feature. Note only, not a blocker. |
| plain `.sql` migrations | n/a | Add `accounts.business_id` column | `dashboard/migrations/NNN-*.sql` + `runner.ts` — exact same mechanism as the two migrations (052/053) that built the CRM tables. No new migration tool. |
| zod | ^4.4.1 (already installed) | Validate the new "assign account to business" request body | `dashboard/lib/schemas/accounts.ts` already has `accountCreateSchema`; extend with an `accountBusinessAssignSchema` the same way. |
| React (plain hooks) | 18.x (already installed, sidecar) | Replace hardcoded `ENTITY_OPTIONS` with live CRM data | Confirmed via grep: the sidecar has **no** React Query / SWR dependency anywhere in `web/package.json`. `TeamPage.tsx` and its siblings already fetch CRM data with plain `useState`/`useEffect`. A `useBusinesses()` hook in that same style is the right fit — adding TanStack Query for one list endpoint would be a net-new dependency for zero benefit. |

### Supporting Libraries

None needed. Specifically ruled out:

| Considered | Verdict | Why not |
|---|---|---|
| `slugify` / similar npm package | Not needed | Deriving a business display name from an email domain (`heronlabsinc.com` → `Heron Labs`) is a 10-line regex + title-case helper, not worth a dependency. Put it in a new `dashboard/lib/crm/naming.ts` (or inline in the auto-provision helper below). |
| `@tanstack/react-query` / `swr` (sidecar) | Not needed | See above — no existing usage, would be inconsistent with the rest of `web/src/pages/*`. |
| A generic "auth webhook" / event-bus library | Not needed | The auto-create-business trigger is same-process, same-request — a direct function call from the existing route handlers, not an event that needs pub/sub. |

### Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| `kysely-codegen` (already devDep, ^0.20.0) | Regenerate `lib/db/schema.ts` after the `accounts.business_id` migration | Run `npm run db:codegen` after the migration; CI's `db:codegen:verify` will catch drift if forgotten — no new step, existing gate. |

## Installation

```bash
# No installation step. Zero new packages for this milestone.
```

## The One Real Schema Decision: Column vs. Link Table

**Recommendation: nullable `business_id` column on `mailbox.accounts`, not a link table.**

```sql
ALTER TABLE mailbox.accounts
  ADD COLUMN business_id INTEGER
  REFERENCES mailbox.businesses(id) ON DELETE SET NULL;

CREATE INDEX accounts_business_id_idx ON mailbox.accounts (business_id);
```

Why this and not a link table:
- **Cardinality matches the spec.** The milestone's own requirement is "an account maps to one business, re-mappable later" (auto-create → rename → re-map to a *different* business). That is a one-to-many (one business, many accounts), which a nullable FK column expresses directly. A link table is the right tool for many-to-many (one Gmail inbox serving multiple businesses simultaneously) — that is explicitly not a stated requirement, and nothing else in the schema hints at it.
- **It's the exact precedent already in the codebase.** `mailbox.departments.business_id` (migration `053-crm-businesses-v1-2026-06-05.sql`) is the identical pattern: nullable `INTEGER REFERENCES mailbox.businesses(id) ON DELETE SET NULL`, added to an existing table that predates the CRM concept. Copying it onto `accounts` keeps the schema self-consistent — a reviewer who already understands `departments.business_id` understands `accounts.business_id` for free.
- **`ON DELETE SET NULL` matches existing product behavior.** Deleting a business shouldn't orphan-delete the Gmail account or its mail history; it should just unassign it, exactly like a department losing its business today.
- **Re-mapping is a single `UPDATE`,** not a join-table insert/delete pair — simpler for the "Settings > Accounts" UI action, and simpler for the CRM API surface (`PATCH /api/accounts/[id] { business_id }`, mirroring the existing `PATCH /api/crm/departments/[id] { business_id }` pattern already live in `dashboard/app/api/crm/departments/[id]/route.ts`).

If a genuine multi-business-per-inbox need shows up later (e.g., one shared ops inbox serving two brands), that is a distinct future migration — don't build the join table pre-emptively for a requirement that isn't there.

## Auto-Create Hook Placement (the actual design work of this milestone)

This is wiring, but *where* to wire it matters, so it's called out explicitly since it's the one place a wrong guess costs real rework.

**Key finding: there is no single existing choke point that fires for "a Gmail account got authorized."** Two separate code paths create/attach a `mailbox.accounts` row today, and they behave differently:

1. **Multi-account "connect a new inbox" flow** — `POST /api/accounts` → `createAccount()` in `dashboard/lib/queries-accounts.ts` inserts the registry row (any provider: gmail/imap/microsoft) *before* any Gmail OAuth consent happens. This is provider-agnostic and always fires for a genuinely new account.
2. **First-boot onboarding Gmail flow** — there is **no** `createAccount()` call at all. The dashboard relies on the single account row seeded by migration 033 (`primary@appliance.local` sentinel, or already-renamed) and the OAuth consent only ever writes to `mailbox.oauth_tokens` via `saveToken()` in `dashboard/lib/oauth/google.ts`. Confirmed by grep — no `createAccount`/`createImapAccount` reference anywhere under `dashboard/app/onboarding/` or `dashboard/lib/onboarding/`.
3. **IMAP connect flow** — `POST /api/internal/onboarding/imap-connect` (`mode:'save'`) → `createImapAccount()`, a third, separate insert/adopt path (adopts the sentinel default row in place, or inserts non-default).

So "auto-create a business when a Gmail account is authorized" has to hook the actual **authorization** moment for the first-boot case (there's no account-creation event to hang off), but should hook **account creation** for the multi-account and IMAP cases (there's no separate "authorization" event for IMAP — the password check *is* the auth). Concretely:

**Recommendation: one small idempotent helper, called from three places.**

```ts
// dashboard/lib/crm/auto-provision.ts (new, ~30 lines)
export async function ensureBusinessForAccount(
  accountId: number,
  opts: { preferredName?: string | null; email: string },
): Promise<void> {
  // no-op if this account is already linked — never clobber a rename/re-map
  const existing = await getAccountBusinessId(accountId); // new 1-line helper in queries-accounts.ts
  if (existing != null) return;

  const name = deriveBusinessName(opts.preferredName, opts.email); // domain -> "Heron Labs" style helper
  const business = await findOrCreateBusinessByName(name); // new fn in crm/queries.ts — reuses existing
                                                            // business row if the domain was seen before
                                                            // (two inboxes @ same company), else createBusiness()
  await setAccountBusinessId(accountId, business.id); // new 1-line helper in queries-accounts.ts
}
```

Call sites:
- **`POST /api/accounts` route**, right after `createAccount()` succeeds — covers the multi-account "connect new inbox" flow for every provider, before any Gmail OAuth even happens (so the business + rename UI is usable immediately, matching "auto-created entities are renameable").
- **`POST /api/internal/onboarding/imap-connect`**, `mode:'save'` branch, right after `createImapAccount()` — covers IMAP, which has no separate OAuth step.
- **`GET /api/oauth/google/callback`**, inside the existing `if (verified.provider === 'google_gmail')` branch, right after `saveToken()` succeeds — covers the first-boot case where no account-creation call exists, and is also what fires for a fresh multi-account Gmail connect (idempotent no-op there since call site #1 already linked it).

The idempotency guard (`existing != null → return`) is what makes calling this from three places safe rather than sloppy — it also directly implements "re-mapping" safety: once an operator manually re-maps an account to a different business, no future OAuth reconnect/refresh silently reverts it.

**Naming collision handling:** `mailbox.businesses.name` is `NOT NULL UNIQUE` (migration 053). Two Gmail inboxes on the same domain (`ops@heronlabsinc.com` + `sales@heronlabsinc.com`) must not throw a 500 on the second one — `findOrCreateBusinessByName` should look up by name first (case-insensitive) and attach to the existing business, not insert-and-catch. This is the correct behavior for the product anyway — both inboxes really are the same company.

## Entity Filter Unification (sidecar)

**No new dependency; replace `ENTITY_OPTIONS` with a `useBusinesses()` hook, not a rewrite.**

- `agentbox-sidecar/web/src/lib/crm.ts` already exports `crmApi.listBusinesses()` fully wired to `GET /dashboard/api/crm/businesses` (same-origin, session-header handled). Nothing to build there.
- Add `web/src/hooks/useBusinesses.ts` — plain `useState`/`useEffect` wrapping `crmApi.listBusinesses()`, matching the existing pattern already used in `TeamPage.tsx`. Returns `{ businesses, loading, error }`.
- Swap the three confirmed consumers of the hardcoded list — `CronPage.tsx`, `DailyBriefPage.tsx`, `ProposalsView.tsx` (all import `ENTITY_OPTIONS`/`entityLabel` from `web/src/lib/entities.ts`, confirmed via grep) — to consume `useBusinesses()` instead. `web/src/lib/entities.ts` itself gets deleted once the last consumer is migrated — its own header comment already says "the backend stays authoritative... this static copy avoids a network round-trip for what is a fixed, rarely-changing list" — that tradeoff is exactly what this milestone reverses.
- Departments follow the same shape — `web/src/lib/departments.ts` already exists as a sibling client file; confirm during planning whether it already reads live or is also hardcoded (not opened in this research pass — flag for phase-plan verification, not a stack question).

## Out of Scope for This Stack Question (flag for roadmap, not a dependency decision)

The **gbrain digest "entity" axis** (`AGENTBOX_ENTITY_SLUGS` env / `$HERMES_HOME/entities.json`) lives entirely on the Python/FastAPI side (`agentbox_sidecar/features/digest.py`), a completely different language and process from the Postgres/Kysely CRM. Reconciling it is a genuine architecture decision (does `digest.py` call the dashboard's `/api/crm/businesses` over HTTP at read time, or does something export CRM businesses into `entities.json` on a schedule/webhook?) — but it is **not a new-dependency question**: whichever direction is chosen, the Python side already has an HTTP client available (it talks to hermes upstream today), so no new library is implied either way. This belongs in `discuss-phase`/`plan-phase` for whichever roadmap phase covers it, not in this STACK research.

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|--------------------------|
| Nullable `accounts.business_id` column | `mailbox.account_business_links` join table | Only if an account must belong to >1 business simultaneously — not a current requirement; revisit if that need materializes. |
| Hook in 3 existing route handlers (`createAccount`, `createImapAccount`, OAuth callback) | A generic Postgres `AFTER INSERT` trigger on `accounts` (mirroring the `state_transitions` trigger pattern already used elsewhere in this codebase) | Triggers are this codebase's convention for pure audit/denormalization (see `state_transitions`, `inbox_messages` sync triggers) where the write is deterministic and needs zero business logic. Auto-provisioning a business needs a name-derivation decision + a find-or-create branch — real logic that's easier to read, test, and reason about in TypeScript than in a `plpgsql` function. Recommend app-layer for this one. |
| `useBusinesses()` plain hook (sidecar) | `@tanstack/react-query` | If the sidecar later adds several more CRM-backed lists with caching/refetch/mutation needs across many pages, react-query would pay for itself. For unifying 3 existing consumers of one list, it's premature. |

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| Deriving business identity from `oauth_tokens` / OAuth scope data alone | `oauth_tokens` is keyed `(provider, account_id)` and holds grant metadata, not identity — it was never meant to be a join key to CRM entities, and IMAP/Microsoft accounts don't have a Google OAuth row at all | `mailbox.accounts.business_id`, populated by the app-layer helper regardless of transport |
| A link table "just in case" | Adds a join to every business-scoped account query (queue filters, settings page) for a cardinality that doesn't exist yet | The nullable column; revisit only if multi-business-per-inbox becomes real |
| Hardcoding the auto-create hook only in the OAuth callback | Misses IMAP/Microsoft accounts entirely, and misses the multi-account "register now, connect Gmail later" flow where the operator should see the (auto-named) business immediately | The 3-call-site idempotent helper described above |

## Stack Patterns by Variant

**If a future account has no resolvable email domain worth naming a business after (e.g., a generic `gmail.com` personal address):**
- Fall back to `display_label` if the operator supplied one at connect time, else a generic `"<email> (unassigned)"` placeholder name, never block account creation on naming ambiguity.
- Because the whole point of "auto-create, then rename" is that the operator fixes up the name later — the auto-create step must never fail or block onboarding over a naming edge case.

**If the sidecar's `departments.ts` client turns out to already be hardcoded like `entities.ts` was:**
- Apply the exact same `useBusinesses()`-style fix (`useDepartments()`), sourced from the already-existing `crmApi.listDepartments()`.
- Because the unification requirement in scope ("every business/department/entity filter/dropdown reads from the one CRM source") explicitly includes departments, not just businesses.

## Version Compatibility

| Package | Compatible With | Notes |
|---------|------------------|-------|
| `kysely@^0.28.16` | Postgres 17-alpine, `kysely-codegen@^0.20.0` | No version bump required; a nullable INTEGER FK column is fully within current codegen support (identical shape to `departments.business_id`, already codegen'd successfully). |
| Sidecar `web/` React 18.x | Existing `crmApi` client (`web/src/lib/crm.ts`) | No compatibility risk — `crmApi.listBusinesses()` is already exercised in production by `BusinessesPage.tsx`; the new hook just wraps the same call for read-only consumers. |

## Sources

- Direct code inspection (HIGH confidence — primary source, not inferred):
  - `dashboard/migrations/033-add-account-id-multi-account-v1-2026-05-28.sql` — `mailbox.accounts` schema + seeding
  - `dashboard/migrations/037-...`, `040-...`, `046-...` — `accounts.provider`, `provider_config`, `provider_secret_enc`, provider CHECK broadening
  - `dashboard/migrations/052-create-crm-tables-v1-2026-06-04.sql`, `053-crm-businesses-v1-2026-06-05.sql` — CRM table shapes, the `departments.business_id` precedent
  - `dashboard/lib/queries-accounts.ts` — `createAccount`, `createImapAccount`, `getDefaultAccountId`, `resolveIngestAccountId`
  - `dashboard/lib/oauth/google.ts` — `saveToken`, `buildConsentUrl`, `verifyState`, provider list including `google_gmail`
  - `dashboard/app/api/oauth/google/callback/route.ts`, `dashboard/app/api/oauth/google/[provider]/connect/route.ts` — the actual authorize/callback flow
  - `dashboard/app/api/accounts/route.ts` — `POST /api/accounts` registry-only connect flow
  - `dashboard/lib/crm/queries.ts` — `createBusiness`, `Business`/`Department` types
  - `dashboard/lib/db/schema.ts` — confirms `accounts`, `businesses`, `departments` all present in the generated Kysely `DB` type
  - `agentbox-sidecar/web/src/lib/entities.ts`, `agentbox-sidecar/web/src/lib/crm.ts` — the hardcoded list vs. the already-wired CRM client
  - `agentbox-sidecar/web/src/pages/{CronPage,DailyBriefPage}.tsx`, `web/src/components/ProposalsView.tsx` — confirmed `ENTITY_OPTIONS` consumers via grep
  - `agentbox-sidecar/src/agentbox_sidecar/features/digest.py` — gbrain entity axis source (env/`entities.json`)
  - Root `CLAUDE.md` and `dashboard/CLAUDE.md` — live version pins (Kysely ^0.28.16, `pg` ^8.13.1, zod ^4.4.1, Next 14.2.35, Tailwind v4)

---
*Stack research for: MailBox One / AgentBOX fork — "Unified Entities" milestone*
*Researched: 2026-07-11*
