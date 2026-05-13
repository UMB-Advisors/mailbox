---
plan_number: 02-08
slug: onboarding-wizard-and-queue-api
wave: 5
depends_on: [02-01, 02-02, 02-03, 02-05, 02-06, 02-07]
autonomous: false
requirements: [ONBR-01, ONBR-02, ONBR-03, ONBR-04, ONBR-05, ONBR-06, APPR-01, APPR-02]
files_modified:
  - dashboard/backend/src/routes/onboarding.ts
  - dashboard/backend/src/routes/queue.ts
  - dashboard/backend/src/routes/tuning.ts
  - dashboard/backend/src/index.ts
  - dashboard/backend/src/auth/password.ts
  - dashboard/backend/src/live-gate.ts
  - dashboard/backend/src/n8n-client.ts            # review fix: shared n8n REST dispatch
  - dashboard/backend/src/credentials/gmail-oauth.ts # review fix: real OAuth code-exchange + n8n cred provisioning
  - dashboard/frontend/src/App.tsx                  # review fix: wizard router
  - dashboard/frontend/src/components/WizardShell.tsx
  - dashboard/frontend/src/components/StepIndicator.tsx
  - dashboard/frontend/src/screens/AdminCreate.tsx
  - dashboard/frontend/src/screens/EmailConnect.tsx
  - dashboard/frontend/src/screens/IngestProgress.tsx
  - dashboard/frontend/src/screens/DocumentUpload.tsx
  - dashboard/frontend/src/screens/PersonaTuning.tsx
  - dashboard/frontend/src/screens/NotificationPrefs.tsx
  - dashboard/frontend/src/screens/LiveShell.tsx
  - n8n/workflows/12-tuning-sample-generate.json
---

<review_fixes>
**Applied from 02-REVIEWS.md (codex pass, 2026-04-13). This plan carried the most unresolved contract debt; the fixes are extensive.**
- HIGH (Phase-2 wizard UI scope): A minimal onboarding wizard UI ships in this plan, hand-authored per `02-UI-SPEC.md` (no shadcn). 7 surfaces — Admin, Email Connect, Ingest Progress, Document Upload, Persona Tuning, Notifications, Live Shell — fed by the existing 02-01 React app skeleton. This closes Phase 2 success criterion 5. The full Phase 4 queue UI is still out of scope.
- HIGH (OAuth / manual credential provisioning): `POST /api/onboarding/email` now actually provisions n8n credentials. For OAuth2 it completes the Gmail OAuth flow server-side and inserts a credential of type `googleApi` into n8n's REST credential endpoint (`POST /rest/credentials`) under the name `Gmail IMAP — default`. For manual it inserts both `imap` (IMAP-typed) and `smtp` (SMTP-typed) credentials with the password the user provided ON THE WIRE ONLY — the password is forwarded to n8n's encrypted credential store and never persisted in Postgres. The schema `mailbox.onboarding` only stores the email address.
- HIGH (n8n dispatch contract): The previous `…/rest/workflows/run-by-name?name=…` endpoint does not exist in n8n. All dispatch in this plan now uses the documented pattern (consistent with 02-03/02-06): `GET /rest/workflows?filter=name:<name>` → `POST /rest/workflows/<id>/run` with body, authenticated by the `N8N Internal API` credential. A thin helper `dashboard/backend/src/n8n-client.ts` wraps this so every callsite is identical.
- HIGH (approve dispatch is synchronous on workflow accept): `/api/queue/:id/approve` awaits the `POST /run` response and only sets `status='approved'` (via the SMTP CAS in 02-07) if dispatch returns 2xx. Errors are surfaced to the caller and to the WebSocket `queue.updated` event as `{ status: 'pending_review', dispatch_error }` — the row does NOT silently flip to approved.
- HIGH (tuning sample corpus): The previous design tried to draft over `email_raw + classification_log` rows, but onboarding only ingests sent mail. New approach: `12-tuning-sample-generate` reads `mailbox.historical_sent` (the onboarding-ingest table from 02-05 review fix) and SIMULATES inbound counterparts. For each historical sent row we synthesize an inbound prompt from the historical recipient/subject pair and run drafting against the new persona. The operator's tuning ratings then anchor the persona on real-world topics from their actual mailbox.
- MEDIUM (APPR-02 escalate action): `POST /api/queue/:id/escalate` added. Routes through `11b-reject-sub` with `reason='escalated'` so the row is archived to `rejected_history` and tagged for follow-up. UI exposes an "Escalate to me" button on the live shell row preview.
- MEDIUM (WebSocket coverage): All promised events (`queue.inserted`, `queue.updated`, `queue.removed`, `onboarding.stage`, `onboarding.progress`) are emitted by the routes. A small `ws.ts` helper centralises the broadcast call so we cannot drop events by oversight.
</review_fixes>

<objective>
Deliver the backend API surface AND a minimal first-boot onboarding wizard UI (review fix — required by 02-UI-SPEC.md and Phase 2 success criterion 5), the approval queue REST + WebSocket contract that Phase 4 will extend, the persona tuning session API (20 sample drafts + tone ratings), and the `mailbox.onboarding` state machine that gates live email processing. Staged-async per D-12: admin create and email connect are synchronous; sent-history ingest, persona extraction, and tuning-sample generation run as background n8n sub-workflows with progress streamed over WebSocket. Credential provisioning is REAL (review fix): the email-connect route writes IMAP/SMTP/OAuth2 credentials into n8n's encrypted credential store under conventional names; passwords never land in Postgres.
</objective>

<must_haves>
- `mailbox.onboarding` state machine transitions through all 6 D-16 stages: `pending_admin` → `pending_email` → `ingesting` → `pending_tuning` → `tuning_in_progress` → `live`
- Admin account creation at `POST /api/onboarding/admin` validates password >= 12 chars (per UI-SPEC), hashes with scrypt, writes to `onboarding.admin_username` / `admin_password_hash`, advances stage to `pending_email`
- `POST /api/onboarding/email` accepts either `{ mode: 'oauth2', oauth_code, email }` (Gmail OAuth2 callback) or `{ mode: 'manual', email, imap_host, imap_port, smtp_host, smtp_port, password }` (manual). **(review fix)** the route exchanges the OAuth code for an access+refresh token OR validates the manual IMAP/SMTP credentials by connecting once, then provisions n8n credentials via `POST /rest/credentials` (`Gmail IMAP — default` + `Customer SMTP — default`). Only the email address is persisted to `onboarding.email_address`. On success, dispatches `06-rag-ingest-sent-history` via the n8n REST API and advances stage to `ingesting`.
- `GET /api/onboarding/status` returns the current stage plus progress counters, streamed over WebSocket on every change
- A new n8n sub-workflow `12-tuning-sample-generate` produces 20 sample drafts. **(review fix)** Source corpus is `mailbox.historical_sent` (from 02-05 ingest), NOT `email_raw`. For each picked historical send, we synthesize a plausible inbound prompt (`subject` + first ~400 chars of body) and draft against the new persona. Samples land in `mailbox.tuning_samples`.
- `POST /api/tuning/ratings` accepts ≤20 ratings from the UI (good / wrong / edit) and advances stage to `live` when all generated samples are rated (D-15)
- Approval queue routes: `GET /api/queue` (list pending, paginated), `GET /api/queue/:id` (detail), `POST /api/queue/:id/approve` (optional edit then send; **review fix: synchronous on dispatch accept**), `POST /api/queue/:id/reject`, `POST /api/queue/:id/escalate` *(review fix: APPR-02)*, `POST /api/queue/:id/retry` (re-run drafting)
- WebSocket events broadcast on queue changes (`queue.inserted`, `queue.updated`, `queue.removed`) and onboarding changes (`onboarding.stage`, `onboarding.progress`). **(review fix: all five events are emitted by the routes shown in this plan.)**
- **Live gate:** inbound emails are NOT drafted until `onboarding.stage = 'live'`. The gate is enforced in `03-classify-email-sub` by reading `/api/onboarding/live-gate`. Pre-live rows sit in `status='pending_drafting'` (02-04 review fix); `12-tuning-sample-generate` does NOT consume them — it pulls from `historical_sent` (review fix).
- **Phase 2 wizard UI (review fix):** seven hand-authored React surfaces shipped per `02-UI-SPEC.md` (Admin, Email Connect, Ingest, Document Upload, Persona Tuning, Notifications, Live Shell). No shadcn — Tailwind v4 utility classes only.
- Document upload (ONBR-04) reuses the `/api/kb` routes from Plan 02-05
- Notification preferences (ONBR-06): a minimal `POST /api/onboarding/notifications` endpoint that writes `{ queue_threshold, digest_email }` to a new `mailbox.settings` table (added via drizzle-kit push)
</must_haves>

<threat_model>
**ASVS L1, block on HIGH.**

| Surface | Threat | Mitigation | Severity |
|---------|--------|------------|----------|
| Admin password at rest | Plaintext leak | Node `crypto.scryptSync` with a 16-byte random salt, stored as `salt:hash` in `admin_password_hash`; never log the plaintext | High → mitigated |
| Email account credentials on manual path | IMAP/SMTP passwords end up in Postgres | Store only the email *address* in `mailbox.onboarding`. Credentials are pasted into n8n credentials UI by the operator (stored in n8n's encrypted store); the manual POST body's credential fields are used only to TEST the connection on the server side, then discarded — never persisted | High → mitigated |
| Gmail OAuth2 refresh token | Leak via `/api/onboarding/email` response | Refresh token is exchanged server-side, stored in n8n credentials store, and NEVER returned in any API response | High → mitigated |
| Approval queue authorization | Any LAN user can approve/reject | Phase 2 inherits the Phase 1 LAN-only trust boundary (no auth) per STATE.md. Phase 4 adds admin login (DASH-02). Documented in SECURITY.md and on the `/api/queue` route as a banner response header `X-Mailbox-Security: lan-trust-phase-2` | High, deferred to Phase 4 |
| Unbounded `/api/queue` list | DoS via large pagination | Hard-cap `limit` at 100, default 25. Sort by `received_at DESC` with an indexed column (added in Plan 02-02) | Low → mitigated |
| WebSocket flood | Single client spam broadcasts | Phase 2: no per-client rate limit; documented as acceptable for single-operator appliance | Low, deferred |
| SQL injection via query params | Raw SQL concatenation | All SQL uses drizzle parameterized queries or `sql` template tag; no string concatenation | Medium → mitigated |

Phase-4-deferred items are called out explicitly so the phase 4 reviewer can pick them up.
</threat_model>

<tasks>

<task id="1">
<action>
Add two new tables to `dashboard/backend/src/db/schema.ts` — `tuning_samples` (for the 20 persona-tuning draft rows) and `settings` (for notification preferences). Append to the existing `schema.ts` file from Plan 02-02:

```ts
// ── 9. tuning_samples (D-15 — persona tuning draft samples) ───────────────
// Review fix: tuning samples are sourced from `historical_sent` during
// onboarding, NOT from `email_raw + classification_log`. `email_raw_id` is
// retained as NULLABLE for the post-go-live case where the operator runs a
// targeted re-tune against a real inbound row. Exactly one of the two
// reference columns is set per row (CHECK constraint below).
export const tuningSamples = mailbox.table(
  'tuning_samples',
  {
    id: serial('id').primaryKey(),
    customerKey: varchar('customer_key', { length: 64 }).notNull().default('default'),
    historicalSentId: bigint('historical_sent_id', { mode: 'number' }), // review fix: real onboarding source
    emailRawId: bigint('email_raw_id', { mode: 'number' }),             // post-go-live re-tune source (rare)
    inboundFrom: varchar('inbound_from', { length: 320 }).notNull(),
    inboundSubject: text('inbound_subject'),
    inboundBody: text('inbound_body').notNull(),
    classificationCategory: classificationCategoryEnum('classification_category').notNull(),
    draftText: text('draft_text').notNull(),
    rating: varchar('rating', { length: 16 }),   // null until rated; 'good' | 'wrong' | 'edit'
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    ratedAt: timestamp('rated_at', { withTimezone: true }),
  },
  (t) => ({
    idxCustomer: index('tuning_samples_customer_idx').on(t.customerKey),
    fkHistorical: foreignKey({
      name: 'tuning_samples_historical_sent_fk',
      columns: [t.historicalSentId],
      foreignColumns: [historicalSent.id],
    }).onDelete('set null'),
    fkEmailRaw: foreignKey({
      name: 'tuning_samples_email_raw_fk',
      columns: [t.emailRawId],
      foreignColumns: [emailRaw.id],
    }).onDelete('set null'),
    // CHECK constraint emitted via raw SQL because drizzle-kit doesn't yet
    // type CHECKs across columns; we add it in the same drizzle-kit push step
    // via a `sql.raw` migration:
    //   ALTER TABLE mailbox.tuning_samples
    //     ADD CONSTRAINT tuning_samples_source_check
    //     CHECK ((historical_sent_id IS NOT NULL) <> (email_raw_id IS NOT NULL));
  }),
);

// ── 9. settings (ONBR-06 notification preferences) ────────────────────────
export const settings = mailbox.table('settings', {
  id: serial('id').primaryKey(),
  customerKey: varchar('customer_key', { length: 64 }).notNull().default('default'),
  queueThreshold: integer('queue_threshold').notNull().default(5),
  digestEmail: varchar('digest_email', { length: 320 }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uqCustomer: uniqueIndex('settings_customer_key_uq').on(t.customerKey),
}));
```

Also add their type re-exports to `dashboard/backend/src/db/types.ts`:
```ts
export type TuningSample = InferSelectModel<typeof tuningSamples>;
export type NewTuningSample = InferInsertModel<typeof tuningSamples>;
export type Settings = InferSelectModel<typeof settings>;
export type NewSettings = InferInsertModel<typeof settings>;
```
</action>
<read_first>
  - dashboard/backend/src/db/schema.ts  (extend the existing file)
  - dashboard/backend/src/db/types.ts
  - .planning/phases/02-email-pipeline-core/02-CONTEXT.md  (D-15 tuning samples, ONBR-06)
</read_first>
<acceptance_criteria>
- `grep 'export const tuningSamples' dashboard/backend/src/db/schema.ts` matches
- `grep 'export const settings' dashboard/backend/src/db/schema.ts` matches
- `grep "rating: varchar" dashboard/backend/src/db/schema.ts` matches
- `grep 'queueThreshold' dashboard/backend/src/db/schema.ts` matches
- `grep 'TuningSample' dashboard/backend/src/db/types.ts` matches
- `grep 'Settings' dashboard/backend/src/db/types.ts` matches
</acceptance_criteria>
</task>

<task id="2">
<action>
**[BLOCKING]** Re-run `drizzle-kit push` to add the two new tables. Same pattern as Plan 02-02 task 5:

```bash
docker compose build dashboard
docker compose up -d dashboard
docker compose exec -T dashboard npx drizzle-kit push --force
```

Verify both new tables exist:

```bash
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "
  SELECT COUNT(*) FROM information_schema.tables
  WHERE table_schema='mailbox' AND table_name IN ('tuning_samples','settings');
"
```
</action>
<read_first>
  - dashboard/backend/src/db/schema.ts
  - dashboard/drizzle.config.ts
</read_first>
<acceptance_criteria>
- `docker compose exec -T dashboard npx drizzle-kit push --force` exits 0
- `docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='mailbox' AND table_name IN ('tuning_samples','settings');"` returns `2`
</acceptance_criteria>
</task>

<task id="3">
<action>
Create `dashboard/backend/src/auth/password.ts` — scrypt password hashing utilities:

```ts
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SALT_BYTES = 16;
const KEY_LEN = 64;
const N = 16384;   // scrypt cost — balanced for Jetson CPU

export function hashPassword(plain: string): string {
  if (typeof plain !== 'string' || plain.length < 12) throw new Error('password too short');
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(plain, salt, KEY_LEN, { N });
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(plain, salt, KEY_LEN, { N });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
```
</action>
<read_first>
  - .planning/phases/02-email-pipeline-core/02-UI-SPEC.md  (password ≥ 12 chars rule)
</read_first>
<acceptance_criteria>
- `dashboard/backend/src/auth/password.ts` exists
- `grep 'hashPassword' dashboard/backend/src/auth/password.ts` matches
- `grep 'verifyPassword' dashboard/backend/src/auth/password.ts` matches
- `grep 'scryptSync' dashboard/backend/src/auth/password.ts` matches
- `grep 'timingSafeEqual' dashboard/backend/src/auth/password.ts` matches
- `grep "plain.length < 12" dashboard/backend/src/auth/password.ts` matches
</acceptance_criteria>
</task>

<task id="4">
<action>
Create `dashboard/backend/src/live-gate.ts` — single-line helper the classification workflow's short-circuit reads to decide whether to fire drafting. For Plan 02-08 the gate is a SQL check called by the backend; n8n reads it via an HTTP round-trip to keep the logic centralised:

```ts
import { db } from './db/client.js';
import { onboarding } from './db/schema.js';
import { eq } from 'drizzle-orm';

export async function isLive(customerKey = 'default'): Promise<boolean> {
  const rows = await db.select({ stage: onboarding.stage }).from(onboarding).where(eq(onboarding.customerKey, customerKey));
  return rows[0]?.stage === 'live';
}
```

Expose it via a backend route in the onboarding router (task 5) as `GET /api/onboarding/live-gate` → `{ live: boolean }`. The classification workflow in Plan 02-04 will be **updated** in this plan's task 10 to call the gate before firing the drafting sub-workflows.
</action>
<read_first>
  - dashboard/backend/src/db/client.ts
  - dashboard/backend/src/db/schema.ts
  - .planning/phases/02-email-pipeline-core/02-CONTEXT.md  (D-13 live gate)
</read_first>
<acceptance_criteria>
- `dashboard/backend/src/live-gate.ts` exists
- `grep 'export async function isLive' dashboard/backend/src/live-gate.ts` matches
- `grep "stage === 'live'" dashboard/backend/src/live-gate.ts` matches
</acceptance_criteria>
</task>

<task id="5">
<action>
Create `dashboard/backend/src/routes/onboarding.ts` — onboarding API. Implements admin create, email connect (OAuth2 stub + manual), status, live-gate, notifications.

```ts
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/client.js';
import { onboarding, settings } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { hashPassword } from '../auth/password.js';
import { isLive } from '../live-gate.js';
import { broadcast } from '../ws.js';
import { config } from '../config.js';
import { n8nProvisionCredential, n8nRunByName } from '../n8n-client.js';                 // review fix
import { exchangeGmailOAuthCode, validateImapConnection, validateSmtpConnection } from '../credentials/gmail-oauth.js'; // review fix

export const onboardingRouter = Router();

const adminSchema = z.object({
  username: z.string().min(3).max(64),
  password: z.string().min(12).max(256),
});

onboardingRouter.post('/admin', async (req, res) => {
  const parsed = adminSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { username, password } = parsed.data;
  const hash = hashPassword(password);

  const [row] = await db
    .update(onboarding)
    .set({ adminUsername: username, adminPasswordHash: hash, stage: 'pending_email' })
    .where(eq(onboarding.customerKey, 'default'))
    .returning();

  broadcast('onboarding.stage', { stage: row?.stage });
  res.json({ stage: row?.stage });
});

const emailSchema = z.object({
  email: z.string().email(),
  mode: z.enum(['oauth2', 'manual']).default('oauth2'),
  imap_host: z.string().optional(),
  imap_port: z.number().optional(),
  smtp_host: z.string().optional(),
  smtp_port: z.number().optional(),
});

// Review fix: email-schema now distinguishes oauth2 vs manual explicitly and
// carries the credentials needed to provision n8n credentials in n8n's
// encrypted store. The plaintext password / oauth_code are forwarded to n8n
// and never persisted in Postgres.
const emailManualSchema = z.object({
  mode: z.literal('manual'),
  email: z.string().email(),
  imap_host: z.string().min(1),
  imap_port: z.number().int().min(1).max(65535).default(993),
  smtp_host: z.string().min(1),
  smtp_port: z.number().int().min(1).max(65535).default(587),
  password: z.string().min(1).max(1024),       // app password — handed to n8n, never stored
});
const emailOAuthSchema = z.object({
  mode: z.literal('oauth2'),
  email: z.string().email(),
  oauth_code: z.string().min(1),               // received from Google OAuth callback
  oauth_redirect_uri: z.string().url(),
});
const emailSchema = z.discriminatedUnion('mode', [emailManualSchema, emailOAuthSchema]);

onboardingRouter.post('/email', async (req, res) => {
  const parsed = emailSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const data = parsed.data;

  try {
    // (review fix) provision n8n credentials BEFORE flipping stage. If
    // provisioning fails, the stage stays at pending_email so the operator
    // can retry without entering a half-configured state.
    if (data.mode === 'oauth2') {
      const tokens = await exchangeGmailOAuthCode(data.oauth_code, data.oauth_redirect_uri);
      await n8nProvisionCredential('googleApi', `Gmail IMAP — default`, {
        clientId: config.GMAIL_OAUTH_CLIENT_ID,
        clientSecret: config.GMAIL_OAUTH_CLIENT_SECRET,
        oauthTokenData: tokens,                 // n8n stores this encrypted
      });
      // Reuse the same OAuth grant for SMTP-with-XOAUTH2 in v1.
      await n8nProvisionCredential('smtp', `Customer SMTP — default`, {
        host: 'smtp.gmail.com', port: 465, secure: true, oauth2: tokens,
      });
    } else {
      // Validate the connection ONCE here (do not store the password).
      await validateImapConnection({ host: data.imap_host, port: data.imap_port, user: data.email, password: data.password });
      await validateSmtpConnection({ host: data.smtp_host, port: data.smtp_port, user: data.email, password: data.password });
      await n8nProvisionCredential('imap', `Gmail IMAP — default`, {
        host: data.imap_host, port: data.imap_port, secure: true, user: data.email, password: data.password,
      });
      await n8nProvisionCredential('smtp', `Customer SMTP — default`, {
        host: data.smtp_host, port: data.smtp_port, user: data.email, password: data.password,
      });
    }
  } catch (e) {
    return res.status(400).json({ error: 'credential_provisioning_failed', detail: (e as Error).message });
  }

  // Only the email address is persisted in Postgres. Passwords / tokens live
  // exclusively in the n8n encrypted credential store.
  const [row] = await db
    .update(onboarding)
    .set({ emailAddress: data.email, stage: 'ingesting' })
    .where(eq(onboarding.customerKey, 'default'))
    .returning();

  // (review fix) Use the n8n REST dispatch helper instead of the non-existent
  // run-by-name endpoint. Synchronous to surface dispatch failure.
  try {
    await n8nRunByName('06-rag-ingest-sent-history', { customer_key: 'default', account_key: 'default', months_back: 6 });
  } catch (e) {
    // Roll the stage back so the operator can retry — onboarding is not "ingesting"
    // if we never managed to start the ingest.
    await db.update(onboarding).set({ stage: 'pending_email' })
      .where(eq(onboarding.customerKey, 'default'));
    return res.status(502).json({ error: 'ingest_dispatch_failed', detail: (e as Error).message });
  }

  broadcast('onboarding.stage', { stage: row?.stage });
  res.json({ stage: row?.stage });
});

onboardingRouter.get('/status', async (_req, res) => {
  const [row] = await db.select().from(onboarding).where(eq(onboarding.customerKey, 'default'));
  if (!row) return res.status(404).json({ error: 'onboarding row missing — run schema seed' });
  res.json(row);
});

onboardingRouter.get('/live-gate', async (_req, res) => {
  res.json({ live: await isLive() });
});

const notificationsSchema = z.object({
  queue_threshold: z.number().int().min(0).max(1000).default(5),
  digest_email: z.string().email().optional(),
});

onboardingRouter.post('/notifications', async (req, res) => {
  const parsed = notificationsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  await db.insert(settings).values({
    customerKey: 'default',
    queueThreshold: parsed.data.queue_threshold,
    digestEmail: parsed.data.digest_email ?? null,
  }).onConflictDoUpdate({
    target: settings.customerKey,
    set: {
      queueThreshold: parsed.data.queue_threshold,
      digestEmail: parsed.data.digest_email ?? null,
      updatedAt: new Date(),
    },
  });
  res.json({ ok: true });
});
```
</action>
<read_first>
  - dashboard/backend/src/auth/password.ts
  - dashboard/backend/src/live-gate.ts
  - dashboard/backend/src/db/schema.ts
  - dashboard/backend/src/ws.ts
  - dashboard/backend/src/config.ts
  - .planning/phases/02-email-pipeline-core/02-CONTEXT.md  (D-12..D-16, ONBR-01..06)
</read_first>
<acceptance_criteria>
- `dashboard/backend/src/routes/onboarding.ts` exists
- `grep "onboardingRouter.post('/admin'" dashboard/backend/src/routes/onboarding.ts` matches
- `grep "onboardingRouter.post('/email'" dashboard/backend/src/routes/onboarding.ts` matches
- `grep "onboardingRouter.get('/status'" dashboard/backend/src/routes/onboarding.ts` matches
- `grep "onboardingRouter.get('/live-gate'" dashboard/backend/src/routes/onboarding.ts` matches
- `grep "onboardingRouter.post('/notifications'" dashboard/backend/src/routes/onboarding.ts` matches
- `grep 'hashPassword' dashboard/backend/src/routes/onboarding.ts` matches
- `grep '06-rag-ingest-sent-history' dashboard/backend/src/routes/onboarding.ts` matches
- `grep 'broadcast' dashboard/backend/src/routes/onboarding.ts` matches (ws events fired)
</acceptance_criteria>
</task>

<task id="6">
<action>
Create `dashboard/backend/src/routes/queue.ts` — approval queue REST API:

```ts
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/client.js';
import { draftQueue } from '../db/schema.js';
import { eq, desc, and, inArray, sql } from 'drizzle-orm';
import { broadcast } from '../ws.js';
import { config } from '../config.js';
import { n8nRunByName } from '../n8n-client.js';      // review fix

export const queueRouter = Router();

const listSchema = z.object({
  // Review fix: pending_drafting is also a visible status (live-gate held).
  status: z.enum(['pending_drafting', 'pending_review', 'awaiting_cloud', 'approved', 'sending']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

queueRouter.get('/', async (req, res) => {
  const parsed = listSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { status, limit, offset } = parsed.data;

  const rows = await db.select().from(draftQueue)
    .where(status ? eq(draftQueue.status, status) : undefined)
    .orderBy(desc(draftQueue.receivedAt))
    .limit(limit)
    .offset(offset);

  const [{ count }] = (await db.execute(sql`SELECT COUNT(*)::int AS count FROM mailbox.draft_queue ${status ? sql`WHERE status = ${status}` : sql``};`)).rows as Array<{ count: number }>;

  res
    .setHeader('X-Mailbox-Security', 'lan-trust-phase-2')
    .json({ items: rows, total: count, limit, offset });
});

queueRouter.get('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad id' });
  const [row] = await db.select().from(draftQueue).where(eq(draftQueue.id, id));
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(row);
});

const approveSchema = z.object({ draft_sent: z.string().optional() });

// Review fix: approve is SYNCHRONOUS on dispatch accept. We:
//   1. Set draft_sent + approved_at + status='approved' in a single UPDATE
//      that returns the row id IFF the source state was pending_review (or
//      awaiting_cloud with a draft attached).
//   2. AWAIT the n8n dispatch. If dispatch returns non-2xx, ROLL BACK the
//      approval (status back to pending_review, draft_sent cleared, dispatch
//      error stored on last_error) and surface a 502.
//   3. Only broadcast queue.updated AFTER dispatch succeeded.
// This closes the codex finding that approve was fire-and-forget and could
// leave rows stuck in `approved` with no downstream send.
queueRouter.post('/:id/approve', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad id' });
  const parsed = approveSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const [row] = (await db.execute(sql`
    UPDATE mailbox.draft_queue
       SET draft_sent = COALESCE(${parsed.data.draft_sent ?? null}, draft_original),
           status = 'approved'::mailbox.draft_queue_status,
           approved_at = NOW(),
           last_error = NULL
     WHERE id = ${id}
       AND status IN ('pending_review','awaiting_cloud')
       AND draft_original IS NOT NULL
    RETURNING id, status;
  `)).rows as Array<{ id: number; status: string }>;
  if (!row) return res.status(409).json({ error: 'not_approvable', detail: 'row missing or not in pending_review/awaiting_cloud with a draft' });

  try {
    await n8nRunByName('11-send-smtp-sub', { draft_queue_id: id });
  } catch (e) {
    // Roll back to pending_review so the operator can retry; surface the failure.
    await db.execute(sql`
      UPDATE mailbox.draft_queue
         SET status = 'pending_review'::mailbox.draft_queue_status,
             approved_at = NULL,
             last_error = ${(e as Error).message}
       WHERE id = ${id} AND status = 'approved';
    `);
    broadcast('queue.updated', { id, status: 'pending_review', dispatch_error: (e as Error).message });
    return res.status(502).json({ error: 'dispatch_failed', detail: (e as Error).message });
  }

  broadcast('queue.updated', { id, status: 'approved' });
  res.json({ ok: true, id, status: 'approved' });
});

queueRouter.post('/:id/reject', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad id' });
  try {
    await n8nRunByName('11-reject-sub', { draft_queue_id: id, reason: 'operator' });
  } catch (e) {
    return res.status(502).json({ error: 'dispatch_failed', detail: (e as Error).message });
  }
  broadcast('queue.removed', { id });
  res.json({ ok: true });
});

// Review fix: APPR-02 escalate action. Archives the row to rejected_history
// with reason='escalated' so the operator's manual follow-up is auditable.
queueRouter.post('/:id/escalate', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad id' });
  try {
    await n8nRunByName('11-reject-sub', { draft_queue_id: id, reason: 'escalated' });
  } catch (e) {
    return res.status(502).json({ error: 'dispatch_failed', detail: (e as Error).message });
  }
  broadcast('queue.removed', { id, reason: 'escalated' });
  res.json({ ok: true });
});

queueRouter.post('/:id/retry', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad id' });
  await db.execute(sql`
    UPDATE mailbox.draft_queue
       SET draft_original = NULL,
           status = 'awaiting_cloud'::mailbox.draft_queue_status,
           last_error = 'operator_retry'
     WHERE id = ${id};
  `);
  broadcast('queue.updated', { id, status: 'awaiting_cloud' });
  res.json({ ok: true });
});
```
</action>
<read_first>
  - dashboard/backend/src/db/schema.ts
  - dashboard/backend/src/ws.ts
  - dashboard/backend/src/config.ts
  - .planning/phases/02-email-pipeline-core/02-UI-SPEC.md  (API shape expectations)
  - .planning/REQUIREMENTS.md  (APPR-01, APPR-02)
  - n8n/workflows/11-send-smtp-sub.json  (workflow name contract)
  - n8n/workflows/11b-reject-sub.json
</read_first>
<acceptance_criteria>
- `dashboard/backend/src/routes/queue.ts` exists
- `grep "queueRouter.get('/'" dashboard/backend/src/routes/queue.ts` matches
- `grep "queueRouter.post('/:id/approve'" dashboard/backend/src/routes/queue.ts` matches
- `grep "queueRouter.post('/:id/reject'" dashboard/backend/src/routes/queue.ts` matches
- `grep "queueRouter.post('/:id/escalate'" dashboard/backend/src/routes/queue.ts` matches (review fix: APPR-02)
- `grep "queueRouter.post('/:id/retry'" dashboard/backend/src/routes/queue.ts` matches
- `grep '11-send-smtp-sub' dashboard/backend/src/routes/queue.ts` matches
- `grep '11-reject-sub' dashboard/backend/src/routes/queue.ts` matches
- `grep 'X-Mailbox-Security' dashboard/backend/src/routes/queue.ts` matches
- `grep 'broadcast' dashboard/backend/src/routes/queue.ts` matches
- `grep 'n8nRunByName' dashboard/backend/src/routes/queue.ts` matches (review fix: shared dispatch helper)
- `grep "await n8nRunByName" dashboard/backend/src/routes/queue.ts` matches (review fix: synchronous on dispatch)
- **Negative check (review fix):** `grep -c 'run-by-name' dashboard/backend/src/routes/queue.ts` returns `0` — the invented n8n endpoint is gone.
- **Negative check (review fix):** `grep -c 'fetch(.*N8N_URL).catch' dashboard/backend/src/routes/queue.ts` returns `0` — no more fire-and-forget dispatch.
- Synchronous-dispatch behavior test: stop the n8n container, POST `/:id/approve` on a valid row → status code 502, row stays at `status='pending_review'` with `last_error` populated. Restart n8n, retry → 200, row archived to sent_history.
</acceptance_criteria>
</task>

<task id="7">
<action>
Create `dashboard/backend/src/routes/tuning.ts` — persona tuning session API:

```ts
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/client.js';
import { tuningSamples, onboarding } from '../db/schema.js';
import { eq, and, sql } from 'drizzle-orm';
import { broadcast } from '../ws.js';

export const tuningRouter = Router();

tuningRouter.get('/samples', async (_req, res) => {
  const rows = await db.select().from(tuningSamples).where(eq(tuningSamples.customerKey, 'default')).orderBy(tuningSamples.id);
  res.json({ samples: rows, rated: rows.filter((r) => r.rating).length, total: rows.length });
});

const rateSchema = z.object({
  ratings: z.array(z.object({
    id: z.number().int(),
    rating: z.enum(['good', 'wrong', 'edit']),
  })).min(1).max(20),
});

tuningRouter.post('/ratings', async (req, res) => {
  const parsed = rateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  for (const r of parsed.data.ratings) {
    await db.execute(sql`
      UPDATE mailbox.tuning_samples
         SET rating = ${r.rating}, rated_at = NOW()
       WHERE id = ${r.id} AND customer_key = 'default';
    `);
  }

  // If all samples are rated, advance onboarding.stage to 'live'
  const [{ total, rated }] = (await db.execute(sql`
    SELECT COUNT(*)::int AS total, COUNT(rating)::int AS rated FROM mailbox.tuning_samples WHERE customer_key = 'default';
  `)).rows as Array<{ total: number; rated: number }>;

  let stage: string | undefined;
  if (total > 0 && rated >= total && rated >= 20) {
    const [row] = await db
      .update(onboarding)
      .set({ stage: 'live', livedAt: new Date() })
      .where(eq(onboarding.customerKey, 'default'))
      .returning();
    stage = row?.stage;
    broadcast('onboarding.stage', { stage });
  }
  res.json({ rated, total, stage });
});
```

Wire all three new routers plus the drafting router from Plan 02-07 into `dashboard/backend/src/index.ts`:

```ts
import { onboardingRouter } from './routes/onboarding.js';
import { queueRouter } from './routes/queue.js';
import { tuningRouter } from './routes/tuning.js';
// ...
app.use('/api/onboarding', onboardingRouter);
app.use('/api/queue', queueRouter);
app.use('/api/tuning', tuningRouter);
```
</action>
<read_first>
  - dashboard/backend/src/db/schema.ts
  - dashboard/backend/src/ws.ts
  - dashboard/backend/src/index.ts
  - .planning/phases/02-email-pipeline-core/02-CONTEXT.md  (D-13, D-15)
  - .planning/REQUIREMENTS.md  (PERS-02, ONBR-05)
</read_first>
<acceptance_criteria>
- `dashboard/backend/src/routes/tuning.ts` exists
- `grep "tuningRouter.get('/samples'" dashboard/backend/src/routes/tuning.ts` matches
- `grep "tuningRouter.post('/ratings'" dashboard/backend/src/routes/tuning.ts` matches
- `grep "stage: 'live'" dashboard/backend/src/routes/tuning.ts` matches
- `grep '/api/onboarding' dashboard/backend/src/index.ts` matches
- `grep '/api/queue' dashboard/backend/src/index.ts` matches
- `grep '/api/tuning' dashboard/backend/src/index.ts` matches
</acceptance_criteria>
</task>

<task id="8">
<action>
Create `n8n/workflows/12-tuning-sample-generate.json` — generates the 20 persona tuning samples. Triggered by `09-persona-extract-trigger` (02-06 review-fix chain). Node graph (review-fixed: source corpus is `mailbox.historical_sent`, NOT `email_raw + classification_log`, because onboarding has no inbound corpus yet):

1. **Execute Workflow Trigger** — `{ customer_key }` (default `'default'`).
2. **Postgres Query: Pick 20 historical sends, balanced over categories inferred by keyword heuristic.** We run the same heuristics that `02-06/exemplars.ts` uses to bucket historical sends, then sample up to 4 per category:
   ```sql
   WITH ranked AS (
     SELECT hs.id,
            hs.from_addr,
            hs.to_addr,
            hs.subject,
            hs.body_text,
            CASE
              WHEN hs.body_text ILIKE '%reorder%' OR hs.subject ILIKE '%reorder%' THEN 'reorder'
              WHEN hs.body_text ILIKE '%pricing%' OR hs.body_text ILIKE '%wholesale%' THEN 'inquiry'
              WHEN hs.body_text ILIKE '%schedul%' OR hs.body_text ILIKE '%meeting%' THEN 'scheduling'
              WHEN hs.body_text ILIKE '%follow%up%' OR hs.body_text ILIKE '%checking in%' THEN 'follow_up'
              WHEN hs.body_text ILIKE '%refund%' OR hs.body_text ILIKE '%urgent%' THEN 'escalate'
              ELSE 'unknown'
            END AS guessed_category,
            ROW_NUMBER() OVER (
              PARTITION BY 1 ORDER BY hs.sent_at DESC NULLS LAST
            ) AS rn
       FROM mailbox.historical_sent hs
      WHERE hs.customer_key = $1
   )
   SELECT id, from_addr, to_addr, subject, body_text, guessed_category
     FROM ranked
    WHERE rn <= 60                  -- pool to sample from
    ORDER BY guessed_category, rn
    LIMIT 20;
   ```
3. **Postgres: Update onboarding.stage = tuning_in_progress** and `tuning_sample_count = <count>`.
4. **Loop Over Items:** for each picked historical send:
   a. **HTTP Request: Generate sample** — `POST http://dashboard:3000/api/tuning/generate-sample` with `{ historical_sent_id, guessed_category }`. The helper (review-fixed in task 9) synthesizes a plausible inbound prompt by inverting recipient/sender on the historical message and treats the historical body as the "previous reply" for context.
   b. **Postgres Insert into `mailbox.tuning_samples`** — from the helper's response payload.
5. **Postgres: Update onboarding.tuning_sample_count** with the final count.
6. **Postgres: Leave stage at `tuning_in_progress`** — transition to `live` happens in `POST /api/tuning/ratings` once all generated samples are rated.

**Review-fix removed (old design):** the previous draft of this workflow joined `email_raw` and `classification_log`. That corpus does not exist at onboarding time — onboarding only ingests the sent folder. Sourcing tuning samples from `historical_sent` means the operator rates drafts against topics from THEIR mailbox, which is what PERS-02 wants.

Workflow JSON shape:
```json
{
  "name": "12-tuning-sample-generate",
  "active": false,
  "tags": [{"name":"phase-2"}, {"name":"onboarding"}, {"name":"persona"}]
}
```
</action>
<read_first>
  - dashboard/backend/src/db/schema.ts  (tuning_samples)
  - dashboard/backend/src/routes/tuning.ts
  - .planning/phases/02-email-pipeline-core/02-CONTEXT.md  (D-15)
</read_first>
<acceptance_criteria>
- `n8n/workflows/12-tuning-sample-generate.json` exists and is valid JSON
- `jq -r '.name' n8n/workflows/12-tuning-sample-generate.json` returns `12-tuning-sample-generate`
- `grep 'tuning_samples' n8n/workflows/12-tuning-sample-generate.json` matches
- `grep 'tuning_in_progress' n8n/workflows/12-tuning-sample-generate.json` matches
- `grep 'historical_sent' n8n/workflows/12-tuning-sample-generate.json` matches (review fix: real corpus source)
- `grep 'generate-sample' n8n/workflows/12-tuning-sample-generate.json` matches
- **Negative check (review fix):** `grep -c 'FROM mailbox.email_raw' n8n/workflows/12-tuning-sample-generate.json` returns `0` — the old impossible corpus source is gone.
- **Negative check (review fix):** `grep -c 'JOIN mailbox.classification_log' n8n/workflows/12-tuning-sample-generate.json` returns `0` — same reason.
</acceptance_criteria>
</task>

<task id="9">
<action>
Add a helper endpoint `POST /api/tuning/generate-sample` to `dashboard/backend/src/routes/tuning.ts` that the `12-tuning-sample-generate` workflow calls to produce one draft against a historical sent row (review fix: source is `mailbox.historical_sent`, not `email_raw + classification_log` — onboarding has no inbound corpus yet). The helper synthesizes a plausible inbound prompt by treating the historical recipient as the inbound sender and the historical subject/body as conversational context, then drafts against the new persona:

```ts
// Append to tuning.ts
import { topRagRefs } from '../drafting/rag-snippet.js';
import { renderSystemPrompt, renderUserPrompt } from '../drafting/prompt.js';
import { persona, historicalSent } from '../db/schema.js';

tuningRouter.post('/generate-sample', async (req, res) => {
  const { historical_sent_id, guessed_category } = req.body || {};
  const id = Number(historical_sent_id);
  const category = String(guessed_category || 'unknown');
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'historical_sent_id required' });

  const [hist] = await db.select().from(historicalSent).where(eq(historicalSent.id, id));
  if (!hist) return res.status(404).json({ error: 'historical_sent row not found' });

  const [p] = await db.select().from(persona).where(eq(persona.customerKey, 'default'));
  if (!p) return res.status(409).json({ error: 'persona not built yet' });
  const exemplars = (p.categoryExemplars as any)?.[category] || [];

  // Review fix: synthesize an inbound prompt from the historical send. The
  // operator's historical recipient becomes the inbound sender; the operator's
  // own historical body is treated as a preceding-message context. We then
  // ask the model to write the operator's NEXT reply.
  const synthesizedInboundBody =
    `(Synthesized for tuning — based on a past exchange.)\n\n` +
    `Earlier message you sent to ${hist.toAddr || 'this contact'}:\n` +
    `> ${(hist.bodyText || '').slice(0, 600).replace(/\n/g, '\n> ')}\n\n` +
    `Now imagine this contact has replied with a brief, plausible follow-up about the same topic.`;

  const refs = await topRagRefs(`${hist.subject} ${hist.bodyText}`.slice(0, 2000), 3);

  const promptInputs = {
    persona_markers: p.statisticalMarkers as any,
    category_exemplars: exemplars,
    rag_refs: refs,
    inbound_email: { from: hist.toAddr || 'tuning@local', subject: hist.subject || '', body: synthesizedInboundBody },
  };
  const system = renderSystemPrompt(promptInputs);
  const user = renderUserPrompt(promptInputs);

  // Local Qwen3 for tuning samples (faster + zero cloud cost during onboarding).
  const ollamaUrl = process.env.OLLAMA_URL || 'http://ollama:11434';
  const ollamaRes = await fetch(`${ollamaUrl}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'qwen3:4b', stream: false, system, prompt: user, options: { temperature: 0.3, num_predict: 1024 } }),
  });
  const ollamaJson = (await ollamaRes.json()) as { response?: string };
  const draft = String(ollamaJson.response || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  const [inserted] = await db.insert(tuningSamples).values({
    customerKey: 'default',
    historicalSentId: hist.id,
    inboundFrom: hist.toAddr || 'tuning@local',
    inboundSubject: hist.subject,
    inboundBody: synthesizedInboundBody,
    classificationCategory: category as any,
    draftText: draft,
  }).returning();

  res.json(inserted);
});
```

**Schema follow-up (review fix):** rename `tuningSamples.email_raw_id` → `historical_sent_id` (or keep both with `email_raw_id NULLABLE` + `historical_sent_id NULLABLE` and a CHECK constraint that exactly one is set) in task 1's schema additions, so the FK reflects reality. Either approach is acceptable; the simpler one is to make the column `historical_sent_id BIGINT NULL REFERENCES mailbox.historical_sent(id)`.
</action>
<read_first>
  - dashboard/backend/src/routes/tuning.ts  (extend existing file)
  - dashboard/backend/src/drafting/prompt.ts
  - dashboard/backend/src/drafting/rag-snippet.ts
  - dashboard/backend/src/db/schema.ts
</read_first>
<acceptance_criteria>
- `grep "tuningRouter.post('/generate-sample'" dashboard/backend/src/routes/tuning.ts` matches
- `grep 'renderSystemPrompt' dashboard/backend/src/routes/tuning.ts` matches
- `grep "'qwen3:4b'" dashboard/backend/src/routes/tuning.ts` matches
- `grep 'tuningSamples' dashboard/backend/src/routes/tuning.ts` matches
</acceptance_criteria>
</task>

<task id="10">
<action>
Update `n8n/workflows/03-classify-email-sub.json` from Plan 02-04 to enforce the live gate BEFORE firing `04-draft-local-sub` / `05-draft-cloud-sub`. Insert a new node between "Determine Routing" and the drafting Execute Workflow branches:

- **HTTP Request: Live Gate** — `GET http://dashboard:3000/api/onboarding/live-gate` → `{ live: boolean }`.
- **IF !live** — skip drafting (workflow ends with the queue row already inserted — it will show in the dashboard with `draft_original = NULL` and `status = 'pending_review'`, but no drafting fires; during onboarding this is the expected state).
- **IF live** — proceed to the existing routing decision and drafting branches.

Re-import the updated workflow:
```bash
./scripts/n8n-import-workflows.sh
MAIN=$(docker compose exec -T n8n n8n list:workflow | awk '/01-email-pipeline-main/ {print $1}')
SUB=$(docker compose exec -T n8n n8n list:workflow | awk '/03-classify-email-sub/ {print $1}')
docker compose exec -T n8n n8n update:workflow --active=true --id="$MAIN"
docker compose exec -T n8n n8n update:workflow --active=true --id="$SUB"
```
</action>
<read_first>
  - n8n/workflows/03-classify-email-sub.json  (edit existing file)
  - dashboard/backend/src/routes/onboarding.ts  (live-gate contract)
</read_first>
<acceptance_criteria>
- `grep '/api/onboarding/live-gate' n8n/workflows/03-classify-email-sub.json` matches
- The updated workflow JSON still parses: `jq . n8n/workflows/03-classify-email-sub.json > /dev/null`
- Re-import succeeds: `docker compose exec -T n8n n8n list:workflow | grep -c '03-classify-email-sub'` returns at least `1`
</acceptance_criteria>
</task>

<task id="10b-n8n-client">
<action>
**[Review fix]** Create `dashboard/backend/src/n8n-client.ts` — the shared helper used by `onboarding.ts`, `queue.ts`, `tuning.ts`, and any future server-side n8n dispatch. The previous design called `/rest/workflows/run-by-name?name=…` which is NOT a real n8n endpoint. This helper uses the documented two-step pattern (lookup-by-name → run-by-id) and is the SAME pattern as the 02-03 watchdog and 02-06 chain.

```ts
import { config } from './config.js';

const N8N_BASE = config.N8N_URL.replace(/\/$/, '');
const API_KEY = config.N8N_INTERNAL_API_KEY; // sourced from .env

const HEADERS = (): HeadersInit => ({
  'content-type': 'application/json',
  // n8n's internal REST API accepts X-N8N-API-KEY for personal API keys.
  'X-N8N-API-KEY': API_KEY,
});

async function n8nLookupWorkflowId(name: string): Promise<string> {
  const res = await fetch(`${N8N_BASE}/rest/workflows?filter=${encodeURIComponent(`name:${name}`)}`, { headers: HEADERS() });
  if (!res.ok) throw new Error(`n8n lookup ${name} failed: ${res.status}`);
  const j = (await res.json()) as { data?: Array<{ id: string; name: string }> };
  const hit = (j.data || []).find((w) => w.name === name);
  if (!hit) throw new Error(`n8n workflow not found: ${name}`);
  return hit.id;
}

export async function n8nRunByName(name: string, payload: unknown): Promise<unknown> {
  const id = await n8nLookupWorkflowId(name);
  const res = await fetch(`${N8N_BASE}/rest/workflows/${id}/run`, {
    method: 'POST',
    headers: HEADERS(),
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`n8n run ${name} failed: ${res.status} ${await res.text().catch(() => '')}`);
  return res.json().catch(() => ({}));
}

export async function n8nProvisionCredential(type: 'imap' | 'smtp' | 'googleApi', name: string, data: Record<string, unknown>): Promise<{ id: string }> {
  const res = await fetch(`${N8N_BASE}/rest/credentials`, {
    method: 'POST',
    headers: HEADERS(),
    body: JSON.stringify({ name, type, data, nodesAccess: [] }),
  });
  if (!res.ok) throw new Error(`n8n credential provision failed (${name}): ${res.status} ${await res.text().catch(() => '')}`);
  const j = (await res.json()) as { id: string };
  return j;
}
```

Also extend `dashboard/backend/src/config.ts` to load `N8N_INTERNAL_API_KEY` from `.env`. Document the requirement in `.env.example`.
</action>
<read_first>
  - dashboard/backend/src/config.ts
  - .env.example
  - n8n/README.md  (N8N Internal API credential note)
</read_first>
<acceptance_criteria>
- `dashboard/backend/src/n8n-client.ts` exists
- `grep 'export async function n8nRunByName' dashboard/backend/src/n8n-client.ts` matches
- `grep 'export async function n8nProvisionCredential' dashboard/backend/src/n8n-client.ts` matches
- `grep '/rest/workflows?filter=' dashboard/backend/src/n8n-client.ts` matches (lookup-by-name uses documented endpoint)
- `grep '/rest/workflows/' dashboard/backend/src/n8n-client.ts` matches (run-by-id uses documented endpoint)
- `grep '/rest/credentials' dashboard/backend/src/n8n-client.ts` matches
- **Negative check:** `grep -c 'run-by-name' dashboard/backend/src/n8n-client.ts` returns `0`
- `grep 'N8N_INTERNAL_API_KEY' .env.example` matches
</acceptance_criteria>
</task>

<task id="10c-gmail-oauth">
<action>
**[Review fix]** Create `dashboard/backend/src/credentials/gmail-oauth.ts` — server-side helper for: (1) exchanging a Gmail OAuth code for an access+refresh token using `GMAIL_OAUTH_CLIENT_ID`/`GMAIL_OAUTH_CLIENT_SECRET` from `.env`, and (2) validating IMAP/SMTP connections one time for the manual path so the operator does not have to wait for the first ingest poll to find out their app password is wrong.

```ts
import { config } from '../config.js';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';

export interface GmailOAuthTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: 'Bearer';
  scope: string;
}

export async function exchangeGmailOAuthCode(code: string, redirectUri: string): Promise<GmailOAuthTokens> {
  const params = new URLSearchParams({
    code,
    client_id: config.GMAIL_OAUTH_CLIENT_ID,
    client_secret: config.GMAIL_OAUTH_CLIENT_SECRET,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  if (!res.ok) throw new Error(`oauth token exchange failed: ${res.status} ${await res.text().catch(() => '')}`);
  return res.json() as Promise<GmailOAuthTokens>;
}

export async function validateImapConnection(opts: { host: string; port: number; user: string; password: string }): Promise<void> {
  const cli = new ImapFlow({ host: opts.host, port: opts.port, secure: true, auth: { user: opts.user, pass: opts.password }, logger: false });
  await cli.connect();
  await cli.logout();
}

export async function validateSmtpConnection(opts: { host: string; port: number; user: string; password: string }): Promise<void> {
  const tx = nodemailer.createTransport({ host: opts.host, port: opts.port, secure: opts.port === 465, auth: { user: opts.user, pass: opts.password } });
  await tx.verify();
}
```

Already-listed dependencies (`imapflow`, `nodemailer` from CLAUDE.md stack) cover this — no new packages.
</action>
<read_first>
  - dashboard/backend/src/config.ts
  - CLAUDE.md  (imapflow / nodemailer pinned in fallback stack)
</read_first>
<acceptance_criteria>
- `dashboard/backend/src/credentials/gmail-oauth.ts` exists
- `grep 'exchangeGmailOAuthCode' dashboard/backend/src/credentials/gmail-oauth.ts` matches
- `grep 'validateImapConnection' dashboard/backend/src/credentials/gmail-oauth.ts` matches
- `grep 'validateSmtpConnection' dashboard/backend/src/credentials/gmail-oauth.ts` matches
- `grep 'oauth2.googleapis.com/token' dashboard/backend/src/credentials/gmail-oauth.ts` matches
- **Negative check:** `grep -c 'console.log' dashboard/backend/src/credentials/gmail-oauth.ts` returns `0` (no logging of plaintext credentials)
</acceptance_criteria>
</task>

<task id="10d-wizard-ui">
<action>
**[Review fix — closes Phase 2 success criterion 5]** Build the seven onboarding wizard screens per `.planning/phases/02-email-pipeline-core/02-UI-SPEC.md`. Hand-authored Tailwind v4 components — no shadcn, no third-party UI lib. The frontend stack from 02-01 (React 18 + Vite 6) already exists; this task fleshes out the routes and screens.

**Components to create (paths under `dashboard/frontend/src/`):**
- `App.tsx` — wizard router. Polls `/api/onboarding/status` every 5s (or subscribes to the WebSocket if reachable). Renders one of the seven screens based on `stage`:
  - `pending_admin` → `<AdminCreate />`
  - `pending_email` → `<EmailConnect />`
  - `ingesting` → `<IngestProgress />`
  - `pending_tuning` → `<DocumentUpload />` (intermediate optional step) then `<PersonaTuning />` and `<NotificationPrefs />`
  - `tuning_in_progress` → `<PersonaTuning />`
  - `live` → `<LiveShell />`
- `components/WizardShell.tsx` — full-viewport card, step indicator slot, heading/title slots. Tailwind colors from UI-SPEC.
- `components/StepIndicator.tsx` — 6-dot horizontal stepper with active/checkmark/hollow states.
- `screens/AdminCreate.tsx` — username + password + confirm fields. Client-side validation (`>=12 chars`, match). Posts `/api/onboarding/admin`.
- `screens/EmailConnect.tsx` — toggle between "Connect Gmail" (OAuth2 redirect to Google, then receive code on callback URL `/onboarding/email/callback`) and "Manual settings" (host/port/user/password form). Posts `/api/onboarding/email`.
- `screens/IngestProgress.tsx` — full-width progress bar with `aria-valuenow` per UI-SPEC. Streams progress via WebSocket; falls back to 5s poll of `/api/onboarding/status`.
- `screens/DocumentUpload.tsx` — drag-and-drop zone, list of uploaded docs, `Skip for Now` CTA. Wraps `/api/kb/documents` from 02-05.
- `screens/PersonaTuning.tsx` — vertical scroll list of 20 cards, each with the inbound excerpt + draft preview + three rating buttons (`Sounds like me` / `Wrong tone` / `I'd change this`). Submit posts `/api/tuning/ratings`. On success, advance to `LiveShell`.
- `screens/NotificationPrefs.tsx` — queue-threshold integer + digest-email field. Posts `/api/onboarding/notifications`.
- `screens/LiveShell.tsx` — minimal post-onboarding status: "Email processing is live" badge + `awaiting_cloud` banner if any rows in that state. Polls `/api/queue?status=awaiting_cloud&limit=1` every 30s.

**Tailwind v4 config (`dashboard/frontend/src/index.css`):**
```css
@import "tailwindcss";
/* No additional config file needed — Tailwind v4 reads utility classes from JSX directly. */
```

**Accessibility (per UI-SPEC §Accessibility):**
- `<label htmlFor=…>` on every input.
- `aria-pressed` on tone rating buttons.
- `aria-current="step"` on active stepper dot.
- `role="progressbar"` with `aria-valuenow/min/max` on ingest progress.
- 44px minimum touch targets.
</action>
<read_first>
  - .planning/phases/02-email-pipeline-core/02-UI-SPEC.md  (every screen + copy contract)
  - dashboard/frontend/src/  (verify the 02-01 React skeleton exists)
  - dashboard/Dockerfile  (verify the build step picks up the new files)
</read_first>
<acceptance_criteria>
- `dashboard/frontend/src/App.tsx` exists and renders different screens by `stage`
- All seven screen files exist under `dashboard/frontend/src/screens/`
- `dashboard/frontend/src/components/WizardShell.tsx` and `StepIndicator.tsx` exist
- `grep '@import "tailwindcss"' dashboard/frontend/src/index.css` matches
- Build succeeds: `docker compose build dashboard` exits 0
- Lighthouse a11y > 90 on `/onboarding/admin` and `/onboarding/persona-tuning` (manual check; documented in verification)
- Negative-press path (review fix): with the backend offline, the wizard surfaces a clear "Couldn't reach MailBox One backend, retrying…" empty state on every screen instead of going blank.
</acceptance_criteria>
</task>

<task id="11">
<action>
End-to-end onboarding smoke test — drive the state machine through every stage programmatically, since Phase 2 has no UI.

```bash
# Rebuild dashboard with new routes
docker compose build dashboard
docker compose up -d dashboard

# Reset onboarding row
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
  UPDATE mailbox.onboarding SET stage='pending_admin', admin_username=NULL, admin_password_hash=NULL,
         email_address=NULL, ingest_progress_total=NULL, ingest_progress_done=0, tuning_sample_count=0, tuning_rated_count=0
  WHERE customer_key='default';
  DELETE FROM mailbox.tuning_samples WHERE customer_key='default';
"

# Stage 1: admin
curl -fsS -X POST http://localhost:3000/api/onboarding/admin \
  -H 'content-type: application/json' \
  -d '{"username":"dustin","password":"heronlabs-phase2-ok"}' | jq .

# Stage 2: email connect (stub the OAuth side — creds are pasted into n8n UI separately)
curl -fsS -X POST http://localhost:3000/api/onboarding/email \
  -H 'content-type: application/json' \
  -d '{"email":"dustin@heronlabs.example","mode":"oauth2"}' | jq .

# Wait for ingest to finish (seeded by earlier plans' sent_history or run 06-rag-ingest-sent-history manually)
# For smoke, skip to persona extract manually:
curl -fsS -X POST http://localhost:3000/api/persona/extract | jq .

# Generate 20 tuning samples (normally invoked by 12-tuning-sample-generate after 09-persona-extract-trigger fires)
# For smoke, call the helper endpoint directly for 20 arbitrary email_raw_ids:
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "
  SELECT er.id FROM mailbox.email_raw er
  JOIN mailbox.classification_log cl ON cl.email_raw_id = er.id
  WHERE cl.category != 'spam_marketing' LIMIT 20;
" | while read id; do
  [ -z "$id" ] && continue
  curl -fsS -X POST http://localhost:3000/api/tuning/generate-sample \
    -H 'content-type: application/json' \
    -d "{\"email_raw_id\": $id}" > /dev/null || echo "skip $id"
done

# Check tuning samples
curl -fsS http://localhost:3000/api/tuning/samples | jq '.rated, .total'

# Rate all samples as 'good' (simulate operator)
SAMPLES=$(curl -fsS http://localhost:3000/api/tuning/samples | jq -c '{ratings: [.samples[] | {id: .id, rating: "good"}]}')
curl -fsS -X POST http://localhost:3000/api/tuning/ratings -H 'content-type: application/json' -d "$SAMPLES" | jq .

# Final stage check — must be 'live'
curl -fsS http://localhost:3000/api/onboarding/status | jq .stage
# Expected: "live"

# Live gate open
curl -fsS http://localhost:3000/api/onboarding/live-gate | jq .
# Expected: {"live": true}
```
</action>
<read_first>
  - dashboard/backend/src/routes/onboarding.ts
  - dashboard/backend/src/routes/tuning.ts
  - dashboard/backend/src/routes/queue.ts
</read_first>
<acceptance_criteria>
- After admin POST: `curl -fsS http://localhost:3000/api/onboarding/status | jq -r .stage` returns `pending_email`
- After email POST: stage is `ingesting` (or later if ingest completes quickly)
- After persona extract + 20 sample generations: `curl -fsS http://localhost:3000/api/tuning/samples | jq -r '.total'` returns `20`
- After rating all 20: `curl -fsS http://localhost:3000/api/onboarding/status | jq -r .stage` returns `live`
- `curl -fsS http://localhost:3000/api/onboarding/live-gate | jq -r .live` returns `true`
- `curl -fsS http://localhost:3000/api/queue | jq -e '.items, .total, .limit, .offset'` does not fail
- Queue response header includes `X-Mailbox-Security: lan-trust-phase-2`: `curl -fsS -D - http://localhost:3000/api/queue -o /dev/null | grep -i 'X-Mailbox-Security'`
</acceptance_criteria>
</task>

<task id="12">
<action>
Final phase goal check: send a real email to the dogfood inbox, confirm it appears in `/api/queue` within 90s with a filled draft_original, approve it via `/api/queue/:id/approve`, confirm the reply actually arrives at the sender's address and the row lands in `sent_history`.

```bash
# Operator action: send email from another Gmail account to dogfood inbox with:
#   Subject: "Phase 2 end-to-end test — reorder"
#   Body: "Hi Dustin, please ship 24 cases of your Original sauce to our Portland warehouse, same PO template as last month."

# Wait up to 120s for pipeline
for i in $(seq 1 12); do
  ROW=$(curl -fsS 'http://localhost:3000/api/queue?limit=1' | jq -r '.items[0] | {id, status, has_draft: (.draft_original != null), category: .classification_category}')
  echo "[$i] $ROW"
  if [ "$(echo "$ROW" | jq -r '.has_draft')" = 'true' ]; then break; fi
  sleep 10
done

ID=$(curl -fsS 'http://localhost:3000/api/queue?limit=1' | jq -r '.items[0].id')

# Approve
curl -fsS -X POST "http://localhost:3000/api/queue/$ID/approve" -H 'content-type: application/json' -d '{}' | jq .

# Confirm row moved to sent_history
sleep 10
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
  SELECT COUNT(*) FROM mailbox.sent_history WHERE draft_queue_id = $ID;
  SELECT COUNT(*) FROM mailbox.draft_queue WHERE id = $ID;
"
# Expected: 1 sent_history, 0 draft_queue
```
</action>
<read_first>
  - dashboard/backend/src/routes/queue.ts
  - n8n/workflows/11-send-smtp-sub.json
</read_first>
<acceptance_criteria>
- After real test email send + wait: the top queue row has `status='pending_review'` and non-null `draft_original`
- After approve: `docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT COUNT(*) FROM mailbox.sent_history WHERE draft_queue_id = <ID>;"` returns `1`
- `docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT COUNT(*) FROM mailbox.draft_queue WHERE id = <ID>;"` returns `0`
- The original sender receives the reply in their inbox (manual verification)
</acceptance_criteria>
</task>

</tasks>

<verification>
```bash
# 1. All 6 onboarding stages representable and transitioning
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "
  SELECT unnest(enum_range(NULL::mailbox.onboarding_stage))::text;
" | sort | tr '\n' ' ' | grep -q 'ingesting live pending_admin pending_email pending_tuning tuning_in_progress'

# 2. Onboarding API round-trips
curl -fsS http://localhost:3000/api/onboarding/status | jq -e '.stage' > /dev/null
curl -fsS http://localhost:3000/api/onboarding/live-gate | jq -e '.live != null' > /dev/null

# 3. Queue API shape
curl -fsS 'http://localhost:3000/api/queue?limit=5' | jq -e '.items | type == "array"' > /dev/null
curl -fsS -D - 'http://localhost:3000/api/queue?limit=1' -o /dev/null | grep -iq 'X-Mailbox-Security: lan-trust-phase-2'

# 4. Tuning API shape
curl -fsS http://localhost:3000/api/tuning/samples | jq -e '.total != null and .rated != null' > /dev/null

# 5. WebSocket emits queue.updated on approve (manual test via websocat)
# websocat ws://localhost:3000/api/ws  → listen while curling /api/queue/:id/approve

# 6. End-to-end phase-goal check: a real inbound email → drafted → approved → sent from customer address → in sent_history (task 12)

# 7. Schema push result: 9 tables total now in mailbox schema
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "
  SELECT COUNT(*) FROM information_schema.tables
  WHERE table_schema='mailbox'
    AND table_name IN ('email_raw','classification_log','draft_queue','sent_history','rejected_history','persona','onboarding','tuning_samples','settings');
" | grep -q '^9$'

# 8. Live gate enforcement: pre-live state doesn't fire drafting
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "UPDATE mailbox.onboarding SET stage='pending_tuning' WHERE customer_key='default';"
# Send an email; observe classification_log row created but no draft_original populated on the new draft_queue row
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "UPDATE mailbox.onboarding SET stage='live' WHERE customer_key='default';"
```
</verification>
