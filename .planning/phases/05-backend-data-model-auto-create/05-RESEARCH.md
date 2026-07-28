# Phase 5: Backend Data Model & Auto-Create - Research

**Researched:** 2026-07-28
**Domain:** Postgres schema migration + idempotent find-or-create + TypeScript slug generation, inside the `mailbox` repo's Kysely/raw-pg split
**Confidence:** HIGH (schema mechanics, idempotency pattern, migration ordering — all verified against this repo's own code and Postgres semantics) / MEDIUM (agentbox3 live-DB deploy specifics — inferred from CLAUDE.md deploy docs written for `mailbox1`, not independently re-verified against agentbox3 this session)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** Hook the auto-link inside `dashboard/lib/queries-accounts.ts`, **not** in the OAuth callback. `dashboard/app/api/oauth/google/callback/route.ts` never creates an account — it only calls `saveToken()` against an `accountId` that already exists. Hooking the callback would fire for zero new accounts.
- **D-02:** There is **no single choke point today** — `createAccount` (:310), `createImapAccount` (:128) and `createMicrosoftAccount` (:186) each own an independent `.insertInto('accounts')`. Introduce one internal `persistAccount()`-style helper inside `queries-accounts.ts` that all three delegate to, and attach the auto-link there. Do not scatter three copies of the hook.
- **D-03:** **The hook MUST cover the sentinel-adoption branch, not just INSERT.** `createImapAccount` / `createMicrosoftAccount` UPDATE the migration-033 seeded row (`primary@appliance.local`, `adopted: true`) instead of inserting when it is still unclaimed. An INSERT-only hook silently misses the first mailbox connected on every fresh appliance. Both branches must auto-link.
- **D-04:** Provider parity confirmed — auto-create applies to **all providers** (Gmail, IMAP, Microsoft), per ENT-01.
- **D-05:** Auto-create is silent (no connect-time prompt) and non-fatal: a failure to create/link the business must never fail the account connection. Log and leave `business_id` null; it is repairable in Phase 6.
- **D-06:** Business name resolution order: `accounts.display_label` when present, else the email domain.
- **D-07:** Domain matching skips free-mail domains (`gmail.com`, `googlemail.com`, `outlook.com`, `hotmail.com`, `live.com`, `yahoo.com`, `icloud.com`, `me.com`, `aol.com`, `proton.me`, `protonmail.com`, `msn.com`). Those accounts still get a business — named from `display_label` — they just never domain-match into an existing one. Keep the list in one exported constant so Phase 6/7 can reuse it.
- **D-08:** Idempotency per ENT-02: `INSERT … ON CONFLICT (name) DO NOTHING RETURNING id` plus a fallback `SELECT` when zero rows return. `businesses.name` is already globally UNIQUE (migration 053/"048"). Note `lib/crm/queries.ts:121 createBusiness()` is a bare `INSERT … RETURNING *` with no conflict handling — add a get-or-create wrapper rather than changing that existing contract (Phase 6 owns that surface).
- **D-09:** Backfill links all 6 live accounts, creating the 3 missing businesses (Jiffy Auto Glass, Elevated Advisory, Bonvillian Design), matching the 3 existing ones (Altitude Guitar id 2, UMB Advisors id 3, AutoCSR id 4) by name/domain.
- **D-10:** The backfill applies the *same* resolution rule as the runtime hook (display_label → domain, free-mail excluded) — one rule, exercised twice, not a hand-written mapping table.
- **D-11:** Backfill must be idempotent and re-runnable (`ADD COLUMN IF NOT EXISTS`, conflict-safe inserts).
- **D-12:** `businesses.slug` is frozen at creation — generated once from the name, never regenerated on rename.
- **D-13:** Slug generation = lowercase kebab of the name, ASCII-folded, non-alphanumerics collapsed to `-`, trimmed. Must be UNIQUE; on collision append `-2`, `-3`, … Column is `NOT NULL UNIQUE` after backfill (add nullable → backfill → set NOT NULL, or add with a generated default then constrain — planner's call).
- **D-14:** Legacy slug seeding is one row, not eleven — seed `slug='altitude'` onto the existing `Altitude Guitar` business and stop. Verify `jobs.json` at plan time but expect a single-row seed, not a file rewrite.
- **D-15:** The 11 hardcoded sidecar `ENTITY_OPTIONS` slugs are Heron Labs' customer list, not Mike's businesses — not seeded into the CRM. They die with `ENTITY_OPTIONS` in Phase 7.

### Claude's Discretion

- Exact migration split (one migration vs. separate FK / slug / backfill migrations).
- Whether `slug` lands NOT NULL immediately or after a backfill step.
- Naming of the internal shared helper and the free-mail-domain constant.
- Test layout, so long as the DB-gated `dbDescribe` idiom is honored.

### Deferred Ideas (OUT OF SCOPE)

- Full business merge (combine two businesses and re-point all references) — out-of-scope for all of M5.
- Two-way gbrain ↔ CRM sync — M5 is one-way (CRM → digest) only, Phase 8.
- Connect-time "attach to existing or create new?" prompt — explicitly rejected at the milestone level in favor of silent + editable (ENT-05).
- Per-business department uniqueness — `departments.name` being globally unique is a real constraint that will bite Phase 6 if departments are ever auto-created. Flagged, not fixed.
- Editable slugs — D-12 freezes slugs with no edit affordance. If that becomes painful, it is a Phase 6 addition.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| ENT-01 | Authorizing/connecting an account (any provider) auto-creates a CRM business for it by default, named from `display_label` else email domain. | See "Where the shared helper goes" + "Slug generation" — `persistAccountLink()` covers all 3 creators. |
| ENT-02 | Auto-create is idempotent — re-auth/reconnect never creates a duplicate business. | See "Idempotent find-or-create in Postgres" — exact `ON CONFLICT` SQL + `xmax=0` note. |
| ENT-03 | Domain match — account attaches to an existing business for its email domain rather than creating a new one. | See "Domain matching + free-mail exclusion" section. |
| ENT-05 | Auto-create is silent; failure must never fail account connection. | See "Transaction boundary" — auto-link runs post-commit, wrapped in try/catch, logs and continues. |
| MAP-01 | New nullable `mailbox.accounts.business_id` FK → `businesses.id`, `ON DELETE SET NULL`. | See "Migration mechanics" — exact DDL mirroring `departments.business_id`. |
| MAP-04 | Migration backfills the 6 live accounts against 3 live businesses by domain match, leaving unmatched unlinked. | See "Backfill" subsection — SQL shape + idempotency. |
| FILT-05 | `slug` column + legacy-slug seed so `jobs.json`'s `altitude` reference keeps resolving. | See "Slug generation" + "Legacy slug seed" — single-row seed, `jobs.json` verify command given. |
</phase_requirements>

## Summary

This phase is a schema + application-logic change entirely inside `dashboard/`, touching three surfaces: (1) one new migration file that adds `accounts.business_id` and `businesses.slug`, mirrors it into `test/fixtures/schema.sql`, and regenerates `lib/db/schema.ts`; (2) a new internal helper in `dashboard/lib/queries-accounts.ts` that all three account-creation paths (`createAccount`, `createImapAccount`, `createMicrosoftAccount` — including their sentinel-adopt UPDATE branches) funnel through; (3) a small `lib/crm/business-link.ts`-style module holding the free-mail-domain constant, slug generator, and get-or-create-business logic that both the runtime hook and the backfill migration's equivalent TypeScript reuse.

The three creator functions are Kysely-based (`getKysely()`), while the CRM tables (`businesses`, `departments`) are queried through raw `pg` via `lib/crm/queries.ts` (`getPool()`) — this split is intentional per the 2026-05-01 ORM ADR (CRM tables aren't in Kysely's codegen scope) and this phase does not change it. The auto-link helper will therefore mix both clients: Kysely for the accounts write, raw `pg` for the businesses find-or-create — acceptable because both share the same underlying `pg.Pool` (see `lib/db.ts:getKysely()` wraps `getPool()`).

The idempotent find-or-create pattern for `businesses.name UNIQUE` is the standard Postgres upsert-without-overwrite idiom: `INSERT ... ON CONFLICT (name) DO NOTHING RETURNING id`, falling back to a `SELECT id FROM businesses WHERE name = $1` when zero rows return (a conflict on `DO NOTHING` returns no row, by design — this is documented Postgres behavior, not a gap to patch around). On this single-appliance, low-concurrency appliance (5-minute-interval single background job + occasional operator-driven connects), true concurrent-insert races on the same business name are effectively impossible, but the insert-then-select-on-conflict pattern is correct regardless of concurrency and costs nothing extra to implement correctly, so there's no reason to cut the corner.

The slug column should be added nullable, backfilled via a TypeScript-computed value (not a SQL-only ASCII-fold, because Postgres has no built-in slugify and hand-rolling one in `plpgsql` is more fragile than doing it once in Node during the migration script or as a `DO $$ ... $$` block using `regexp_replace`), then set `NOT NULL` — all three steps can live in one migration file's single transaction since Postgres migrations here are wrapped in `BEGIN`/`COMMIT` by `runner.ts`, and `ADD COLUMN` + `UPDATE` + `SET NOT NULL` all participate in the same DDL transaction safely in Postgres (no `CONCURRENTLY` requirement at this table's tiny size — single digits of rows).

**Primary recommendation:** One migration file (057) does FK + slug column + backfill in a single transaction, mirrored into `test/fixtures/schema.sql`; one new exported helper `linkAccountToBusiness()` in a new `dashboard/lib/crm/auto-link.ts` module (imported into `queries-accounts.ts`) is called from all three creators (both insert and adopt branches) inside their own try/catch so a linking failure never propagates; slug generation and the free-mail-domain list live in the same new module for Phase 6/7 reuse.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| `accounts.business_id` schema + FK | Database / Storage | — | Pure DDL; mirrors `departments.business_id` exactly. |
| Business find-or-create (idempotent) | API / Backend (`dashboard/lib/crm/`) | Database / Storage (UNIQUE constraint enforces correctness even if app logic races) | Business logic belongs in the data-access layer used by both the runtime hook and the backfill script — the DB constraint is the safety net, not the primary mechanism. |
| Auto-link hook (3 account creators) | API / Backend (`dashboard/lib/queries-accounts.ts`) | — | D-01/D-02 confirmed: no browser or frontend-server involvement: this is server-side account-creation logic, same process as the Next.js API route handlers that call it. |
| Slug generation | API / Backend (`dashboard/lib/crm/`) | — | Deterministic pure function; no DB round-trip needed except collision-check SELECT. |
| Free-mail-domain exclusion list | API / Backend (`dashboard/lib/crm/`) | — | Shared constant, no UI surface this phase (Phase 6/7 may read it for display, but that's out of scope here). |
| Legacy slug seed for `jobs.json` compat | Database / Storage (one-row UPDATE) | OS-registered state (`jobs.json` on agentbox3, read-only reference, not mutated) | The seed makes the DB resolvable by the string `jobs.json` already contains; `jobs.json` itself is not touched this phase. |

## Standard Stack

### Core

No new dependencies required. Everything in this phase is buildable with what's already in `dashboard/package.json`:

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `kysely` | `^0.28.16` [VERIFIED: dashboard/package.json] | Typed queries for `accounts.business_id` reads/writes | Existing project convention (2026-05-01 ADR); `queries-accounts.ts` is already Kysely. |
| `pg` | `^8.13.1` [VERIFIED: dashboard/package.json] | Raw SQL for `businesses`/find-or-create (CRM tables aren't in Kysely codegen scope) | `lib/crm/queries.ts` precedent; do not add a second ORM surface. |
| `kysely-codegen` | `^0.20.0` [VERIFIED: dashboard/package.json] (devDep) | Regenerate `lib/db/schema.ts` after adding `accounts.business_id` | Required because `queries-accounts.ts` reads/writes via Kysely; the new column must appear in the generated `DB` type or `.set({ business_id })` will not typecheck. |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| Node built-in (no lib) | n/a | ASCII-fold + kebab-slug function | A hand-rolled ~15-line function is simpler and has zero supply-chain risk versus adding `slugify`/`transliteration` for a single, well-understood transform (lowercase, strip diacritics via `.normalize('NFD').replace(/[̀-ͯ]/g, '')`, collapse non-alphanumerics to `-`, trim). No package needed. |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Hand-rolled slugify | `slugify` (npm) or `transliteration` (npm) | Adds a dependency + Package Legitimacy Gate overhead for a function that's ~15 lines and fully deterministic; the repo's CLAUDE.md convention favors hand-rolled helpers under `lib/` over pulling in single-purpose packages (see `lib/urgency.ts`, `lib/classification/preclass.ts` — all hand-rolled string logic, no npm string-utility deps anywhere in the stack). Recommend hand-rolled. |
| `ON CONFLICT DO NOTHING` + fallback SELECT | `ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id` (the "upsert that always returns a row" trick) | Also race-safe and always returns exactly one row (avoiding the two-round-trip fallback), but it performs a no-op UPDATE on every conflict, which bumps nothing here since there's no `updated_at` trigger on conflict-only paths — however it does needlessly write a WAL record on every idempotent re-connect. Given D-08 already locks the `DO NOTHING` + fallback pattern by name, do not deviate; note this only as an alternative for awareness. |

**Installation:** none — no new packages.

**Version verification:** All three libraries above are already pinned and installed in this repo (`dashboard/node_modules/`, `package-lock.json`); no external registry check needed since nothing new is added. `kysely-codegen` regeneration requires Docker locally (per CLAUDE.md) — flag as an Environment Availability item below.

## Package Legitimacy Audit

**Not applicable — this phase adds zero new npm packages.** No `package-legitimacy check` run was needed; every library used (`kysely`, `pg`, `kysely-codegen`) is already an audited, installed dependency of `dashboard/package.json`, verified present via direct file read this session `[VERIFIED: dashboard/package.json]`.

**Packages removed due to SLOP verdict:** none.
**Packages flagged as suspicious [SUS]:** none.

## Architecture Patterns

### System Architecture Diagram

```
Any of 5 HTTP entry points
  POST /api/accounts                       (Gmail bare-row registration)
  POST /api/accounts/imap
  POST /api/internal/onboarding/imap-connect
  POST /api/accounts/microsoft
  POST /api/internal/onboarding/graph-connect
        │
        ▼
  connectImap() / connectGraph()  (dashboard/lib/mail/connect-{imap,graph}.ts)
  [Gmail path calls createAccount() directly from its route handler]
        │
        ▼
  createImapAccount() / createMicrosoftAccount() / createAccount()
  (dashboard/lib/queries-accounts.ts)
        │
        ├─ sentinel unclaimed? ──► UPDATE accounts SET email=..., provider=... (adopt)
        └─ else ────────────────► INSERT INTO accounts (...)
        │
        ▼           (both branches funnel here — D-02/D-03)
  persistAccountLink(accountRow)   ◄── NEW shared internal helper
        │
        ├─ 1. resolve business name: display_label ?? domain-of(email)   (D-06)
        ├─ 2. is domain free-mail? (D-07)  → skip domain-match, still create/name business
        ├─ 3. findOrCreateBusiness(name)   ◄── dashboard/lib/crm/auto-link.ts
        │        │
        │        ├─ INSERT INTO mailbox.businesses (name, slug)
        │        │     VALUES ($1, generateUniqueSlug($1))
        │        │     ON CONFLICT (name) DO NOTHING RETURNING id
        │        └─ 0 rows? → SELECT id FROM mailbox.businesses WHERE name = $1
        │
        └─ 4. UPDATE accounts SET business_id = $1 WHERE id = $2
        │
        ▼ (on ANY failure in steps 1-4: caught, logged, business_id stays NULL — D-05)
  return { id, adopted }  — unchanged external contract, callers unaffected
```

### Recommended Project Structure

```
dashboard/
├── migrations/
│   └── 057-add-accounts-business-id-and-slug-v1-2026-07-28.sql   # NEW — FK + slug col + backfill
├── lib/
│   ├── crm/
│   │   ├── queries.ts            # EXISTING — add findOrCreateBusiness() here (raw pg, same file as createBusiness/listBusinesses)
│   │   └── auto-link.ts          # NEW — FREE_MAIL_DOMAINS constant, generateSlug(), resolveBusinessName(), linkAccountToBusiness()
│   └── queries-accounts.ts       # EXISTING — add persistAccountLink() internal helper; call from all 3 creators' both branches
├── test/
│   ├── lib/
│   │   ├── queries-accounts.test.ts   # EXISTING — extend with auto-link assertions (real Postgres)
│   │   └── crm-auto-link.test.ts      # NEW — unit tests for generateSlug/resolveBusinessName/free-mail list (no DB needed for pure functions)
│   └── fixtures/
│       └── schema.sql             # MUST mirror the new columns — CI + codegen read this, not migrations/
```

### Pattern 1: Idempotent find-or-create with a UNIQUE constraint

**What:** `INSERT ... ON CONFLICT (col) DO NOTHING RETURNING *`, then `SELECT` on the empty-result case.
**When to use:** Any time app code wants "create if absent, otherwise fetch the existing row" against a column with a UNIQUE (or PK) constraint, without a separate existence-check race.
**Example:**
```typescript
// Source: Postgres INSERT docs — https://www.postgresql.org/docs/current/sql-insert.html#SQL-ON-CONFLICT
// "DO NOTHING avoids the constraint violation error... but the target row is
// not modified and, importantly, no row is returned by the RETURNING clause
// for a row that already existed." [CITED: postgresql.org/docs/current/sql-insert.html]
export async function findOrCreateBusiness(name: string): Promise<{ id: number; created: boolean }> {
  const pool = getPool();
  const inserted = await pool.query<{ id: number }>(
    `INSERT INTO mailbox.businesses (name, slug)
       VALUES ($1, $2)
     ON CONFLICT (name) DO NOTHING
     RETURNING id`,
    [name, await generateUniqueSlug(name)],
  );
  if (inserted.rows.length > 0) {
    return { id: inserted.rows[0].id, created: true };
  }
  // Conflict happened — the row already exists; fetch it.
  const existing = await pool.query<{ id: number }>(
    'SELECT id FROM mailbox.businesses WHERE name = $1',
    [name],
  );
  if (existing.rows.length === 0) {
    // Should be unreachable (conflict implies the row exists), but do not
    // throw into the caller's account-creation path — this whole call is
    // wrapped in a non-fatal try/catch per D-05.
    throw new Error(`findOrCreateBusiness: conflict on "${name}" but no row found`);
  }
  return { id: existing.rows[0].id, created: false };
}
```

**Why not `xmax = 0`:** ENT-02's requirement text mentions the `xmax = 0` trick (a way to tell, from a single `INSERT ... ON CONFLICT (...) DO UPDATE ... RETURNING xmax = 0 AS inserted`, whether the returned row was a fresh insert or an existing row hit by the `DO UPDATE`). That trick is for the `DO UPDATE` variant, which always returns a row. D-08 explicitly locks the `DO NOTHING` + fallback-SELECT variant instead (matching the existing `inbox_messages` "created" flag convention already in this codebase — see `POST /api/internal/inbox-messages`'s `{ id, message_id, created }` response, which uses exactly this `xmax = 0`-free "0 rows back → do a SELECT" pattern already, per the n8n boundary contract in `dashboard/CLAUDE.md`). Follow the existing house pattern (`created` boolean via row-count-after-INSERT, not `xmax`) for consistency — do not introduce the `xmax` idiom net-new into this codebase when an equivalent pattern already exists and is used elsewhere (`createImapAccount`'s `{ id, adopted }`, the inbox-messages route's `{ id, created }`).

**Concurrency reality check:** This appliance runs one dashboard Node process; account creation happens either (a) from a single operator clicking "connect" in the settings UI (one request in flight), or (b) once at first-boot onboarding. There is no scenario in this codebase where two connect requests for accounts sharing the same resolved business name land concurrently. The `ON CONFLICT` pattern above is correct under concurrency by construction (this is exactly what the UNIQUE constraint + `ON CONFLICT` clause exists to guarantee — no advisory lock or `SELECT ... FOR UPDATE` needed), but the low-concurrency reality only relaxes a *nice-to-have* (avoiding transient conflict overhead), never the requirement to use `ON CONFLICT` correctly — do not simplify to a bare `SELECT-then-INSERT` check-then-act, which *would* introduce a real (if unlikely) TOCTOU race.

### Pattern 2: Add-nullable → backfill → constrain, in one migration transaction

**What:** `ALTER TABLE ... ADD COLUMN slug TEXT` (nullable) → application-level or `UPDATE` backfill of every existing row → `ALTER TABLE ... ALTER COLUMN slug SET NOT NULL` → `ALTER TABLE ... ADD CONSTRAINT ... UNIQUE (slug)`, all inside the same file (same `BEGIN`/`COMMIT` per `runner.ts`).
**When to use:** Adding a NOT NULL UNIQUE column to a table that already has rows, on a table small enough that a full-table rewrite inside one transaction is not a concern (here: `businesses` currently has 3 rows on the only live appliance, will have 6 post-backfill — trivially safe; this is not the multi-million-row scenario where `SET NOT NULL` needing a full table scan would matter).
**Example (SQL, this schema):**
```sql
-- Source: this repo's own precedent — migration 033 does exactly this shape
-- (ADD COLUMN → UPDATE backfill → SET DEFAULT → SET NOT NULL → ADD CONSTRAINT,
-- all inside one DO $$ block, one transaction) for account_id across 13 tables.
-- [VERIFIED: dashboard/migrations/033-add-account-id-multi-account-v1-2026-05-28.sql]

ALTER TABLE mailbox.accounts
  ADD COLUMN IF NOT EXISTS business_id INTEGER
  REFERENCES mailbox.businesses(id) ON DELETE SET NULL;
-- ^ mirrors departments.business_id exactly (migration 052/"047"), nullable,
--   no backfill-then-NOT-NULL needed here — MAP-04 explicitly wants unmatched
--   accounts to stay unlinked (business_id NULL), so this column is NEVER
--   constrained NOT NULL. Only slug (below) goes through the 3-step tighten.

ALTER TABLE mailbox.businesses
  ADD COLUMN IF NOT EXISTS slug TEXT;

-- Backfill: compute a slug for every existing business row. Postgres has no
-- built-in ASCII-fold/kebab function, so do the minimal transform in SQL
-- (lowercase + collapse non-alnum) and accept that any true Unicode-folding
-- edge case is covered by the *same* generateSlug() TypeScript function this
-- migration's one-shot Node backfill script calls — see "Slug generation"
-- below for why a hybrid (simple SQL first pass covers the 3 live rows
-- fully; if planner prefers, run the backfill via a small tsx script using
-- the real generateSlug() instead of ad-hoc regexp_replace, for single-source
-- correctness). Recommendation: prefer the TypeScript-script backfill so the
-- runtime hook and the migration use byte-identical slug logic (this is the
-- literal ask in D-10 — "one rule, exercised twice").
UPDATE mailbox.businesses
  SET slug = lower(regexp_replace(regexp_replace(trim(name), '[^a-zA-Z0-9]+', '-', 'g'), '^-+|-+$', '', 'g'))
  WHERE slug IS NULL;

-- Collision suffixing (-2, -3, ...) for any duplicate computed slugs. With
-- only 3-6 rows and distinct names (Altitude Guitar / UMB Advisors / AutoCSR
-- / Jiffy Auto Glass / Elevated Advisory / Bonvillian Design), no collision
-- is expected in practice, but the migration must not assume that — see the
-- TypeScript backfill note above; a SQL-only migration cannot easily loop
-- with per-row incrementing suffixes without a DO $$ / PL/pgSQL loop. Planner's
-- call: either (a) a plpgsql loop over duplicate slugs appending -2/-3, or
-- (b) run the backfill as a one-shot Node script (npx tsx) invoked by the
-- migration's DO block via unavailable-in-SQL logic — recommend (a), a small
-- plpgsql loop, to keep the migration self-contained and not dependent on
-- Node/tsx being available at migration-apply time (the migrate profile
-- container may not have tsx wired for ad-hoc script execution mid-migration).

ALTER TABLE mailbox.businesses ALTER COLUMN slug SET NOT NULL;
ALTER TABLE mailbox.businesses ADD CONSTRAINT businesses_slug_key UNIQUE (slug);

-- Legacy slug seed (FILT-05 / D-14) — exactly one row, not a jobs.json rewrite.
UPDATE mailbox.businesses SET slug = 'altitude' WHERE name = 'Altitude Guitar';
```

### Anti-Patterns to Avoid

- **Regenerating `slug` on every business rename:** D-12 explicitly forbids this — cron jobs and digest references key off the frozen original slug. Do not add an `updated_at`-style trigger that recomputes `slug` from `name`.
- **Doing the free-mail check as a hardcoded `if` scattered per-provider:** D-07 requires one exported constant. Do not duplicate the list inline in `createImapAccount` vs `createMicrosoftAccount` vs `createAccount`.
- **Letting the auto-link helper throw uncaught:** D-05 is explicit — a business-link failure must never surface as a connect failure. Every one of the three creators must wrap the call to the shared helper in try/catch (or the helper itself must swallow and return a sentinel/log — recommend the helper does its own try/catch internally and never throws, so callers cannot forget to guard it).
- **Treating `businesses.name` UNIQUE as sufficient without also constraining `slug` UNIQUE:** the migration must add both — `name` uniqueness already exists (migration 053/"048"); `slug` uniqueness is new in this migration and must be added explicitly (D-13).
- **Skipping the `test/fixtures/schema.sql` mirror:** per this repo's own established landmine (documented in CLAUDE.md and the CI job comments), a migration invisible in `schema.sql` passes CI silently while being broken in reality — codegen and tests run against the fixture snapshot, not the `migrations/` directory.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Find-or-create under a UNIQUE constraint | A `SELECT` existence check followed by a conditional `INSERT` | `INSERT ... ON CONFLICT (name) DO NOTHING RETURNING id` + fallback `SELECT` | The check-then-act version has a genuine TOCTOU race (however unlikely on this appliance); the `ON CONFLICT` form is atomic and is Postgres's documented tool for exactly this. [CITED: postgresql.org/docs/current/sql-insert.html] |
| Slug uniqueness enforcement | App-only "is this slug taken" check before insert | DB-level `UNIQUE` constraint on `businesses.slug`, with app-side `-2`/`-3` suffix retry loop on violation | App-only checks race under concurrent creates; the DB constraint is the actual guarantee, app logic is just UX (friendlier than a raw 23505 back to the caller). |
| Cross-locale slug transliteration | A hand-rolled Unicode table for esoteric scripts | `String.prototype.normalize('NFD')` + diacritic-strip regex (built into Node/V8, no ICU dependency needed) — sufficient for the Latin-script business names actually in play here (English company names) | All 6 live business names are plain ASCII already; over-engineering full Unicode transliteration for this appliance's actual data is wasted complexity. If a future business name contains non-Latin script, `normalize('NFD')` degrades gracefully (falls through to the `[^a-zA-Z0-9]` collapse, producing an all-hyphen or empty slug edge case — worth a defensive `|| 'business'` fallback, see Pitfalls). |

**Key insight:** This phase's "hard" problems (idempotent create, deterministic slugging) both have single, well-documented, one-line-of-SQL-or-regex solutions. The actual risk in this phase is not algorithmic — it's **the number of call sites** (3 creators × 2 branches = 6 places business linking must NOT be missed) and transaction/failure-isolation discipline (D-05). Treat this as an integration-surface problem, not an algorithms problem.

## Runtime State Inventory

> Not a rename/refactor/migration-of-existing-identifiers phase — this phase *adds* new columns and a new linking behavior; it does not rename or move any existing identifier that other systems reference. Included per the instruction below anyway, scoped to what's relevant (the `jobs.json` legacy-slug question), because FILT-05 explicitly concerns an outside-Postgres artifact.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | `mailbox.businesses` (3 live rows) will gain a `slug` column; `mailbox.accounts` (6 live rows) will gain a `business_id` column. Both are additive — no existing column is renamed or removed. | Data migration (backfill), not a code-only edit — see migration SQL above. |
| Live service config | `~/.hermes/cron/jobs.json` on `agentbox3` — a flat file, NOT in Postgres, holding 4 cron jobs of which exactly 1 carries a business-slug string (`altitude`) per D-14. This phase does **not** write to that file. | None this phase — verify (read-only) at plan/execute time that `jobs.json` still shows exactly one `altitude` reference, matching D-14's stated live state, before finalizing the single-row legacy seed. If the live file has drifted since D-14 was written (2026-07-28), the seed target changes — this is a "verify, don't assume" step, not a code change. |
| OS-registered state | None found relevant to this phase. Cron job *registration* (Task Scheduler / systemd-equivalent on agentbox3) is untouched — this phase only prepares the DB-side slug that a future consumer (Phase 7) would resolve against; it registers nothing new. | None. |
| Secrets/env vars | None. No new env var is introduced by this phase (the free-mail-domain list is a hardcoded exported constant per D-07's "keep the list in one exported constant," not an env-configurable list like `OPERATOR_DOMAINS` — deliberately different from the `OPERATOR_DOMAINS` env-var pattern in `lib/classification/preclass.ts`, since D-07's list is a fixed universal set of public consumer domains, not a per-appliance-configurable operator domain). | None. |
| Build artifacts / installed packages | `lib/db/schema.ts` (kysely-codegen output) becomes stale the moment `accounts.business_id` is added to `test/fixtures/schema.sql` without a `db:codegen` re-run. This is a build-artifact staleness risk, not a package-install one. | Regenerate via `npm run db:codegen` (needs Docker) as a required task in this phase's plan — flag as **blocking** if Docker is unavailable in the execution environment (see Environment Availability below). |

## Common Pitfalls

### Pitfall 1: Adding the auto-link call to only 2 of the 3 creators (or only the INSERT branch of the sentinel-adopting two)

**What goes wrong:** The first mailbox connected on a fresh appliance (IMAP or Microsoft, via the sentinel-adopt UPDATE path) never gets linked to a business, because the executor naturally reaches for the more obvious "add a line after the INSERT" edit and misses that `createImapAccount`/`createMicrosoftAccount` have TWO returns (`adopted: true` via UPDATE, `adopted: false` via INSERT).
**Why it happens:** D-03 calls this out explicitly precisely because it's the natural mistake — the UPDATE branch doesn't visually read like "creating an account," so it's easy to reason "auto-link only applies when we create a NEW account row" and skip it.
**How to avoid:** Structure the shared helper so it's called exactly once per function, AFTER the branch (both branches converge on a `{ id, adopted }` shape before returning) — call `persistAccountLink({ id, email, display_label })` right before each function's `return`, not inside each individual branch. This makes it structurally impossible to add the call to one branch and forget the other, since there is only one call site per function, positioned after the if/else resolves.
**Warning signs:** A test asserting the adopt-path (`adopted: true`) leaves `business_id` set — this is exactly the assertion the plan's test strategy (below) must include and the current `connect-imap.test.ts`/`connect-graph.test.ts` (which mock `queries-accounts` entirely) will NOT catch.

### Pitfall 2: Kysely typecheck silently stale after adding `business_id` without regenerating codegen

**What goes wrong:** `queries-accounts.ts`'s `.updateTable('accounts').set({ business_id: ... })` will not typecheck (and biome/tsc will correctly fail it) until `lib/db/schema.ts`'s generated `DB` type includes the new column — but if the executor edits `test/fixtures/schema.sql` and forgets to run `npm run db:codegen`, `tsc --noEmit` fails, and the failure mode is a confusing "property business_id does not exist on type AccountsUpdate" error that looks like a typo, not a missing-codegen-step error.
**Why it happens:** `db:codegen` requires Docker (spins up a throwaway `postgres:17-alpine` container) and is a manual step, not part of `npm run typecheck` or `npm test` — CI does NOT currently run `db:codegen:verify` despite a script comment implying it does (documented landmine in CONTEXT.md's code_context section, confirmed independently: `.github/workflows/ci.yml`'s job list is `Apply schema snapshot → lint → typecheck → test`, with **no `db:codegen:verify` step present** `[VERIFIED: .github/workflows/ci.yml]`).
**How to avoid:** Make "run `npm run db:codegen`" an explicit, ordered task in the plan, immediately after the migration file + `schema.sql` mirror edit, before any `queries-accounts.ts` code that references `business_id` via Kysely. Verify locally with `npm run typecheck` before considering the task done.
**Warning signs:** `tsc --noEmit` errors referencing `AccountsTable`/`AccountsUpdate`/`Selectable<Accounts>` missing a property that was just added to the migration.

### Pitfall 3: Free-mail domain list omission causing Mike's own gmail.com inboxes to collapse into one business

**What goes wrong:** If the free-mail exclusion (D-07) is implemented as part of the *name* resolution instead of the *domain-match* step, or is accidentally skipped for one of the three creators, two personal Gmail-hosted business inboxes (there are none live today, but the appliance is designed to support this) would silently attach to whichever business first claimed `gmail.com`.
**Why it happens:** The natural implementation groups "resolve name" and "domain match" into one function; it's easy to apply the free-mail check to the wrong half (e.g., only skip using the domain as the *business name* when no `display_label` exists, but still allow a `gmail.com`-domain account to *domain-match* into an existing `gmail.com`-named business from a data-entry quirk).
**How to avoid:** Two independent gates in the helper: (1) name resolution (`display_label ?? domain`) always runs regardless of free-mail status — this determines what the *new* business would be named if one is created; (2) domain-match lookup (searching for an *existing* business by this account's domain) is skipped entirely when the domain is in `FREE_MAIL_DOMAINS` — this determines whether an *existing* business absorbs the account. Write these as two clearly separate functions/branches so the "skip domain-match" logic cannot leak into name resolution. Test explicitly: two accounts both with `display_label: null` and email domain `gmail.com` must produce TWO businesses, not one.
**Warning signs:** A test connecting two distinct `@gmail.com` accounts (no `display_label`) ends up with both `business_id`s pointing at the same row.

### Pitfall 4: Slug backfill computed differently in SQL than in the runtime TypeScript helper

**What goes wrong:** If the migration's backfill UPDATE uses a hand-rolled `regexp_replace` SQL expression while the runtime `generateSlug()` TypeScript function has slightly different edge-case handling (e.g., different Unicode-fold behavior, different collapse-repeats behavior), a future rename-then-recreate scenario, or simply an audit comparing DB rows to code output, surfaces a mismatch that erodes trust in "slug is deterministic from name."
**Why it happens:** D-10 explicitly warns about this class of bug for the *business-matching* rule ("not a separate hand-written mapping table — one rule, exercised twice") — the same risk applies to slug generation, which is not explicitly called out in D-10 but is the same shape of problem.
**How to avoid:** Prefer running the backfill via the actual TypeScript `generateSlug()` function (either as a one-shot script invoked as part of the deploy runbook, immediately after the SQL migration adds the nullable column, or by keeping the migration's SQL regex intentionally simple/exact-matching what `generateSlug()` does for the known 6 live business names, and adding a unit test that asserts `generateSlug('Altitude Guitar') === 'altitude-guitar'` etc., matching what the SQL produced). Given only 3-6 rows exist live, either approach is safe; the safer one for long-term correctness is to have the migration call out (in its header comment) that its regex is a **simplified equivalent** of `lib/crm/auto-link.ts:generateSlug()` and that the two must be kept in sync, OR — the more robust option — skip the SQL regex entirely and drive the backfill via a small Node script using the real function, run as a documented manual post-migration step (mirroring how `rag-backfill.ts`/`classify-backfill.ts` are separate one-shot scripts, not embedded in a `.sql` migration, elsewhere in this repo).
**Warning signs:** `generateSlug('Bonvillian Design')` (or whichever live name) computed in a unit test does not match what's actually stored in `businesses.slug` on `agentbox3` after the migration runs.

### Pitfall 5: `lib/crm/queries.ts:createBusiness()` gets changed in place instead of wrapped

**What goes wrong:** D-08 is explicit that the existing bare `createBusiness(name, description)` (no conflict handling, used today by whatever manual-create UI exists) must NOT be altered to add conflict handling — that's Phase 6's surface. If the executor "fixes" `createBusiness` to also handle conflicts (reasoning: "conflict handling is obviously better"), it silently changes Phase 6's contract before Phase 6 exists, and worse, changes error semantics for any existing manual-create caller that currently relies on getting a thrown unique-violation error on a duplicate name.
**Why it happens:** It looks like an obvious, low-risk drive-by improvement.
**How to avoid:** Add `findOrCreateBusiness()` as a NEW, separate exported function in the same file (or in the new `auto-link.ts` module) rather than modifying `createBusiness`'s signature or internals. `createBusiness` stays byte-for-byte unchanged this phase.
**Warning signs:** A diff touching `lib/crm/queries.ts:121` (the existing `createBusiness` function body) rather than only adding a new function nearby.

## Code Examples

### Shared internal helper — call-site shape inside `queries-accounts.ts`

```typescript
// Source: derived from this repo's existing createImapAccount/createMicrosoftAccount
// shape [VERIFIED: dashboard/lib/queries-accounts.ts:128-227] — showing where the
// ONE call site per function goes, after the branch resolves, before return.
import { linkAccountToBusiness } from '@/lib/crm/auto-link';

export async function createImapAccount(
  input: CreateImapAccountInput,
): Promise<{ id: number; adopted: boolean }> {
  const db = getKysely();
  const cfgJson = JSON.stringify(input.provider_config);

  const def = await db
    .selectFrom('accounts')
    .select(['id', 'email_address'])
    .where('is_default', '=', true)
    .executeTakeFirst();

  let result: { id: number; adopted: boolean };

  if (def && def.email_address === SENTINEL_DEFAULT_EMAIL) {
    const row = await db
      .updateTable('accounts')
      .set({
        email_address: input.email,
        display_label: input.display_label,
        provider: 'imap',
        provider_config: sql`${cfgJson}::jsonb`,
        provider_secret_enc: input.secret_enc,
      })
      .where('id', '=', def.id)
      .returning('id')
      .executeTakeFirstOrThrow();
    result = { id: row.id, adopted: true };
  } else {
    const row = await db
      .insertInto('accounts')
      .values({
        email_address: input.email,
        display_label: input.display_label,
        is_default: false,
        provider: 'imap',
        provider_config: sql`${cfgJson}::jsonb`,
        provider_secret_enc: input.secret_enc,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    result = { id: row.id, adopted: false };
  }

  // D-05: non-fatal. linkAccountToBusiness() itself never throws — it logs
  // internally and returns a discriminated result — but wrap defensively
  // anyway so a future refactor of that function can't silently break this
  // guarantee for every caller at once.
  try {
    await linkAccountToBusiness({
      accountId: result.id,
      email: input.email,
      displayLabel: input.display_label,
    });
  } catch (err) {
    console.error('linkAccountToBusiness failed (non-fatal, account still connected):', err);
  }

  return result;
}
```

### `linkAccountToBusiness` + slug generation — new `dashboard/lib/crm/auto-link.ts`

```typescript
// Source: implements D-06/D-07/D-08/D-13 against the existing lib/crm/queries.ts
// raw-pg surface [VERIFIED: dashboard/lib/crm/queries.ts] and getKysely() for the
// accounts.business_id write [VERIFIED: dashboard/lib/queries-accounts.ts].
import { getKysely, getPool } from '@/lib/db';

// D-07 — one exported constant, reused by Phase 6/7. Public consumer mail
// hosts only; NOT the same concept as lib/classification/preclass.ts's
// OPERATOR_DOMAINS (which is env-configurable and means "this appliance's
// own company domain" — a completely different axis).
export const FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com',
  'yahoo.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me',
  'protonmail.com', 'msn.com',
]);

export function extractEmailDomain(email: string): string {
  const at = email.lastIndexOf('@');
  return at >= 0 ? email.slice(at + 1).toLowerCase() : '';
}

export function isFreeMailDomain(domain: string): boolean {
  return FREE_MAIL_DOMAINS.has(domain.toLowerCase());
}

// D-06 — resolution order: display_label, else domain.
export function resolveBusinessName(email: string, displayLabel: string | null): string {
  if (displayLabel && displayLabel.trim().length > 0) return displayLabel.trim();
  return extractEmailDomain(email);
}

// D-13 — ASCII-fold, collapse non-alphanumerics, trim, lowercase.
export function generateSlug(name: string): string {
  const folded = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, ''); // strip diacritics
  const kebab = folded
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return kebab || 'business'; // defensive fallback for an all-symbol name
}

// D-13 collision handling: -2, -3, ... Only hit in practice with near-duplicate
// business names; safe at this table's row count (single-digit today).
async function generateUniqueSlug(name: string): Promise<string> {
  const base = generateSlug(name);
  const pool = getPool();
  let candidate = base;
  let n = 2;
  // Small table (single/low-double-digit rows for the foreseeable appliance
  // lifetime) — a per-candidate SELECT loop is simpler and safer than a
  // clever single-query solution, and runs at most a handful of times ever.
  while (true) {
    const { rows } = await pool.query('SELECT 1 FROM mailbox.businesses WHERE slug = $1', [candidate]);
    if (rows.length === 0) return candidate;
    candidate = `${base}-${n}`;
    n += 1;
  }
}

// D-08 — idempotent find-or-create. See Pattern 1 above for the ON CONFLICT
// rationale.
export async function findOrCreateBusiness(name: string): Promise<{ id: number; created: boolean }> {
  const pool = getPool();
  const slug = await generateUniqueSlug(name);
  const inserted = await pool.query<{ id: number }>(
    `INSERT INTO mailbox.businesses (name, slug)
       VALUES ($1, $2)
     ON CONFLICT (name) DO NOTHING
     RETURNING id`,
    [name, slug],
  );
  if (inserted.rows.length > 0) {
    return { id: inserted.rows[0].id, created: true };
  }
  const existing = await pool.query<{ id: number }>(
    'SELECT id FROM mailbox.businesses WHERE name = $1',
    [name],
  );
  if (existing.rows.length === 0) {
    throw new Error(`findOrCreateBusiness: conflict on "${name}" but no row found afterward`);
  }
  return { id: existing.rows[0].id, created: false };
}

// D-03/D-05/D-06/D-07/ENT-01/ENT-03 — the single entry point every account
// creator calls, both branches, exactly once, after the branch resolves.
export async function linkAccountToBusiness(input: {
  accountId: number;
  email: string;
  displayLabel: string | null;
}): Promise<void> {
  try {
    const domain = extractEmailDomain(input.email);
    const name = resolveBusinessName(input.email, input.displayLabel);

    let businessId: number;
    if (!isFreeMailDomain(domain)) {
      // ENT-03 domain match — but only against name-collisions; there is no
      // separate "businesses.domain" column, so "domain match" in practice
      // means: if a business with this exact resolved name already exists,
      // attach to it (findOrCreateBusiness both creates AND matches by name).
      const result = await findOrCreateBusiness(name);
      businessId = result.id;
    } else {
      // Free-mail domain: still gets a business (named from display_label,
      // which for a free-mail account is very likely present — an account
      // with no display_label AND a free-mail domain resolves its "name" to
      // the free-mail domain itself, e.g. "gmail.com" — findOrCreateBusiness
      // still applies the same UNIQUE(name) idempotency, it just is not used
      // as a cross-account matching signal).
      const result = await findOrCreateBusiness(name);
      businessId = result.id;
    }

    const db = getKysely();
    await db
      .updateTable('accounts')
      .set({ business_id: businessId })
      .where('id', '=', input.accountId)
      .execute();
  } catch (err) {
    // D-05 — never propagate. Caller (each of the 3 creators) also wraps this
    // defensively, but this function guarantees it on its own.
    console.error(`linkAccountToBusiness failed for account ${input.accountId}:`, err);
  }
}
```

**Note on ENT-03 "domain match" semantics:** because `mailbox.businesses` has no `domain` column (only `name`), "domain match" as literally described in ENT-03/D-09 ("if a business already exists for the account's email domain, attach to it") is implemented indirectly: the business's `name` for a non-free-mail domain typically *is* the domain when no `display_label` exists (D-06's fallback), so two accounts on the same non-free-mail domain with no `display_label` naturally resolve to the same `name` and therefore the same business via `findOrCreateBusiness`. When `display_label` IS present (the live-data-common case — all 6 live accounts have one), matching happens by name, not raw domain — this is consistent with D-09's live backfill expectation (3 accounts link to 3 *existing* businesses by name, e.g. `mike@altitudeguitar.com` + `display_label: 'Altitude Guitar'` → matches the existing `Altitude Guitar` business by NAME, which happens to also be domain-consistent). **Flag this as a discretionary planning decision:** if the planner wants literal domain-column matching independent of name (e.g., two accounts on `umbadvisors.com`, one with `display_label: 'UMB Advisors'` and a hypothetical second with `display_label: 'UMB Sales'`, should they merge?), that requires either a `businesses.domain` column (not in D-08's scope, not requested) or a lookup keyed on domain rather than name. Current locked decisions (D-06+D-08) only support name-based matching; call this out explicitly to the user if it doesn't match their mental model of "domain match."

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| Hook auto-create at OAuth callback time | Hook auto-create inside `queries-accounts.ts`'s three creator functions | This phase (D-01/D-02/D-03, resolved during discuss-phase 2026-07-28) | The milestone-level `research/SUMMARY.md` recommendation is superseded — do not resurrect it. |
| `sender_classification_overrides` as a force-to-category table | Renamed/reshaped to `sender_never_spam` (migration 043 reverted migration 041's category column same-day) | 2026-05-30 | **Direct precedent for this phase's "one migration can safely evolve a table shape hours after landing, with no data migration, when the table is still empty."** Not directly reused here (this phase's migration is net-new, not a revision of an existing one), but confirms the repo's own tolerance for migration-file-level correction via a NEW numbered file rather than editing an already-applied one — reinforcing "never edit migration 057 after it's applied; ship 058 to fix it." |

**Deprecated/outdated:** None specific to this phase's domain — Postgres `ON CONFLICT` (added 9.5, 2016) and `generated always as identity` (added 10, 2017) are both long-stable, already in use elsewhere in this schema (`accounts.id` uses `GENERATED ALWAYS AS IDENTITY`; `businesses.id` uses `SERIAL` — a pre-10 idiom kept for consistency with `departments`/`team_members`/`crm_contacts`, all `SERIAL`. Do not "upgrade" `businesses.id` to `GENERATED ALWAYS AS IDENTITY` as a drive-by — out of scope, inconsistent with its sibling CRM tables).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | agentbox3's live Postgres container name is `mailbox-postgres-1` and the dashboard runs from a baked image requiring rebuild for source changes (stated in the phase brief, not independently re-verified via SSH this session). | Deploy/verification path | If agentbox3's actual container/image setup differs from what's stated, the deploy runbook drafted at plan time could target the wrong container name or skip a required rebuild step. Low risk since this was explicitly asserted by the user in the phase brief (treat as CITED-by-user, not ASSUMED-by-research) — flagging only because this research did not independently SSH-verify it. |
| A2 | `jobs.json` on agentbox3 currently has exactly 4 jobs with exactly 1 (`altitude`) carrying a business slug — asserted in CONTEXT.md D-14 as "live state at time of decision." | Legacy slug seed | If the file has changed since 2026-07-28 (new cron jobs added, existing ones edited), the single-row seed target may be wrong or incomplete. Mitigation already specified in this document's Runtime State Inventory: re-verify `jobs.json` at plan/execute time before finalizing the seed statement, per D-14's own instruction ("verify `jobs.json` at plan time"). |
| A3 | No `businesses.domain` column is wanted, and "domain match" (ENT-03) is satisfied by name-based matching per D-06's resolution order. | Code Examples "Note on ENT-03" | If Mike's actual intent for "domain match" is a literal, `display_label`-independent domain key (e.g., so a `display_label`-mismatched second account on the same domain still auto-attaches), the current locked decisions (D-06 name-priority + D-08 name-uniqueness) don't deliver that — this is flagged explicitly above for user/planner attention, not silently implemented either way. |

**If this table is empty:** N/A — see above; three items warrant explicit confirmation before/during planning, though none block starting the plan (A1/A2 have a stated mitigation already baked into D-14/the deploy section; A3 is a planning-time judgment call already surfaced to the planner in-line).

## Open Questions

1. **Should the slug backfill be a plpgsql loop inside migration 057, or a companion one-shot Node script run right after?**
   - What we know: with only 3-6 live business rows and simple English names, either approach produces the correct result; the repo has precedent for both single-transaction `DO $$ ... $$` blocks (migration 033) and separate one-shot Node scripts run as a documented manual step (`rag-backfill.ts`, `classify-backfill.ts`).
   - What's unclear: whether the planner wants the migration to be 100% self-contained (safer for repeatability/CI, since CI's `test/fixtures/schema.sql` bootstrap has no path to invoke a Node script mid-`psql -f` run) or whether a Node-script backfill more precisely guarantees slug-generation parity with the runtime `generateSlug()` function (Pitfall 4).
   - Recommendation: **plan for the plpgsql/SQL-only version** (self-contained, CI-compatible, matches this repo's `test/fixtures/schema.sql` bootstrap model which only ever runs raw `.sql` via `psql -f`) — and add a unit test asserting `generateSlug()`'s TypeScript output for each of the 6 known live business names matches what the SQL regex would produce, closing the parity gap without needing a live Node script step in the migration path.

2. **Does `createAccount()` (the plain Gmail bare-row path used by `POST /api/accounts`) need the SAME free-mail/domain-match treatment, or does its caller already guarantee a non-free-mail context?**
   - What we know: `createAccount` is a generic, provider-parameterized function (`provider: MailProviderKind`) called from the Accounts Settings UI — it has no sentinel-adoption branch (that's IMAP/Microsoft-only) but otherwise needs identical linking treatment per D-04 (all providers, parity).
   - What's unclear: nothing structurally — this is confirmed straightforward. Flagging only so the plan explicitly includes `createAccount` as a THIRD call site, not just the two sentinel-branch functions that got the most CONTEXT.md attention.
   - Recommendation: plan must include `createAccount` as an equal-weight third integration point (single call site after its `INSERT ... RETURNING`, before `return row as AccountDetail`), with its own test coverage in `queries-accounts.test.ts` (which already covers `createAccount` against real Postgres — natural extension point per the existing code_context notes).

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Docker | `npm run db:codegen` (regenerate `lib/db/schema.ts` after adding `accounts.business_id`) | Not verified in this research session (no Docker probe run against the execution sandbox) | — | If Docker is unavailable in the executor's environment, `db:codegen` cannot run locally — the plan must either (a) hand-edit `lib/db/schema.ts`'s generated `Accounts` interface to add `business_id: Generated<number | null>` matching kysely-codegen's own output shape for a nullable integer FK (verifiable by comparing to the existing `display_label: string | null` column's generated shape in the same file), as a stop-gap, with a follow-up task to run real codegen once Docker is available, or (b) require Docker before this phase's plan is executed. Recommend (a) as a documented interim step if Docker probing at execute-time comes back unavailable — do not block the whole phase on it. |
| Postgres (local dev / CI) | Applying migration 057 for local testing before deploy | Available via `docker compose` per this repo's existing dev workflow (`test/fixtures/schema.sql` + CI service) — not independently re-probed this session, but this is the repo's existing, working CI path (`.github/workflows/ci.yml` `postgres:17-alpine` service) | 17-alpine | None needed — already working. |
| SSH/Tailscale access to `agentbox3` | Live-deploy verification step | Stated as available per the phase brief (user-asserted, ssh user `thumbox3`) — not independently probed this research session (no live network access to agentbox3 from this environment) | — | None needed for planning; execute-phase should re-confirm connectivity before attempting the live migration apply. |

**Missing dependencies with no fallback:** none identified as hard-blocking for the planning step itself.

**Missing dependencies with fallback:** Docker for `db:codegen` — see fallback (a)/(b) above; flag as a task-level risk in the plan rather than a phase-blocking gap.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest `^4.1.5` [VERIFIED: dashboard/package.json] |
| Config file | none found as a separate `vitest.config.ts` at the `dashboard/` root in the files read this session — tests run via `npm test` = `vitest run`; DB-gated tests read `TEST_POSTGRES_URL`/`POSTGRES_URL` env vars directly rather than a vitest config plugin (see `test/helpers/db.ts:HAS_DB`) |
| Quick run command | `TEST_POSTGRES_URL=postgresql://mailbox:mailbox@localhost:5432/mailbox npx vitest run test/lib/queries-accounts.test.ts` |
| Full suite command | `npm test` (equivalent to CI's `Vitest (schema invariants + pure code)` step, run AFTER `npm run lint` and `npm run typecheck` per the real CI order — `[VERIFIED: .github/workflows/ci.yml]` lint → typecheck → test) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| ENT-01 | Connecting any provider auto-creates a business named from display_label/domain | integration (real Postgres) | `npx vitest run test/lib/queries-accounts.test.ts -t "auto-link"` | ❌ Wave 0 — extend `test/lib/queries-accounts.test.ts` |
| ENT-02 | Reconnect/re-auth never duplicates a business | integration (real Postgres) | same file, `-t "idempotent"` | ❌ Wave 0 |
| ENT-03 | Existing business for the domain absorbs the new account (name-based, per the "Note on ENT-03" caveat above) | integration (real Postgres) | same file, `-t "domain match"` | ❌ Wave 0 |
| ENT-05 | A forced business-link failure (e.g., simulate a broken `getPool()`) never fails account creation | unit (mock the crm module to throw) | `npx vitest run test/lib/crm-auto-link.test.ts -t "non-fatal"` | ❌ Wave 0 — new file `test/lib/crm-auto-link.test.ts` |
| MAP-01 | `accounts.business_id` FK exists, nullable, `ON DELETE SET NULL` | schema-invariant (real Postgres, assert via information_schema or by deleting a business and checking the account row) | `npx vitest run test/schema-invariants.test.ts -t "business_id"` (extend existing file) | ❌ Wave 0 — extend `test/schema-invariants.test.ts` |
| MAP-04 | Backfill: 6 live accounts land against 3 existing + 3 new businesses correctly | manual verification against the actual `agentbox3` DB post-deploy (this is data-shape specific to ONE live appliance, not a repeatable CI assertion) | N/A — manual: `psql ... -c "SELECT a.email_address, b.name, b.slug FROM mailbox.accounts a LEFT JOIN mailbox.businesses b ON b.id = a.business_id;"` | manual-only, justified: the backfill's correctness is a one-time live-data fact, not a generalizable code path already covered by ENT-01/02/03's generic tests |
| FILT-05 | `businesses.slug` NOT NULL UNIQUE; `Altitude Guitar` carries `slug='altitude'` | schema-invariant (real Postgres) + one manual live-data check | `npx vitest run test/schema-invariants.test.ts -t "slug"` + manual `psql ... -c "SELECT slug FROM mailbox.businesses WHERE name = 'Altitude Guitar';"` | ❌ Wave 0 |

### Sampling Rate

- **Per task commit:** run the specific new/extended test file via `npx vitest run <file>` (fast, targeted).
- **Per wave merge:** `npm test` (full suite) — note this SKIPS all DB-gated tests locally unless `TEST_POSTGRES_URL` is set; the plan should document the local Postgres tunnel/port-forward setup needed (this repo's dashboard `CLAUDE.md` documents `ssh -L 5432:localhost:5432 <alias> -N` against a live appliance for `mailbox1` — for `agentbox3` the equivalent Tailscale-based tunnel or a local `docker compose up postgres` against `test/fixtures/schema.sql` should be used instead; do NOT tunnel into the live production `mailbox1` Postgres for this milestone's testing — wrong appliance entirely).
- **Phase gate:** full suite green (`npm run lint && npm run typecheck && npm test`, the real CI order) before `/gsd-verify-work`.

### Wave 0 Gaps

- [ ] `test/lib/crm-auto-link.test.ts` — new file, pure-function unit tests for `generateSlug`, `resolveBusinessName`, `isFreeMailDomain`, plus a mocked-non-fatal-failure test for `linkAccountToBusiness` (no DB needed for the pure-function half; the non-fatal-failure test can mock `getPool`/`getKysely` to throw).
- [ ] Extend `test/lib/queries-accounts.test.ts` — add auto-link assertions (real Postgres, `dbDescribe` idiom already present in this file) covering: fresh INSERT gets linked, sentinel-ADOPT branch gets linked, re-connecting the same email is idempotent (no duplicate business), two free-mail-domain accounts with no `display_label` produce two distinct businesses.
- [ ] Extend `test/schema-invariants.test.ts` — assert `accounts.business_id` is nullable + FK to `businesses(id)` + `ON DELETE SET NULL` behavior (create business, create account linked to it, delete business, assert account row's `business_id` is now NULL); assert `businesses.slug` is `NOT NULL UNIQUE`.
- [ ] **Do NOT touch** `test/connect-imap.test.ts` / `test/connect-graph.test.ts` — they fully mock `@/lib/queries-accounts` (`vi.mock('@/lib/queries-accounts', () => ({ createMicrosoftAccount: vi.fn() }))` `[VERIFIED: dashboard/test/connect-graph.test.ts:16]`) and will continue to pass unchanged since the mocked function's contract (`{ id, adopted }`) is unaffected by this phase. They provide ZERO coverage of the auto-link behavior — this is a known, accepted gap per CONTEXT.md's own landmine note; coverage lives entirely at the `queries-accounts.ts` layer per the extension above.
- [ ] Check (do not necessarily modify) `test/lib/queries-followup.test.ts:49`, `test/lib/gmail-p3.test.ts:166,250`, `test/routes/persona.test.ts:91,143` — these raw-INSERT into `mailbox.accounts` directly (bypassing the app hook entirely) `[VERIFIED via grep this session]`. They will continue to insert rows with `business_id` NULL (the column default, since no default is set for `business_id` — see Migration Pattern 2, this column deliberately has no backfill-and-NOT-NULL treatment). Confirm none of these tests assert anything about `business_id` being populated; if any assumed a NOT-NULL-by-default shape it would break, but per the migration design (`business_id` is nullable with no NOT NULL constraint), no existing test should break from the new nullable column's mere existence.

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | This phase touches no auth surface. |
| V3 Session Management | no | N/A |
| V4 Access Control | no | Internal server-side data-linking logic; no new externally-reachable authorization boundary is introduced (the 5 existing HTTP entry points' auth posture — Caddy basic_auth for `/api/accounts*`, docker-network-only trust for `/api/internal/*` — is unchanged by this phase). |
| V5 Input Validation | yes | The business `name` string ultimately derives from `display_label` (already zod-validated at the account-creation route boundary per STAQPRO-138 convention) or the email's domain portion (already validated as part of email format checks upstream). No new user-facing input surface is added in this phase — `linkAccountToBusiness` consumes already-validated data, it does not introduce a new untrusted-input boundary. Still: `generateSlug()` must handle pathological `display_label` values gracefully (empty string after fold → the `|| 'business'` fallback in the Code Examples section) so a business is never created with an empty-string slug that could violate the `NOT NULL` constraint at runtime. |
| V6 Cryptography | no | Not applicable — no secrets are touched by this phase. `provider_secret_enc` (the AES-256-GCM-encrypted app-password/client-secret column) is read/written unchanged by the existing creator functions; this phase's new code inserts before the function's `return`, after all secret-handling has already completed, and never touches `provider_secret_enc`. |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| SQL injection via business name (derived from `display_label`, an operator-supplied string in the Accounts settings UI) | Tampering | Already mitigated: all queries in this phase use parameterized `pg.Pool.query(sql, [params])` or Kysely's parameter binding — never string concatenation. Confirmed this is the existing house convention throughout `lib/crm/queries.ts` `[VERIFIED: dashboard/lib/crm/queries.ts]` and must be followed identically in the new `auto-link.ts` module. |
| Business-name collision used to attach an account to an unintended existing business (e.g., an operator names a new business identically to an existing unrelated one, causing an unwanted merge) | Spoofing (in the loose sense of "this account claims to belong to X business") | This is a genuine PRODUCT-LEVEL consideration, not a security vulnerability per se — the appliance is single-operator/single-tenant, so there is no cross-tenant trust boundary being crossed; Mike is the only person naming businesses on his own appliance. Document as a known behavior (not a defect): D-08's exact-name-match idempotency means two genuinely-different businesses that happen to share a display label WILL merge. No mitigation needed this phase (Phase 6's rename/re-map UI is the operator's correction path if this ever happens in practice). |

## Sources

### Primary (HIGH confidence)
- `dashboard/lib/queries-accounts.ts` (this repo, read in full this session) — the three creator functions, sentinel-adopt branches, existing error-handling conventions (`AccountMutationError`, `isUniqueViolation`).
- `dashboard/lib/crm/queries.ts` (this repo, read in full this session) — existing `businesses`/`departments` raw-pg CRUD surface, `createBusiness`'s current no-conflict-handling shape.
- `dashboard/migrations/033-add-account-id-multi-account-v1-2026-05-28.sql`, `037-add-account-provider-v1-2026-05-29.sql`, `041-create-sender-classification-overrides-v1-2026-05-29.sql`, `043-rename-sender-overrides-to-never-spam-v1-2026-05-30.sql`, `052-create-crm-tables-v1-2026-06-04.sql` (this repo) — precedent for migration shape, ADD COLUMN/backfill/constrain sequencing, and same-era table-reshape precedent.
- `dashboard/test/fixtures/schema.sql` (this repo, `accounts`/`businesses`/`departments` sections read directly, confirmed line numbers) — canonical schema snapshot CI and codegen actually use.
- `dashboard/migrations/runner.ts` (this repo, read in full) — confirms filename-minus-`.sql` versioning, lexical sort, single `BEGIN`/`COMMIT` per file, no down-migrations.
- `.github/workflows/ci.yml` (this repo, read relevant sections) — confirms actual CI step order: apply schema snapshot → lint → typecheck → test; confirms NO `db:codegen:verify` step currently present.
- `dashboard/test/lib/queries-accounts.test.ts`, `dashboard/test/connect-graph.test.ts` (this repo) — confirms `dbDescribe` idiom, confirms `connect-graph.test.ts` fully mocks `@/lib/queries-accounts`.
- `dashboard/lib/classification/preclass.ts` (this repo) — confirms `OPERATOR_DOMAINS` is a distinct, unrelated concept (env-configurable single-appliance operator domain) from D-07's free-mail-domain constant; confirms no existing free-mail-domain helper exists to reuse.
- [Postgres INSERT ... ON CONFLICT documentation](https://www.postgresql.org/docs/current/sql-insert.html#SQL-ON-CONFLICT) — `[CITED: postgresql.org/docs/current/sql-insert.html]` — authoritative source for the `DO NOTHING` returns-no-row-on-conflict behavior this pattern depends on.

### Secondary (MEDIUM confidence)
- Phase brief's assertions about `agentbox3`'s live container names (`mailbox-postgres-1`), SSH user (`thumbox3`), and the baked-image rebuild requirement — accepted as user-provided ground truth (CITED to the phase brief itself), not independently re-verified via live SSH this research session (see Assumption A1).

### Tertiary (LOW confidence)
- None — every claim in this document is either grounded in a direct file read of this repository this session, a cited Postgres documentation fact, or explicitly flagged in the Assumptions Log above.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new dependencies; all libraries and their versions confirmed directly from `dashboard/package.json`.
- Architecture: HIGH — every call site, branch, and existing function signature quoted verbatim from files read this session; the shared-helper seam and its exact call-site placement is derived directly from D-01/D-02/D-03 plus the actual current code shape.
- Pitfalls: HIGH — five pitfalls, each grounded either in an explicit CONTEXT.md warning (D-03, D-10) or a directly-observed repo fact (CI missing `db:codegen:verify`, `connect-*.test.ts` mocking `queries-accounts`).
- Migration mechanics / idempotency SQL: HIGH — pattern matches this repo's own migration-033 precedent and cited Postgres documentation.
- agentbox3 live-deploy specifics: MEDIUM — accepted as given by the phase brief; not independently re-verified via live SSH this session (flagged as Assumption A1).

**Research date:** 2026-07-28
**Valid until:** 2026-08-27 (30 days — this is stable, slow-moving schema/backend work with no external API dependencies subject to rapid change; re-verify sooner only if the `agentbox3` live-data snapshot referenced in D-09/D-14 has materially changed).
