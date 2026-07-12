# Architecture Research — Unified Entities Milestone

**Domain:** Cross-repo integration (mailbox dashboard CRM ↔ agentbox-sidecar UI ↔ gbrain digest)
**Researched:** 2026-07-11
**Confidence:** HIGH (all findings from direct code/migration inspection, no external sources needed)

> Supersedes the prior version of this file (dated 2026-04-02, Phase 1 hardware/appliance topology — Jetson/Ollama/Qdrant/n8n). That system topology is unchanged and still accurate at the infra layer; it is simply out of scope for this milestone, which is about the CRM/entity data model across the mailbox and agentbox-sidecar repos. If a future milestone needs the appliance-topology research again, it is preserved in git history for this file.

## System Overview (current state, both repos)

```
┌─────────────────────────────────────────────────────────────────────────┐
│  agentbox-sidecar  (:9200, FastAPI + vendored React SPA at web/)         │
│  ┌───────────────┐   ┌──────────────┐   ┌───────────────────────────┐   │
│  │ CronPage.tsx  │   │DailyBriefPage│   │ ProposalsView.tsx         │   │
│  │ (Agent Jobs)  │   │.tsx          │   │                           │   │
│  └───────┬───────┘   └──────┬───────┘   └───────────┬───────────────┘   │
│          │  reads job.business (string)              │ reads entity     │
│          ▼                   ▼                        ▼                │
│   web/src/lib/entities.ts — STATIC ENTITY_OPTIONS[] (hardcoded slugs)   │
│                                                                          │
│  ┌───────────────┐   ┌──────────────────────────────────────────────┐  │
│  │ OrgChartPage /│──▶│ web/src/lib/departments.ts useDepartments()   │  │
│  │ ScopeFilter   │   │  (CRM-backed, working correctly today)        │  │
│  └───────────────┘   └───────────────────┬──────────────────────────┘  │
│                                           │ crmApi (web/src/lib/crm.ts) │
│                                           │ → /dashboard/api/crm/*      │
│  ┌────────────────────────────────────────────────────────────────┐    │
│  │ Python: features/digest.py  _entity_slugs()                    │    │
│  │  1. AGENTBOX_ENTITY_SLUGS env  2. $HERMES_HOME/entities.json    │    │
│  │  (org-layer file, unrelated to CRM, unrelated to sidecar proxy) │    │
│  └────────────────────────────────────────────────────────────────┘    │
└──────────────────────────┬───────────────────────────────────────────┬─┘
                            │ hermes reverse proxy                     │ filesystem
                            ▼ /dashboard/api/* → :3001                 ▼ $HERMES_HOME
┌─────────────────────────────────────────────────────────────────────────┐
│  mailbox  (Next.js 14 dashboard, :3001, Postgres `mailbox` schema)      │
│  ┌────────────────────┐   ┌───────────────────────────────────────┐    │
│  │ app/api/crm/*       │──▶│ lib/crm/queries.ts (raw pg, NOT Kysely)│   │
│  │ businesses/depart-  │   │  businesses / departments / team /    │   │
│  │ ments/team/contacts │   │  crm_contacts                          │   │
│  └────────────────────┘   └───────────────────────────────────────┘    │
│  ┌────────────────────┐   ┌───────────────────────────────────────┐    │
│  │ app/api/accounts    │──▶│ lib/queries-accounts.ts (Kysely)       │   │
│  │ app/api/oauth/google│   │  accounts (id, email_address,          │   │
│  │  /[provider]/connect│   │  display_label, is_default, provider,  │   │
│  │  /callback          │   │  provider_config, provider_secret_enc) │   │
│  └────────────────────┘   └───────────────────────────────────────┘    │
│           NO RELATIONSHIP TODAY between accounts and businesses          │
└─────────────────────────────────────────────────────────────────────────┘
```

**The core problem this milestone solves:** three unrelated "which company is this for" axes exist in parallel — (1) `mailbox.businesses`/`departments` (the real CRM, migration 052/053), (2) `mailbox.accounts` (Gmail/IMAP/Microsoft inboxes, migration 033, with zero FK to #1), and (3) the sidecar's hardcoded `ENTITY_OPTIONS` slug list (mirrors a *fourth*, gbrain-side list — `entity_map.yaml` → `AGENTBOX_ENTITY_SLUGS`/`entities.json`). None of the four are wired together.

## Component Responsibilities (as they exist today)

| Component | Responsibility | Current state |
|-----------|-----------------|----------------|
| `mailbox.accounts` (migration 033) | One row per connected inbox (Gmail/IMAP/Microsoft) | `email_address` UNIQUE, `is_default`, `provider*`. No `business_id`. |
| `mailbox.businesses` (migration 053, internal comment says "048") | The CRM company entities | `name` UNIQUE, `description`. No back-reference to `accounts`. |
| `mailbox.departments` (migration 052) | Org sub-units | `business_id` nullable FK → `businesses` **ON DELETE SET NULL** — this is the exact precedent pattern for accounts↔business (see Q2 below). |
| `dashboard/lib/queries-accounts.ts` `createAccount()` | The **only** insert path into `accounts` from the operator UI (`POST /api/accounts`) | Provider-agnostic (gmail/imap/microsoft); for Gmail this creates a bare registry row — no OAuth attached yet. |
| `dashboard/lib/oauth/google.ts` + `/api/oauth/google/callback` | Actual Gmail **authorization** (consent → refresh token → `oauth_tokens` upsert, keyed `(provider, account_id)`) | Requires an existing `account_id` (via `?account_id=` on the connect route, defaults to the default account) — so account creation always *precedes* OAuth grant, never the reverse. |
| `dashboard/app/onboarding/email-connect/page.tsx` | First-boot wizard Gmail tab | **Still a stub** (STAQPRO-152/197 TODO) — the only *live* Gmail connect path today is Settings → Accounts "Learn voice" (MBOX-399/415), not the onboarding wizard. |
| `sidecar/web/src/lib/entities.ts` | Static `ENTITY_OPTIONS` slug list (heron/state/cde/krunchy/yes/future/umb/glue/myco/personal/unsorted) | Hardcoded; comment claims `GET /api/entities` is authoritative — **that route does not exist**, it's an aspirational/stale comment. |
| `sidecar/web/src/lib/crm.ts` + `departments.ts` `useDepartments()` | CRM-backed department/business grouping for `ScopeFilter`/`OrgChartPage` | Already correctly wired to `/dashboard/api/crm/*` — this is the pattern to replicate for `ENTITY_OPTIONS`. |
| Cron job storage (hermes-native, via `cronext.py`) | Persists `job.business` as an opaque string | **Not modeled in Python at all** — `business` only exists as a TS field name; hermes' native cron store treats it as free-form metadata. No backend validation ties it to CRM or gbrain slugs today. |
| `sidecar/src/agentbox_sidecar/features/digest.py` `_entity_slugs()` | gbrain digest entity-filter whitelist | Resolves from `AGENTBOX_ENTITY_SLUGS` env → `$HERMES_HOME/entities.json` → empty. File is written by a **separate** org-layer repo (`agentbox-seed`) at apply-time — the mailbox dashboard has no visibility into it at all. |

## Integration Points — Answers to the Four Questions

### Q1 — Where does auto-create-business belong, idempotent + default-on-with-opt-out?

**Hook point: `createAccount()` in `dashboard/lib/queries-accounts.ts`** (called only from `POST /api/accounts`), not the OAuth callback.

Rationale: an `account_id` must already exist before the OAuth connect route (`/api/oauth/google/[provider]/connect?account_id=`) can even be invoked — the callback (`saveToken()` in `lib/oauth/google.ts`) only *attaches a token* to a pre-existing account, it never creates one. So "when a Gmail account is authorized" in practice means "when the registry row is created," since that's the earliest point at which `display_label`/`email_address` (and therefore a business name) are known. Hooking the OAuth callback instead would (a) require duplicating the derive-and-link logic in two places if IMAP/Microsoft accounts should also get this behavior, and (b) leave a window where a created-but-not-yet-authorized account has no business, which is confusing UX.

**Design:**
1. Wrap the insert + business resolution in one `db.transaction()` inside `createAccount()`.
2. Derive a candidate business name: `display_label` if the operator supplied one, else a title-cased email domain label (`acme.com` → `Acme`) — same derivation the milestone spec calls for ("named from `display_label`/email domain").
3. Idempotency: case-insensitive lookup against `businesses.name` (or against a new `slug` column, see Q3) inside the same transaction; `INSERT ... ON CONFLICT (name) DO NOTHING RETURNING id`, falling back to a `SELECT id` when the conflict fires (name is already `UNIQUE`, migration 053, so this is a single round-trip with the existing constraint — no new lock needed).
4. Set the new `accounts.business_id` FK (see Q2) to the resolved business id.
5. **Default-on-with-opt-out:** add `auto_create_business_enabled BOOLEAN NOT NULL DEFAULT true` to the existing singleton `mailbox.operator_settings` table (migration 038) — this matches the established convention for exactly this kind of appliance-wide toggle (booking_link/calendar_embed_src/drive_folder_id live there already). Read it once per `createAccount()` call. Additionally accept an optional `business_id` (explicit pick) or `skip_auto_create_business` boolean on the `POST /api/accounts` body (`accountCreateSchema`) so the operator can suppress auto-create for a one-off connect — this is what satisfies "support manually-created businesses... and re-mapping an account to a different business later": if the operator explicitly supplies `business_id`, auto-create never runs.
6. `createImapAccount()`/`createMicrosoftAccount()` (the sentinel-adoption helpers) should call the same shared `resolveOrCreateBusiness()` helper so all three providers get consistent behavior, not just Gmail — the milestone spec only calls out Gmail explicitly but the "every business/department/entity filter reads from one CRM source" goal implies parity.

### Q2 — Data model: nullable FK vs. link table, migration/back-compat for live data (3 businesses, 6 accounts)

**Recommendation: nullable FK, not a link table.** `mailbox.accounts.business_id INTEGER REFERENCES mailbox.businesses(id) ON DELETE SET NULL` — this is the **identical pattern** already shipped for `departments.business_id` (migration 053), so it's a proven, reviewed precedent in this exact codebase, not a new decision. One business can own many accounts (inboxes); an account belongs to at most one business, which matches "re-mapping an account to a different business later" (a single `UPDATE accounts SET business_id = ...`, not a join-table row swap). A link table would only be justified for genuine many-to-many (one inbox shared across multiple businesses) — not in the requirements, and would complicate every consumer query (CRM filter joins, sidecar entity dropdowns) for no requirement-driven benefit.

**Migration, non-breaking by design (mirrors migration 033's own stated approach):**
```sql
ALTER TABLE mailbox.accounts
  ADD COLUMN IF NOT EXISTS business_id INTEGER
  REFERENCES mailbox.businesses(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS accounts_business_id_idx ON mailbox.accounts (business_id);
```
- **Nullable, no DEFAULT, no forced backfill DML** — matches the migration-007 comment convention ("schema only — no DML unless explicitly a backfill"). The 6 existing accounts land with `business_id = NULL`, which must be a legitimate, handled state everywhere (identical to how `departments.business_id IS NULL` already works today — "unassigned" is not a new concept for this schema).
- **Do not attempt to auto-map the 6 live accounts to the 3 live businesses via heuristic DML** in the migration itself — domain/label matching in a data migration is a guess that could silently misattribute a real customer's inbox. Instead, ship a business picker on the existing `/settings/accounts` page (reusing the `AccountsSettings.tsx` edit-row UI) so the operator does one deliberate PATCH per account post-deploy. This is a one-time, low-volume (6 rows) manual step — cheaper and safer than migration-time heuristics.
- Extend `AccountDetail`/`listAccountsDetailed()` to select `business_id`, and add `business_id` to `updateAccount()`'s patch shape (same pattern already used for `display_label`/`provider`).
- `deleteBusiness()` already relies on `ON DELETE SET NULL` semantics for departments (comment: "leaves its departments intact... not orphaned/deleted") — the identical guarantee applies to accounts once the FK exists: deleting a business never deletes or orphans an inbox, it un-links it.

### Q3 — Unify sidecar's `ENTITY_OPTIONS` onto the CRM API without breaking `job.business`

**The critical constraint:** `job.business` is stored as a **plain string** in hermes' native cron job storage — it is not modeled in any Python backend type (`cronext.py` has zero references to `business`; it's a TS-only field name that rides through as opaque metadata). There is no migration hook available in the job-storage layer itself. This rules out switching the sidecar to numeric `business_id` everywhere — every historical job's `business` string would need an in-place rewrite with no natural trigger point to do it.

**Recommended approach — add a stable `slug` to CRM businesses, keep the wire format a string:**
1. `ALTER TABLE mailbox.businesses ADD COLUMN slug TEXT` (derived from `name`, e.g. slugify + lowercase), with a unique index once populated. Expose `slug` on the existing `GET /api/crm/businesses` response (no new route needed — same shape `crmApi.listBusinesses()` already consumes).
2. **Back-compat seed (the specific migration concern the milestone calls out):** one-time seed of CRM businesses matching every slug already live in `job.business` today — `heron`, `state`, `cde`, `krunchy`, `yes`, `future`, `umb`, `glue`, `myco`, `personal`, `unsorted` — via `INSERT INTO businesses (name, slug) VALUES ('Heron Labs','heron'), ('STATE','state'), ... ON CONFLICT (slug) DO NOTHING`. This must land **before** the sidecar UI switches its data source, or `entityLabel(slug)` will stop resolving labels for every existing cron job, Daily Brief entry, and proposal that already carries one of these slugs. Zero rows in `job.business` (or any digest/proposal record) need to be rewritten — the string values are unchanged, only where the label lookup goes changes.
3. Replace `web/src/lib/entities.ts`'s static `ENTITY_OPTIONS` with a hook (`useEntityOptions()`) following the exact `useDepartments()` pattern already in `departments.ts`: `crmApi.listBusinesses()` → map `{value: b.slug, label: b.name}`, prepend the existing `{value:'', label:'All entities'}` sentinel. `entityLabel()`'s existing fallback (`ENTITY_LABEL_BY_SLUG[slug] ?? slug`) already degrades gracefully for any slug not yet present in CRM, so this is a safe, incremental swap — `CronPage.tsx`, `DailyBriefPage.tsx`, and `ProposalsView.tsx` need only swap their import/consumption of the constant for the hook's return value; none of their grouping/filtering logic (which operates on the string slug) needs to change.
4. Slugs like `unsorted`/`personal` that aren't "real" businesses conceptually — seed them as ordinary CRM business rows anyway for a clean cutover (simpler than special-casing a sentinel list in code); the operator can rename/merge/delete them later through the normal CRM UI once real usage patterns are visible.

### Q4 — Reconciling the gbrain digest entity axis with CRM

Three options were evaluated; **recommend "bridge," reject "derive-live" and "leave separate."**

- **Leave separate (rejected):** fails the milestone's explicit requirement to reconcile this axis at all.
- **Full unify / derive-live (rejected for this milestone):** would mean `digest.py`'s `_entity_slugs()` calls the CRM proxy live, on every digest request. This introduces a new runtime dependency (gbrain digest resolution would require `mailbox-dashboard` to be reachable) where **none exists today** — currently gbrain only needs a local file + optional env var, fully decoupled from the dashboard process. It would also pull in the `gbrain-ingest/entity_map.yaml` → `attribution.py` pipeline (sender-domain → entity attribution for email ingestion), which is a materially different and more entangled piece of logic than the UI's simple slug/label list — out of scope per "Focus ONLY on integration for the NEW features."
- **Bridge (recommended):** keep `AGENTBOX_ENTITY_SLUGS`/`$HERMES_HOME/entities.json` and `digest.py`'s existing resolution logic **completely unchanged** (zero gbrain code touched — lowest risk). Add a small sync step in the sidecar (e.g. `features/crm_sync.py`, Python, since the sidecar backend already proxies to `/dashboard/api/crm/businesses`) that periodically (on sidecar startup, and optionally on a cron interval or a CRM-mutation-triggered refresh) fetches the current CRM businesses' `slug` list and **rewrites `$HERMES_HOME/entities.json`** to match. This makes CRM the upstream source of truth for the digest axis too, without touching the daemon's file-based contract or the ingest/attribution pipeline — the sync step is additive and can be built, tested, and rolled back independently of everything else in this milestone.

## Build Order

Dependencies flow strictly backend → API → frontend → cross-process bridge; each phase's schema/data is a prerequisite for the next.

1. **Phase A — Backend data model + auto-create (mailbox repo).**
   - Migration: `accounts.business_id` nullable FK (Q2) + `businesses.slug` column + legacy-slug seed rows (Q3 back-compat) + `operator_settings.auto_create_business_enabled` column (Q1 toggle).
   - `createAccount()`/`createImapAccount()`/`createMicrosoftAccount()` gain the shared `resolveOrCreateBusiness()` hook (Q1), transactional, idempotent on `businesses.name`/`slug`.
   - Extend `AccountDetail`, `listAccountsDetailed()`, `updateAccount()` to carry `business_id`.
   - Settings → Accounts UI: add a business picker (assign/reassign existing accounts — closes the "6 accounts need manual mapping" gap from Q2, and gives the opt-out toggle a home).
   - **Why first:** every other phase reads either the new FK, the new slug column, or the seed data.

2. **Phase B — CRM API surface (mailbox repo).**
   - `GET /api/crm/businesses` includes `slug` in its response shape.
   - `GET /api/accounts` (and `?detail=1` variant) includes `business_id`; optional `?business_id=` filter if a consumer needs server-side filtering rather than client-side.
   - **Why second:** thin, low-risk API surface work that Phase C depends on; keeping it separate from Phase A lets the schema migration ship and soak (verify against live data) before consumers start reading it.

3. **Phase C — Sidecar filter-wiring (agentbox-sidecar repo).**
   - Replace static `ENTITY_OPTIONS` with a CRM-backed `useEntityOptions()` hook (mirrors `useDepartments()`).
   - Swap the import in `CronPage.tsx`, `DailyBriefPage.tsx`, `ProposalsView.tsx`.
   - **Hard dependency on Phase A's legacy-slug seed** — must not ship before the seed exists, or every pre-existing `job.business`/digest-entity/proposal-entity value loses its label.
   - Verify: existing cron jobs, Daily Brief filters, and proposals still resolve labels correctly post-swap (the `entityLabel()` fallback makes this graceful even if something is missed, but the seed should make the fallback path unused in practice).

4. **Phase D — gbrain digest axis bridge (agentbox-sidecar repo, Python side).**
   - New CRM→`entities.json` sync routine (Q4), independent of and lower-priority than C.
   - **Why last:** touches a different process boundary (the gbrain daemon, a separate on-Jetson process with its own file-based contract) that's higher-risk-per-line-changed and not load-bearing for the rest of the milestone's UI-facing goals — sequencing it last also lets the CRM businesses list stabilize (post Phase A/C renames/consolidation of legacy slugs) before it becomes something else's sync source.

## Anti-Patterns to Avoid

### Anti-Pattern 1: Migration-time heuristic backfill of account→business links
**What people do:** try to guess-map the 6 live accounts to the 3 live businesses via domain/label matching inside the migration's DML.
**Why it's wrong:** a data migration is the wrong place for a fuzzy business decision — a wrong guess silently misattributes a real customer's inbox to the wrong company with no operator review.
**Instead:** ship the FK as nullable with no forced backfill, and add a business picker to the existing Settings → Accounts page for a deliberate one-time operator pass.

### Anti-Pattern 2: Rewriting historical `job.business` string values to match a new ID scheme
**What people do:** switch the sidecar to numeric `business_id` and bulk-UPDATE every stored cron job's `business` field to match.
**Why it's wrong:** `job.business` lives in hermes-native cron job storage with **no Python-side model** for the field — there's no natural migration hook, and "cron job storage" spans whatever hermes' native persistence is, which this milestone should not be touching.
**Instead:** keep the wire format a string (slug), add a `slug` column to CRM businesses, and seed the existing slugs as CRM rows so old data resolves unchanged.

### Anti-Pattern 3: Making the gbrain digest daemon depend on the dashboard being up
**What people do:** have `digest.py`'s entity-slug resolution call the CRM API live on every request ("derive" approach).
**Why it's wrong:** introduces a new runtime coupling (gbrain digest → mailbox-dashboard reachability) where none exists today; the digest daemon currently only needs a local file.
**Instead:** the sidecar syncs CRM → `$HERMES_HOME/entities.json` out-of-band (on startup/interval); the daemon's read path never changes.

## Sources

- Direct inspection: `mailbox/dashboard/migrations/033-*.sql`, `052-*.sql`, `053-*.sql`, `038-*.sql`
- Direct inspection: `mailbox/dashboard/lib/queries-accounts.ts`, `lib/crm/queries.ts`, `lib/oauth/google.ts`, `app/api/oauth/google/callback/route.ts`, `app/api/oauth/google/[provider]/connect/route.ts`, `app/api/accounts/route.ts`, `app/onboarding/email-connect/page.tsx`
- Direct inspection: `agentbox-sidecar/web/src/lib/entities.ts`, `lib/departments.ts`, `lib/crm.ts`, `pages/CronPage.tsx`, `pages/DailyBriefPage.tsx`, `components/ProposalsView.tsx`
- Direct inspection: `agentbox-sidecar/src/agentbox_sidecar/features/digest.py`, `features/cronext.py`
- `.planning/PROJECT.md` (Unified Entities milestone requirements), `mailbox/CLAUDE.md`, `mailbox/dashboard/CLAUDE.md`, `agentbox-sidecar/CLAUDE.md`

---
*Architecture research for: Unified Entities milestone (mailbox + agentbox-sidecar)*
*Researched: 2026-07-11*
