# Phase 5: Backend Data Model & Auto-Create - Pattern Map

**Mapped:** 2026-07-28
**Files analyzed:** 8 (1 migration, 1 slug util, 1 free-mail-domain const + helper, 1 CRM get-or-create, 1 shared queries-accounts seam, 2 test files, 1 schema.sql mirror + codegen)
**Analogs found:** 8 / 8

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `dashboard/migrations/057-*.sql` (FK + slug + backfill) | migration | batch/DML backfill | `dashboard/migrations/053-crm-businesses-v1-2026-06-05.sql` (FK shape) + `036-account-scope-persona-kb-v2-2026-05-28.sql` (add→backfill→NOT NULL DO-block) | exact (composite) |
| slug-generation utility (e.g. `dashboard/lib/crm/slug.ts`) | utility | transform | `dashboard/lib/classification/preclass.ts` (`splitEnv` pure fn) + its absent test — nearest colocated-test pure module is `dashboard/lib/urgency.ts`/`evaluateUrgency` pattern (see Shared Patterns) | role-match |
| free-mail-domain constant + domain extraction helper | utility | transform | `dashboard/lib/classification/preclass.ts` `OPERATOR_DOMAINS` / `extractDomain` | exact |
| find-or-create-business helper in `dashboard/lib/crm/queries.ts` | service | CRUD (idempotent upsert) | `dashboard/lib/crm/queries.ts:createBusiness` (raw `pg`, no conflict handling — must be wrapped, not copied verbatim) + `dashboard/lib/queries-sender-allowlist.ts:upsertNeverSpam` (Kysely `onConflict` idiom, cross-reference only) | role-match |
| shared internal seam in `dashboard/lib/queries-accounts.ts` (all three creators funnel through) | service | request-response + event-driven side effect | `dashboard/lib/queries-accounts.ts:createImapAccount` / `createMicrosoftAccount` (sentinel-adopt-or-insert branch) | exact |
| non-fatal auto-link fire point after account persist | event-driven side effect | fire-and-forget, non-fatal | `dashboard/app/api/internal/inbox-messages/route.ts` (`embedAndUpsertInbound`, called `void`, try/catch swallows) | exact |
| tests: `queries-accounts` extension + pure-function tests | test | DB-gated + pure unit | `dashboard/test/lib/queries-accounts.test.ts` (`dbDescribe` idiom) + `dashboard/test/helpers/db.ts` | exact |
| `dashboard/test/fixtures/schema.sql` mirror | migration (DDL mirror) | schema-only | existing `mailbox.accounts` block (:1228) and `mailbox.businesses` block (:1599) in the same file | exact |

## Pattern Assignments

### `dashboard/migrations/057-*.sql`

**Analog 1 (FK shape to copy verbatim):** `dashboard/migrations/053-crm-businesses-v1-2026-06-05.sql`

```sql
-- Migration 048 — AgentBOX CRM: Businesses; departments belong to a business.
-- WHAT: new mailbox.businesses table ... + a nullable business_id on mailbox.departments.
-- WHY:  operator request (2026-06-05). Departments are created per-business ...
-- ROLLBACK: ALTER TABLE mailbox.departments DROP COLUMN business_id;
--           DROP TABLE mailbox.businesses; then revert lib/crm + app/api/crm/businesses.

ALTER TABLE mailbox.departments
  ADD COLUMN IF NOT EXISTS business_id INTEGER
  REFERENCES mailbox.businesses(id) ON DELETE SET NULL;
```
Copy this exact shape for `mailbox.accounts.business_id`:
```sql
ALTER TABLE mailbox.accounts
  ADD COLUMN IF NOT EXISTS business_id INTEGER
  REFERENCES mailbox.businesses(id) ON DELETE SET NULL;
```

**Analog 2 (add-nullable → backfill → SET NOT NULL DO-block, the precedent for `slug`):** `dashboard/migrations/036-account-scope-persona-kb-v2-2026-05-28.sql`

```sql
-- 1. persona — add the account_id dimension migration 033 skipped.
DO $$
DECLARE
  default_acct integer;
BEGIN
  SELECT id INTO default_acct FROM mailbox.accounts WHERE is_default;
  IF default_acct IS NULL THEN
    RAISE EXCEPTION 'no default account — migration 033 must run before 035';
  END IF;

  ALTER TABLE mailbox.persona ADD COLUMN IF NOT EXISTS account_id integer;
  UPDATE mailbox.persona SET account_id = default_acct WHERE account_id IS NULL;
  EXECUTE format('ALTER TABLE mailbox.persona ALTER COLUMN account_id SET DEFAULT %s', default_acct);
  ALTER TABLE mailbox.persona ALTER COLUMN account_id SET NOT NULL;
  ALTER TABLE mailbox.persona
    ADD CONSTRAINT persona_account_fk FOREIGN KEY (account_id) REFERENCES mailbox.accounts(id);
END $$;
```
This is the idiom for `slug`: `ADD COLUMN IF NOT EXISTS slug TEXT` (nullable) → app-level or DO-block loop to compute+`UPDATE` each business row with a generated slug → `ALTER COLUMN slug SET NOT NULL` → `ADD CONSTRAINT ... UNIQUE (slug)`. Note migration 033's original DO-block (below) is the "compute per-row, one seeded default" flavor — 057's backfill is closer to 036 because there is no single default value, each business needs its own computed slug (a `FOREACH`/cursor loop over `mailbox.businesses`, not a scalar `UPDATE ... SET x = default_acct`).

**Analog 3 (real DML backfill — the header-comment convention when a migration IS a backfill, not schema-only):** `dashboard/migrations/033-add-account-id-multi-account-v1-2026-05-28.sql`

```sql
-- BACKFILL DETERMINISM (the S2 question, PASS): M1 is single-account today, so
--       every historical row belongs to the one connected mailbox. All rows
--       backfill to a single seeded `accounts` row → fully deterministic, no
--       manual surgery, DR-43 kill criterion NOT triggered. ...
-- NON-BREAKING BY DESIGN: every account_id column is given a DEFAULT pointing at
--       the seeded default account. ...
```
This is the "explain why the backfill is deterministic/non-destructive" comment block CLAUDE.md's migration-007 standard implicitly requires when a migration carries DML. 057's header must include an equivalent **BACKFILL** section explaining the D-09/D-10/D-16 resolution rule (display_label → domain match → free-mail-excluded), since it's the same "backfill is a live test of the runtime rule" situation as 033.

**Analog 4 (a migration reverted by a later one — precedent for documenting reversal, relevant background only, not directly reused by 057):** `dashboard/migrations/043-rename-sender-overrides-to-never-spam-v1-2026-05-30.sql`

```sql
-- Migration 043 — MBOX-370: evolve the sender override into a never-spam allowlist.
-- (Numbered 043, not 042 — MBOX-369's 042-add-inbox-message-actions landed on
--  master first; renumbered before any persistent apply to keep numbers unique.)
-- WHAT: Repurposes mailbox.sender_classification_overrides (migration 041) from a
--       "force this sender to category X" table into mailbox.sender_never_spam ...
```
Not needed for 057 (nothing here is being reverted) — cited only because the executor asked for the reversal precedent. Flagging so the executor doesn't spend time hunting: **there is no conflicting migration to revert for Phase 5.**

**Legacy slug seed (D-14, one row):**
```sql
UPDATE mailbox.businesses SET slug = 'altitude' WHERE name = 'Altitude Guitar';
```
Confirm the target row's exact `name` against live data before writing (D-09 lists it as `Altitude Guitar`, id 2).

---

### Slug-generation utility

**No direct pure-fn analog with the exact kebab/ASCII-fold shape exists in this repo.** Closest structural analog for "small exported pure function(s), no I/O" is `dashboard/lib/classification/preclass.ts`:

```typescript
function splitEnv(value: string | undefined, fallback: string): string[] {
  return (value ?? fallback)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export const OPERATOR_DOMAINS: ReadonlyArray<string> = splitEnv(
  process.env.OPERATOR_DOMAINS,
  'heronlabsinc.com',
);
```
Follow this file's conventions: plain exported `function`, no class, top-of-file header comment explaining WHAT/WHY/config knobs, `ReadonlyArray`/`const` for exported constants. Collision-suffixing (`-2`, `-3`, ...) needs a DB round-trip (check `mailbox.businesses.slug` existence) — that part belongs in the CRM get-or-create helper (query layer), not the pure slug function; keep `generateSlug(name): string` pure and put "append -2 on collision" as a thin loop in the caller (`lib/crm/queries.ts`), mirroring how `preclass.ts`'s pure helpers are consumed by the DB-touching classify path elsewhere.

---

### Free-mail-domain constant + email-domain extraction helper

**Analog:** `dashboard/lib/classification/preclass.ts`

```typescript
function splitEnv(value: string | undefined, fallback: string): string[] {
  return (value ?? fallback)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export const OPERATOR_DOMAINS: ReadonlyArray<string> = splitEnv(
  process.env.OPERATOR_DOMAINS,
  'heronlabsinc.com',
);
```
and (domain compare against list):
```typescript
const domain = extractDomain(addr);
return Boolean(domain && OPERATOR_DOMAINS.includes(domain));
```
D-07's free-mail-domain constant should mirror this exactly: `export const FREE_MAIL_DOMAINS: ReadonlyArray<string> = [...]` (lowercased, one exported constant, no env override needed since D-07 doesn't call for one — but consider following the `splitEnv`-style export pattern if Phase 6/7 might want an env override later; not required this phase).

For email-domain extraction, this repo already has an `extractDomain`/`extractAddress` pair in `preclass.ts` — **do not duplicate**; either import `extractDomain` from `lib/classification/preclass.ts` directly (if it doesn't create a bad dependency direction from `lib/crm` → `lib/classification`) or copy its exact one-line logic (angle-bracket-aware, lowercased, `split('@')[1]`) into the new helper. Confirm the exact signature before importing cross-module — `preclass.ts` is classification-domain, `lib/crm` is CRM-domain; if cross-import feels wrong, duplicate the ~3-line function with a comment noting it mirrors `preclass.ts:extractDomain`.

The sibling-domain-match query itself (D-16) is plain SQL, not a helper function:
```sql
SELECT business_id FROM mailbox.accounts
 WHERE split_part(email_address, '@', 2) = $domain
   AND business_id IS NOT NULL
 ORDER BY id LIMIT 1
```
This mirrors `dashboard/lib/queries-sender-allowlist.ts`'s bare-address SQL extraction idiom:
```typescript
const BARE_ADDR_SQL = sql<string>`lower(coalesce(substring(from_addr from '<([^>]+)>'), trim(from_addr)))`;
```
i.e., this codebase's convention is to do address/domain parsing in SQL via `sql<string>` template tags (Kysely) or bare parameterized SQL (`pg`) rather than fetching rows and filtering in JS — follow that, use `split_part(...)` in SQL directly as shown above.

---

### Idempotent find-or-create-business helper (`dashboard/lib/crm/queries.ts`)

**Analog 1 (what NOT to reuse as-is):** `dashboard/lib/crm/queries.ts:121`
```typescript
export async function createBusiness(name: string, description = ''): Promise<Business> {
  const { rows } = await getPool().query<Business>(
    'INSERT INTO mailbox.businesses (name, description) VALUES ($1, $2) RETURNING *',
    [name, description],
  );
  return rows[0];
}
```
Bare INSERT, throws unique_violation on reuse. Per D-08, do not touch this function's contract — add a new function alongside it, e.g. `findOrCreateBusinessByName(name): Promise<{id: number; created: boolean}>`.

**Analog 2 (idempotent upsert idiom, Kysely — cross-reference for shape only, since crm/queries.ts is raw `pg` not Kysely):** `dashboard/lib/queries-sender-allowlist.ts`
```typescript
export async function upsertNeverSpam(email: string, reason: string | null): Promise<void> {
  await getKysely()
    .insertInto('sender_never_spam')
    .values({ email, reason, created_by: 'operator' })
    .onConflict((oc) => oc.column('email').doUpdateSet({ reason, updated_at: sql<string>`NOW()` }))
    .execute();
}
```
The raw-`pg` equivalent for `lib/crm/queries.ts` (D-08's locked shape):
```typescript
export async function findOrCreateBusiness(name: string): Promise<{ id: number; created: boolean }> {
  const ins = await getPool().query<{ id: number }>(
    `INSERT INTO mailbox.businesses (name) VALUES ($1)
     ON CONFLICT (name) DO NOTHING RETURNING id`,
    [name],
  );
  if (ins.rows[0]) return { id: ins.rows[0].id, created: true };
  const sel = await getPool().query<{ id: number }>(
    'SELECT id FROM mailbox.businesses WHERE name = $1',
    [name],
  );
  return { id: sel.rows[0].id, created: false };
}
```
This is a direct extrapolation of D-08's stated shape — no other `ON CONFLICT ... DO NOTHING RETURNING` + fallback-`SELECT` precedent exists in `dashboard/lib/**` today (grep found none beyond the Kysely `doUpdateSet` idiom above); this is the first instance of that exact idiom in the codebase, so match it to D-08's literal wording rather than any single existing file.

---

### Shared internal seam in `dashboard/lib/queries-accounts.ts`

**Analog (the two branches — sentinel-adopt vs insert — that the new `persistAccount()` helper must unify and that the hook must cover BOTH of):** `dashboard/lib/queries-accounts.ts` (`createImapAccount`, near line 128; `createMicrosoftAccount`, near line 186)

```typescript
const SENTINEL_DEFAULT_EMAIL = 'primary@appliance.local';

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

  if (def && def.email_address === SENTINEL_DEFAULT_EMAIL) {
    const row = await db
      .updateTable('accounts')
      .set({ email_address: input.email, display_label: input.display_label, provider: 'imap', /* ... */ })
      .where('id', '=', def.id)
      .returning('id')
      .executeTakeFirstOrThrow();
    return { id: row.id, adopted: true };
  }

  const row = await db
    .insertInto('accounts')
    .values({ email_address: input.email, display_label: input.display_label, is_default: false, provider: 'imap', /* ... */ })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { id: row.id, adopted: false };
}
```
`createMicrosoftAccount` is structurally identical (differs only in `provider: 'microsoft'`). Per D-02, factor the shared body (the `def` lookup + adopt-or-insert branch + auto-link call) into one internal `persistAccount()`-style function that both call, plus `createAccount` (:310, plain insert, no adopt branch — see below), and have the auto-link hook live inside that shared function so it fires exactly once regardless of caller.

**`createAccount` (:310, the third caller, insert-only — no sentinel-adopt branch, still must call the same hook):**
```typescript
export async function createAccount(input: {
  email_address: string;
  display_label: string | null;
  provider: MailProviderKind;
  provider_config?: Record<string, unknown>;
}): Promise<AccountDetail> {
  const db = getKysely();
  try {
    const row = await db
      .insertInto('accounts')
      .values({
        email_address: input.email_address,
        display_label: input.display_label,
        provider: input.provider,
        provider_config: sql`${JSON.stringify(input.provider_config ?? {})}::jsonb`,
      })
      .returning(ACCOUNT_DETAIL_COLUMNS)
      .executeTakeFirstOrThrow();
    return row as AccountDetail;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AccountMutationError('duplicate_email', `an inbox with address ${input.email_address} is already connected`);
    }
    throw err;
  }
}
```

**Result-shape precedent (`{id, adopted}` and `{id, created}` — match one of these, house style is a flat 2-key object, never a nested `result.data`):**
- `createImapAccount`/`createMicrosoftAccount` → `Promise<{ id: number; adopted: boolean }>` (above).
- `dashboard/app/api/internal/inbox-messages/route.ts:170-174` →
```typescript
return NextResponse.json({
  id: row.id,
  message_id: row.message_id,
  created: row.created,
});
```
The new `findOrCreateBusiness` helper should return `{ id: number; created: boolean }` (matches the inbox-messages convention, and is more semantically correct for "business row" than `adopted`, which is specific to the sentinel-account concept).

---

### Non-fatal auto-link fire point (D-05)

**Analog:** `dashboard/app/api/internal/inbox-messages/route.ts:144-168, 195-225`

```typescript
// STAQPRO-190 — fire-and-forget embed + Qdrant upsert for newly-inserted
// inbox rows. Skipped on dedup (created=false) since the point already
// exists with deterministic id (idempotent on re-run anyway, but skipping
// saves an Ollama call per 5-min Gmail poll cycle).
//
// Failure is silent on purpose: RAG is augmentation, not gate. The
// response to n8n must not depend on Qdrant/Ollama health, otherwise a
// momentarily-down RAG stack stalls the draft pipeline.
if (row.created && channel === 'email') {
  void embedAndUpsertInbound({ /* ... */ });
}

return NextResponse.json({ id: row.id, message_id: row.message_id, created: row.created });
```
```typescript
async function embedAndUpsertInbound(params: EmbedInboundParams): Promise<void> {
  try {
    const excerpt = buildBodyExcerpt(params.body);
    const input = buildEmbeddingInput(params.subject, excerpt);
    if (!input.trim()) return;
    const vector = await embedText(input);
    if (!vector) return;
    await upsertEmailPoint(vector, { /* ... */ });
  } catch (err) {
    console.error('[rag] inbound embed/upsert failed (non-fatal):', err);
  }
}
```
This is the exact template for D-05: the auto-link call inside `persistAccount()` should be `void autoLinkBusiness(...)`-style OR `await`ed-but-wrapped-in-try/catch (prefer **await + try/catch**, not `void`, since D-05 only requires "non-fatal," not "fire-and-forget" — the account-connect flow is not a hot 5-min polling loop like inbox ingestion, so there's no throughput reason to detach it; awaiting keeps `business_id` populated synchronously in the same request/response, which is better UX for D-06's "silent" requirement — the operator's Accounts page can show the linked business immediately rather than needing a refresh). Keep the `console.error('[...] auto-link failed (non-fatal):', err)` log-and-swallow shape verbatim.

---

### DB-gated test file structure

**Analog:** `dashboard/test/helpers/db.ts` + `dashboard/test/lib/queries-accounts.test.ts:1-50`

```typescript
// test/helpers/db.ts
if (process.env.TEST_POSTGRES_URL && !process.env.POSTGRES_URL) {
  process.env.POSTGRES_URL = process.env.TEST_POSTGRES_URL;
}
const DB_URL = process.env.TEST_POSTGRES_URL ?? process.env.POSTGRES_URL;
export const HAS_DB = Boolean(DB_URL);

let pool: Pool | undefined;
export function getTestPool(): Pool {
  if (!HAS_DB) throw new Error('TEST_POSTGRES_URL/POSTGRES_URL not set');
  if (!pool) pool = new Pool({ connectionString: DB_URL, max: 2 });
  return pool;
}
export async function closeTestPool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}
```
```typescript
// test/lib/queries-accounts.test.ts
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AccountMutationError, /* ... */ } from '@/lib/queries-accounts';
import { closeTestPool, deleteSeededDraft, getTestPool, HAS_DB, type SeededDraft, seedDraft } from '../helpers/db';

const dbDescribe = HAS_DB ? describe : describe.skip;

const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const emailFor = (tag: string) => `v5-${tag}-${stamp}@example.test`;

dbDescribe('queries-accounts CRUD — real Postgres', () => {
  let originalDefaultId: number;
  const createdIds = new Set<number>();
  beforeAll(async () => {
    originalDefaultId = await getDefaultAccountId();
  });
  afterEach(async () => {
    const current = await getDefaultAccountId().catch(() => undefined);
    if (current !== originalDefaultId) {
      await setDefaultAccount(originalDefaultId);
    }
  });
  // ...
});
```
Extend this exact file (`test/lib/queries-accounts.test.ts`) with a new `dbDescribe('auto-link business', ...)` block: same `dbDescribe = HAS_DB ? describe : describe.skip` gate, same `stamp`-suffixed unique test data, same `createdIds`/afterEach cleanup discipline (this suite runs serially against a shared Postgres — must not leak rows other test files assume don't exist). Add pure-function tests for the slug generator and free-mail-domain helper as a separate ungated `describe` (no DB needed) — either colocated `dashboard/lib/crm/slug.test.ts` or under `dashboard/test/lib/`; this repo has no single hard rule for pure-fn test location (no `test/lib/preclass.test.ts` exists to confirm precedent), so colocate next to the new util per common Vitest convention and CLAUDE.md's general "keep helpers near what they support" spirit.

---

### `test/fixtures/schema.sql` mirroring

**Location for the new `accounts.business_id` column** — inside the existing `mailbox.accounts` block:
```
1228: CREATE TABLE IF NOT EXISTS mailbox.accounts (
1229:   id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
1230:   email_address text NOT NULL UNIQUE,
1231:   display_label text,
1232:   is_default    boolean NOT NULL DEFAULT false,
1233:   created_at    timestamptz NOT NULL DEFAULT now(),
1234:   provider        text NOT NULL DEFAULT 'gmail'
1235:     CHECK (provider IN ('gmail', 'imap', 'microsoft')),
1236:   provider_config jsonb NOT NULL DEFAULT '{}'::jsonb
1237: );
1241: CREATE UNIQUE INDEX IF NOT EXISTS accounts_one_default
1242:   ON mailbox.accounts (is_default) WHERE is_default;
```
Add `business_id integer REFERENCES mailbox.businesses(id) ON DELETE SET NULL` as a new column inside the `CREATE TABLE` block (lines 1228-1237) — matching how `departments.business_id` was added directly into departments' `CREATE TABLE` at 1606-1612 (not as a separate `ALTER TABLE` — the fixture, unlike migrations, represents final-state DDL, so add it in place). **Ordering gotcha:** `mailbox.businesses` (needed for the FK) is defined later in the file (:1599) than `mailbox.accounts` (:1228) — Postgres allows forward-referencing a not-yet-created table only via a separate `ALTER TABLE ... ADD COLUMN ... REFERENCES` executed after both tables exist, OR by moving the FK to an `ALTER TABLE` appended after :1612. **Do not inline the FK into the `accounts` CREATE TABLE at :1228** — it will fail at bootstrap since `businesses` doesn't exist yet at that point in the file. Add it as a trailing `ALTER TABLE mailbox.accounts ADD COLUMN IF NOT EXISTS business_id ...` statement placed anywhere after line 1612 (immediately after the `businesses`/`departments` block is the cleanest spot), exactly like migration 053's real form:
```sql
ALTER TABLE mailbox.departments
  ADD COLUMN IF NOT EXISTS business_id INTEGER
  REFERENCES mailbox.businesses(id) ON DELETE SET NULL;
```

**Location for `businesses.slug`** — inside the existing block at :1599-1605:
```
1599: CREATE TABLE IF NOT EXISTS mailbox.businesses (
1600:   id          SERIAL PRIMARY KEY,
1601:   name        TEXT NOT NULL UNIQUE,
1602:   description TEXT NOT NULL DEFAULT '',
1603:   created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
1604:   updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
1605: );
```
Since the fixture represents a fresh, empty database (no existing rows to backfill at bootstrap time), `slug` can be added directly in the `CREATE TABLE` as `slug TEXT NOT NULL UNIQUE` here — unlike the live migration, the fixture has no pre-existing data needing an add-nullable→backfill sequence. This mirrors how the fixture already carries the fully-evolved shape of every other post-hoc-added column (e.g., `accounts.provider` above, added by migration 037 as `NOT NULL DEFAULT 'gmail'` directly in the `CREATE TABLE`, not via ALTER TABLE dance).

**After editing schema.sql:** run `npm run db:codegen` (needs Docker) to regenerate `dashboard/lib/db/schema.ts`, then `npm run db:codegen:verify` by hand (CLAUDE.md landmine: CI does not actually enforce this despite the script comment).

## Shared Patterns

### Migration comment standard (WHAT/WHY/ROLLBACK, + BACKFILL section when DML)
**Source:** `dashboard/migrations/033-...sql` header + `dashboard/migrations/053-...sql` header (both quoted above).
**Apply to:** `057-*.sql`. Trust the filename for the number — CLAUDE.md landmine: migration header comments (052, 053, 056) have historically disagreed with filenames after a PR renumbering; write 057's header with the number 057, don't copy a stale "Migration 0XX" string from a neighbor.

### Non-fatal side-effect after DB write
**Source:** `dashboard/app/api/internal/inbox-messages/route.ts` (`embedAndUpsertInbound`, quoted above).
**Apply to:** the auto-link call inside the shared `queries-accounts.ts` seam. Same try/catch-and-log shape; same "the outer operation's success must never depend on this" comment.

### Raw-SQL domain/address parsing convention
**Source:** `dashboard/lib/queries-sender-allowlist.ts:BARE_ADDR_SQL` + `dashboard/lib/classification/preclass.ts:extractDomain`.
**Apply to:** the sibling-account domain-match query (D-16) and the free-mail-domain check (D-07) — parse in SQL/inline JS the same way these two files do, don't introduce a third parsing convention.

### DB-gated test skip idiom
**Source:** `dashboard/test/helpers/db.ts` (`HAS_DB`) + `dashboard/test/lib/queries-accounts.test.ts` (`dbDescribe`).
**Apply to:** all new auto-link assertions — must skip cleanly with no `TEST_POSTGRES_URL`, never fail CI on a machine without Postgres.

## No Analog Found

| File | Role | Data Flow | Reason |
|---|---|---|---|
| slug-generation pure function itself (kebab-case + ASCII-fold + collision loop) | utility | transform | No existing slugify-style utility anywhere in `dashboard/lib/**` (grepped for "slug", "kebab", "ascii" — no hits outside this phase's own CONTEXT/RESEARCH docs). Use RESEARCH.md's code example as the base implementation; only the *file/test structure* (not the algorithm) has a codebase analog (`preclass.ts` pure-fn style, described above). |

## Conflicts the Executor Must Resolve

1. **`accounts.business_id` FK placement in `test/fixtures/schema.sql`**: the `mailbox.accounts` CREATE TABLE (:1228) textually precedes `mailbox.businesses` (:1599) in the fixture file, but the FK needs `businesses` to exist first. Resolve by adding `business_id` via a trailing `ALTER TABLE` statement after both tables are defined (mirrors the real 053 migration's own `departments.business_id` `ALTER TABLE`), **not** by inlining it into the `accounts` CREATE TABLE block. Executor must not blindly follow "add business_id where the executor comment says ~line 1228" literally as an in-place CREATE TABLE edit — it needs a bootstrap-order-safe placement.
2. **`{id, adopted}` vs `{id, created}` result-shape convention**: two different flag names exist in this codebase for "was this freshly created." Recommendation above is `{id, created}` (inbox-messages convention) for the new business helper, since `adopted` is semantically tied to the sentinel-account-claim concept specific to `queries-accounts.ts` and doesn't fit "did we just insert a new business row." Flagging so the executor doesn't have to guess which house style wins — pick `created` for anything CRM-side, keep `adopted` only for the existing account sentinel logic.
3. **Fire-and-forget (`void`) vs awaited-with-try/catch for the non-fatal hook**: the closest analog (`inbox-messages`) uses `void` fire-and-forget because it's on a high-frequency polling path (RAG augmentation must not add latency to every 5-min ingest). The account-connect path is low-frequency (a handful of times ever per appliance) and D-05/D-06 imply the caller may want `business_id` populated in the same response. Recommendation: **await + try/catch**, not `void`. Flagging because copying the `inbox-messages` pattern literally (`void`) would also satisfy "non-fatal" but produce a worse UX (`business_id` might still be null in the immediate response even on success, due to a race). Executor's call per CONTEXT.md's "Claude's Discretion" on internal helper naming/shape — but not free to silently pick `void` without noting the tradeoff.
