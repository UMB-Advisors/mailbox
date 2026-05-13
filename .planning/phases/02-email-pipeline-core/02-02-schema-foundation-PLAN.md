---
plan_number: 02-02
slug: schema-foundation
wave: 2
depends_on: [02-01]
autonomous: true
requirements: [MAIL-11, RAG-01, PERS-01, ONBR-01, APPR-01, APPR-02]
files_modified:
  - dashboard/backend/src/db/schema.ts
  - dashboard/backend/src/db/types.ts
  - dashboard/backend/src/db/enums.ts
---

<review_fixes>
**Applied from 02-REVIEWS.md (codex pass, 2026-04-13):**
- HIGH: FK constraints added across `classification_log.email_raw_id`, `draft_queue.email_raw_id`, `sent_history.email_raw_id`/`draft_queue_id`, `rejected_history.email_raw_id`/`draft_queue_id`. Idempotency uniqueness on `classification_log(email_raw_id)` and `draft_queue(email_raw_id)` so retries cannot create orphan or duplicate rows.
- MEDIUM: FK-like columns normalized from `integer` to `bigint` to match `bigserial` PKs.
- 02-07 ↔ 02-02 reconciliation: added `retry_count`, `last_error`, `outbound_id`, `send_started_at` columns to `draft_queue` (durable retry counter + idempotent SMTP send guard, replacing the volatile n8n `staticData` approach flagged by the reviewer). `sending` value added to `draft_queue_status` enum for the atomic send transition.
- HIGH (02-05 ↔ 02-06 reconciliation): new `mailbox.historical_sent` table so the 6-month onboarding sent backfill stays separate from live `sent_history` (which is reserved for approved/generated outbound). Keeps PERS-05 and audit semantics intact.
- MEDIUM: `approved`/`rejected` kept in the enum but documented as transient — `approved` is the brief pre-dispatch state and `sending` is the in-flight state. Terminal transitions move rows out of `draft_queue` per D-19.
- LOW: TS-side JSONB defaults switched to SQL `'[]'::jsonb` so drizzle-kit emits the right literal in DDL.
</review_fixes>

<objective>
Define the drizzle-orm schema for the eight Phase 2 tables inside the existing `mailbox` Postgres schema, then push the schema to the live database. This plan creates the durable shape of every email, draft, classification, persona record, onboarding state, and historical onboarding corpus the rest of Phase 2 depends on. CONTEXT.md decisions D-01, D-04, D-11, D-16, D-17, D-18, D-19, and D-21 are implemented here literally; the integrity gaps flagged by the codex review are closed in this revision.
</objective>

<must_haves>
- All eight tables exist in `mailbox.*` after the plan runs:
  `email_raw`, `classification_log`, `draft_queue`, `sent_history`, `rejected_history`, `historical_sent`, `persona`, `onboarding`
- `draft_queue` has columns matching D-17 exactly (including `draft_source`, `rag_context_refs JSONB`, `auto_send_blocked BOOLEAN`, `classification_category`, `classification_confidence`) **plus** the durable-send columns added by this revision: `retry_count INT NOT NULL DEFAULT 0`, `last_error TEXT`, `outbound_id UUID`, `send_started_at TIMESTAMPTZ`.
- FK constraints exist on `classification_log.email_raw_id`, `draft_queue.email_raw_id`, `sent_history.email_raw_id`, `sent_history.draft_queue_id`, `rejected_history.email_raw_id`, `rejected_history.draft_queue_id` (all `ON DELETE RESTRICT`).
- `classification_log(email_raw_id)` and `draft_queue(email_raw_id)` are UNIQUE — one classification and at most one in-flight queue row per inbound message; re-classification is an UPDATE, not a duplicate row.
- `persona` has a single-row-per-customer shape with JSONB `statistical_markers` and JSONB `category_exemplars`
- `onboarding` has an enum `stage` column restricted to the 6 D-16 values
- `draft_queue_status` enum contains all 5 values: `pending_review`, `awaiting_cloud`, `approved`, `sending`, `rejected`. `approved` and `sending` are transient; `rejected` is set only when the cloud retry worker exhausts (per 02-07 review fix).
- `historical_sent` table exists with shape `(id bigserial, customer_key, message_id varchar unique, from_addr, to_addr, subject, body_text, sent_at, indexed_in_rag boolean, created_at)` — onboarding's 6-month ingest writes here; live approved sends go to `sent_history`.
- Indexes exist for the approval queue hot path (`status`, `received_at DESC`, `classification_category`)
- `drizzle-kit push` runs non-interactively and the live Postgres reflects the schema
</must_haves>

<tasks>

<task id="1">
<action>
Create `dashboard/backend/src/db/enums.ts` with Postgres enum type declarations drizzle will emit. The 6 onboarding stages come from CONTEXT.md D-16; the 8 classification categories come from MAIL-05; the draft-queue status values come from D-17 and D-03; the draft source values come from D-17:

```ts
import { pgEnum } from 'drizzle-orm/pg-core';

export const onboardingStageEnum = pgEnum('onboarding_stage', [
  'pending_admin',
  'pending_email',
  'ingesting',
  'pending_tuning',
  'tuning_in_progress',
  'live',
]);

export const classificationCategoryEnum = pgEnum('classification_category', [
  'inquiry',
  'reorder',
  'scheduling',
  'follow_up',
  'internal',
  'spam_marketing',
  'escalate',
  'unknown',
]);

// Review-fixes:
//   02-04: `pending_drafting` distinguishes "classified, not yet drafted" from
//          "drafted, awaiting human review" so live-gate / spam-drop logic does
//          not pollute the operator's review surface.
//   02-07: `sending` added so SMTP dispatch can use an atomic compare-and-swap
//          on the row (approved → sending → archived). `approved` and `sending`
//          are both transient pre-terminal states; D-19 still moves rows to
//          sent_history/rejected_history on the terminal transition.
export const draftQueueStatusEnum = pgEnum('draft_queue_status', [
  'pending_drafting',
  'pending_review',
  'awaiting_cloud',
  'approved',
  'sending',
  'rejected',
]);

export const draftSourceEnum = pgEnum('draft_source', [
  'local_qwen3',
  'cloud_haiku',
]);
```
</action>
<read_first>
  - .planning/phases/02-email-pipeline-core/02-CONTEXT.md  (D-01, D-03, D-16, D-17, D-21)
  - .planning/REQUIREMENTS.md  (MAIL-05 8-category list)
</read_first>
<acceptance_criteria>
- `dashboard/backend/src/db/enums.ts` exists
- `grep "'pending_admin'" dashboard/backend/src/db/enums.ts` matches
- `grep "'tuning_in_progress'" dashboard/backend/src/db/enums.ts` matches
- `grep "'cloud_haiku'" dashboard/backend/src/db/enums.ts` matches
- `grep "'awaiting_cloud'" dashboard/backend/src/db/enums.ts` matches
- `grep "'spam_marketing'" dashboard/backend/src/db/enums.ts` matches
- `grep "'sending'" dashboard/backend/src/db/enums.ts` matches (atomic SMTP send state)
- `grep "'pending_drafting'" dashboard/backend/src/db/enums.ts` matches (02-04 review fix)
- All 6 onboarding stages from D-16 appear as string literals
- All 6 draft_queue_status values appear (`pending_drafting`, `pending_review`, `awaiting_cloud`, `approved`, `sending`, `rejected`)
</acceptance_criteria>
</task>

<task id="2">
<action>
Create `dashboard/backend/src/db/schema.ts`. Every table lives in the `mailbox` schema via `pgSchema('mailbox').table(...)`. Column shapes match CONTEXT.md D-17 exactly for `draft_queue` (and the `sent_history`/`rejected_history` tables share the same columns minus `draft_queue`-specific workflow fields).

```ts
import {
  pgSchema,
  serial,
  bigserial,
  bigint,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  real,
  uuid,
  index,
  uniqueIndex,
  foreignKey,
  sql,
} from 'drizzle-orm/pg-core';
import {
  onboardingStageEnum,
  classificationCategoryEnum,
  draftQueueStatusEnum,
  draftSourceEnum,
} from './enums.js';

export const mailbox = pgSchema('mailbox');

// ── 1. email_raw ──────────────────────────────────────────────────────────
// Every inbound email lands here first, exactly once (unique on message_id).
// `thread_id` stores the original IMAP message id of the root of the thread
// when known (extracted from References per RFC 5322 §3.6.4); reply emails
// share the same value. Per 02-03 review fix we do NOT set thread_id from the
// current message's own Message-ID — that is wrong and breaks reply grouping.
export const emailRaw = mailbox.table(
  'email_raw',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    accountKey: varchar('account_key', { length: 64 }).notNull().default('default'), // MAIL-14 multi-account
    messageId: varchar('message_id', { length: 998 }).notNull(),
    threadId: varchar('thread_id', { length: 998 }),     // derived from References root; NULL until derivable
    inReplyTo: varchar('in_reply_to', { length: 998 }),
    references: text('references'),
    fromAddr: varchar('from_addr', { length: 320 }).notNull(),
    toAddr: text('to_addr').notNull(),
    ccAddr: text('cc_addr'),                              // 02-07 review fix: preserve CC for reply
    subject: text('subject'),
    bodyText: text('body_text'),
    bodyHtml: text('body_html'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uqMessageId: uniqueIndex('email_raw_message_id_uq').on(t.messageId),
    idxReceivedAt: index('email_raw_received_at_idx').on(t.receivedAt),
    idxThread: index('email_raw_thread_id_idx').on(t.threadId),
    idxAccount: index('email_raw_account_key_idx').on(t.accountKey),
  }),
);

// ── 2. classification_log ─────────────────────────────────────────────────
// Every classification attempt (including spam drops per D-21) lands here.
// One row per email_raw — re-classification (e.g. via /retry) is an UPDATE, not
// a duplicate insert. Enforced by uniqueIndex on email_raw_id.
export const classificationLog = mailbox.table(
  'classification_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    emailRawId: bigint('email_raw_id', { mode: 'number' }).notNull(),
    category: classificationCategoryEnum('category').notNull(),
    confidence: real('confidence').notNull(),
    modelVersion: varchar('model_version', { length: 64 }).notNull(),
    latencyMs: integer('latency_ms'),
    rawOutput: text('raw_output'),
    jsonParseOk: boolean('json_parse_ok').notNull(),
    thinkStripped: boolean('think_stripped').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uqEmailRaw: uniqueIndex('classification_log_email_raw_id_uq').on(t.emailRawId),
    idxCategory: index('classification_log_category_idx').on(t.category),
    fkEmailRaw: foreignKey({
      name: 'classification_log_email_raw_fk',
      columns: [t.emailRawId],
      foreignColumns: [emailRaw.id],
    }).onDelete('restrict'),
  }),
);

// ── 3. draft_queue (D-17 + 02-07 review fix) ──────────────────────────────
// Status lifecycle:
//   pending_drafting → pending_review → approved → sending → (archived to sent_history)
//                                    ↘ rejected → (archived to rejected_history)
//                  awaiting_cloud ─────╮
// `pending_drafting` is a new transient status (02-04 review fix) so a queue
// row classified-but-not-drafted is distinguishable from one already drafted
// and awaiting human review. The live-gate path leaves rows in
// `pending_drafting` until onboarding flips to `live`.
//
// retry_count / last_error / outbound_id / send_started_at land here per the
// 02-07 review fix — durable retry state that survives n8n restarts.
export const draftQueue = mailbox.table(
  'draft_queue',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    emailRawId: bigint('email_raw_id', { mode: 'number' }).notNull(),
    accountKey: varchar('account_key', { length: 64 }).notNull().default('default'), // MAIL-14 multi-account
    // Denormalized original email fields for dashboard performance (D-17)
    fromAddr: varchar('from_addr', { length: 320 }).notNull(),
    toAddr: text('to_addr').notNull(),
    ccAddr: text('cc_addr'),                              // 02-07 review fix
    subject: text('subject'),
    bodyText: text('body_text'),
    bodyHtml: text('body_html'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    messageId: varchar('message_id', { length: 998 }),
    threadId: varchar('thread_id', { length: 998 }),
    inReplyTo: varchar('in_reply_to', { length: 998 }),
    references: text('references'),
    // Draft fields
    draftOriginal: text('draft_original'),              // NULL while awaiting_cloud / pending_drafting
    draftSent: text('draft_sent'),                       // NULL until approved
    draftSource: draftSourceEnum('draft_source'),        // NULL while awaiting_cloud
    // Classification copy (denormalized from classification_log for one-query reads)
    classificationCategory: classificationCategoryEnum('classification_category').notNull(),
    classificationConfidence: real('classification_confidence').notNull(),
    // RAG refs: JSONB array of top-3 {chunkId, score, source}
    ragContextRefs: jsonb('rag_context_refs').notNull().default(sql`'[]'::jsonb`),
    // Workflow fields
    status: draftQueueStatusEnum('status').notNull().default('pending_drafting'),
    autoSendBlocked: boolean('auto_send_blocked').notNull().default(false), // D-04
    // 02-07 review fix: durable send-safety + retry counters
    retryCount: integer('retry_count').notNull().default(0),
    lastError: text('last_error'),
    outboundId: uuid('outbound_id'),                                          // set when status → sending
    sendStartedAt: timestamp('send_started_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (t) => ({
    uqEmailRaw: uniqueIndex('draft_queue_email_raw_id_uq').on(t.emailRawId), // 02-02 review fix
    uqOutboundId: uniqueIndex('draft_queue_outbound_id_uq').on(t.outboundId), // idempotency key
    idxStatus: index('draft_queue_status_idx').on(t.status),
    idxReceivedAt: index('draft_queue_received_at_idx').on(t.receivedAt),
    idxCategory: index('draft_queue_category_idx').on(t.classificationCategory),
    idxAccount: index('draft_queue_account_key_idx').on(t.accountKey),
    idxRagGin: index('draft_queue_rag_refs_gin').using('gin', t.ragContextRefs),
    fkEmailRaw: foreignKey({
      name: 'draft_queue_email_raw_fk',
      columns: [t.emailRawId],
      foreignColumns: [emailRaw.id],
    }).onDelete('restrict'),
  }),
);

// ── 4. sent_history (D-19 archival target on approval) ────────────────────
// LIVE approved/generated outbound only. Onboarding's historical sent backfill
// goes to `historical_sent` (table 6) per the 02-05 review fix so persona /
// PERS-05 / audit semantics stay clean.
export const sentHistory = mailbox.table(
  'sent_history',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    draftQueueId: bigint('draft_queue_id', { mode: 'number' }).notNull(),
    emailRawId: bigint('email_raw_id', { mode: 'number' }).notNull(),
    accountKey: varchar('account_key', { length: 64 }).notNull().default('default'),
    outboundId: uuid('outbound_id').notNull(),    // idempotency key carried from draft_queue
    fromAddr: varchar('from_addr', { length: 320 }).notNull(),
    toAddr: text('to_addr').notNull(),
    ccAddr: text('cc_addr'),
    subject: text('subject'),
    bodyText: text('body_text'),
    threadId: varchar('thread_id', { length: 998 }),
    inReplyTo: varchar('in_reply_to', { length: 998 }),
    references: text('references'),
    draftOriginal: text('draft_original'),
    draftSent: text('draft_sent').notNull(),
    draftSource: draftSourceEnum('draft_source').notNull(),
    classificationCategory: classificationCategoryEnum('classification_category').notNull(),
    classificationConfidence: real('classification_confidence').notNull(),
    ragContextRefs: jsonb('rag_context_refs').notNull().default(sql`'[]'::jsonb`),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uqOutboundId: uniqueIndex('sent_history_outbound_id_uq').on(t.outboundId),
    idxSentAt: index('sent_history_sent_at_idx').on(t.sentAt),
    idxCategory: index('sent_history_category_idx').on(t.classificationCategory),
    idxAccount: index('sent_history_account_key_idx').on(t.accountKey),
    fkEmailRaw: foreignKey({
      name: 'sent_history_email_raw_fk',
      columns: [t.emailRawId],
      foreignColumns: [emailRaw.id],
    }).onDelete('restrict'),
  }),
);

// ── 5. rejected_history (D-19 archival target on reject) ──────────────────
export const rejectedHistory = mailbox.table(
  'rejected_history',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    draftQueueId: bigint('draft_queue_id', { mode: 'number' }).notNull(),
    emailRawId: bigint('email_raw_id', { mode: 'number' }).notNull(),
    accountKey: varchar('account_key', { length: 64 }).notNull().default('default'),
    rejectReason: varchar('reject_reason', { length: 32 }).notNull().default('operator'), // 'operator' | 'cloud_retry_exhausted' | 'escalated'
    fromAddr: varchar('from_addr', { length: 320 }).notNull(),
    subject: text('subject'),
    classificationCategory: classificationCategoryEnum('classification_category').notNull(),
    classificationConfidence: real('classification_confidence').notNull(),
    draftOriginal: text('draft_original'),
    lastError: text('last_error'),
    rejectedAt: timestamp('rejected_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idxRejectedAt: index('rejected_history_rejected_at_idx').on(t.rejectedAt),
    idxAccount: index('rejected_history_account_key_idx').on(t.accountKey),
    fkEmailRaw: foreignKey({
      name: 'rejected_history_email_raw_fk',
      columns: [t.emailRawId],
      foreignColumns: [emailRaw.id],
    }).onDelete('restrict'),
  }),
);

// ── 6. historical_sent (02-05 review fix — onboarding backfill corpus) ────
// 6-month sent-folder backfill imported during onboarding. Separated from
// `sent_history` so live audit + PERS-05 monthly refresh do not get polluted
// by synthesized `draft_source` values for emails the appliance never drafted.
// Persona extraction (02-06) reads from this table OR sent_history depending
// on whether onboarding has produced any live approved sends yet.
export const historicalSent = mailbox.table(
  'historical_sent',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    accountKey: varchar('account_key', { length: 64 }).notNull().default('default'),
    customerKey: varchar('customer_key', { length: 64 }).notNull().default('default'),
    messageId: varchar('message_id', { length: 998 }).notNull(),
    fromAddr: varchar('from_addr', { length: 320 }).notNull(),
    toAddr: text('to_addr'),
    ccAddr: text('cc_addr'),
    subject: text('subject'),
    bodyText: text('body_text'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    indexedInRag: boolean('indexed_in_rag').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uqMessageId: uniqueIndex('historical_sent_message_id_uq').on(t.messageId),
    idxSentAt: index('historical_sent_sent_at_idx').on(t.sentAt),
    idxCustomer: index('historical_sent_customer_key_idx').on(t.customerKey),
  }),
);

// ── 7. persona (D-11 — single row per customer) ───────────────────────────
export const persona = mailbox.table('persona', {
  id: serial('id').primaryKey(),
  customerKey: varchar('customer_key', { length: 64 }).notNull().default('default'),
  statisticalMarkers: jsonb('statistical_markers').notNull(),       // JSONB per D-11
  categoryExemplars: jsonb('category_exemplars').notNull(),         // JSONB per D-11
  sourceEmailCount: integer('source_email_count').notNull().default(0),
  lastRefreshedAt: timestamp('last_refreshed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uqCustomer: uniqueIndex('persona_customer_key_uq').on(t.customerKey),
}));

// ── 8. onboarding (D-16 state machine) ────────────────────────────────────
export const onboarding = mailbox.table('onboarding', {
  id: serial('id').primaryKey(),
  customerKey: varchar('customer_key', { length: 64 }).notNull().default('default'),
  stage: onboardingStageEnum('stage').notNull().default('pending_admin'),
  adminUsername: varchar('admin_username', { length: 64 }),
  adminPasswordHash: varchar('admin_password_hash', { length: 128 }),
  emailAddress: varchar('email_address', { length: 320 }),
  ingestProgressTotal: integer('ingest_progress_total'),
  ingestProgressDone: integer('ingest_progress_done').default(0),
  tuningSampleCount: integer('tuning_sample_count').default(0),
  tuningRatedCount: integer('tuning_rated_count').default(0),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  livedAt: timestamp('lived_at', { withTimezone: true }),
}, (t) => ({
  uqCustomer: uniqueIndex('onboarding_customer_key_uq').on(t.customerKey),
  idxStage: index('onboarding_stage_idx').on(t.stage),
}));
```
</action>
<read_first>
  - dashboard/backend/src/db/enums.ts
  - .planning/phases/02-email-pipeline-core/02-CONTEXT.md  (D-07..D-11 persona, D-13..D-16 onboarding, D-17..D-21 queue)
  - .planning/REQUIREMENTS.md  (MAIL-04, MAIL-11, RAG-04, PERS-03)
</read_first>
<acceptance_criteria>
- `dashboard/backend/src/db/schema.ts` exists
- `grep "pgSchema('mailbox')" dashboard/backend/src/db/schema.ts` matches
- `grep "export const draftQueue" dashboard/backend/src/db/schema.ts` matches
- `grep "export const emailRaw" dashboard/backend/src/db/schema.ts` matches
- `grep "export const classificationLog" dashboard/backend/src/db/schema.ts` matches
- `grep "export const sentHistory" dashboard/backend/src/db/schema.ts` matches
- `grep "export const rejectedHistory" dashboard/backend/src/db/schema.ts` matches
- `grep "export const persona" dashboard/backend/src/db/schema.ts` matches
- `grep "export const onboarding" dashboard/backend/src/db/schema.ts` matches
- `grep "export const historicalSent" dashboard/backend/src/db/schema.ts` matches (02-05 review fix)
- `grep "auto_send_blocked" dashboard/backend/src/db/schema.ts` matches
- `grep "rag_context_refs" dashboard/backend/src/db/schema.ts` matches
- `grep "draft_source" dashboard/backend/src/db/schema.ts` matches
- `grep "statistical_markers" dashboard/backend/src/db/schema.ts` matches
- `grep "category_exemplars" dashboard/backend/src/db/schema.ts` matches
- `grep "'gin'" dashboard/backend/src/db/schema.ts` matches  (GIN index on rag_context_refs)
- `grep "retry_count" dashboard/backend/src/db/schema.ts` matches (02-07 review fix)
- `grep "outbound_id" dashboard/backend/src/db/schema.ts` matches (02-07 review fix)
- `grep "send_started_at" dashboard/backend/src/db/schema.ts` matches (02-07 review fix)
- `grep "last_error" dashboard/backend/src/db/schema.ts` matches (02-07 review fix)
- `grep "cc_addr" dashboard/backend/src/db/schema.ts` matches (02-07 review fix — preserve CC)
- `grep "account_key" dashboard/backend/src/db/schema.ts` matches (MAIL-14 multi-account)
- `grep "classification_log_email_raw_id_uq" dashboard/backend/src/db/schema.ts` matches (uniqueness fix)
- `grep "draft_queue_email_raw_id_uq" dashboard/backend/src/db/schema.ts` matches (uniqueness fix)
- `grep "foreignKey" dashboard/backend/src/db/schema.ts` matches (FK fixes)
- `grep "reject_reason" dashboard/backend/src/db/schema.ts` matches (escalate / retry-exhausted classification)
</acceptance_criteria>
</task>

<task id="3">
<action>
Create `dashboard/backend/src/db/types.ts` — convenience re-exports of inferred insert/select types that later plans will import without touching the schema file directly:

```ts
import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import {
  emailRaw,
  classificationLog,
  draftQueue,
  sentHistory,
  rejectedHistory,
  historicalSent,
  persona,
  onboarding,
} from './schema.js';

export type EmailRaw = InferSelectModel<typeof emailRaw>;
export type NewEmailRaw = InferInsertModel<typeof emailRaw>;

export type ClassificationLog = InferSelectModel<typeof classificationLog>;
export type NewClassificationLog = InferInsertModel<typeof classificationLog>;

export type DraftQueueRow = InferSelectModel<typeof draftQueue>;
export type NewDraftQueueRow = InferInsertModel<typeof draftQueue>;

export type SentHistory = InferSelectModel<typeof sentHistory>;
export type NewSentHistory = InferInsertModel<typeof sentHistory>;

export type RejectedHistory = InferSelectModel<typeof rejectedHistory>;
export type NewRejectedHistory = InferInsertModel<typeof rejectedHistory>;

export type HistoricalSent = InferSelectModel<typeof historicalSent>;
export type NewHistoricalSent = InferInsertModel<typeof historicalSent>;

export type Persona = InferSelectModel<typeof persona>;
export type NewPersona = InferInsertModel<typeof persona>;

export type Onboarding = InferSelectModel<typeof onboarding>;
export type NewOnboarding = InferInsertModel<typeof onboarding>;
```
</action>
<read_first>
  - dashboard/backend/src/db/schema.ts
</read_first>
<acceptance_criteria>
- `dashboard/backend/src/db/types.ts` exists
- `grep 'DraftQueueRow' dashboard/backend/src/db/types.ts` matches
- `grep 'NewEmailRaw' dashboard/backend/src/db/types.ts` matches
- `grep 'Onboarding' dashboard/backend/src/db/types.ts` matches
- `grep 'HistoricalSent' dashboard/backend/src/db/types.ts` matches
</acceptance_criteria>
</task>

<task id="4">
<action>
Rebuild the dashboard image with the new schema files and run a TS build to verify compilation. The updated image must embed the schema files so drizzle-kit can read them from inside the container.

```bash
docker compose build dashboard
docker compose up -d dashboard
# Confirm the backend starts cleanly (strict TS already caught schema errors at build time)
docker compose logs --since=30s dashboard | tail -40
```

Expected: no TS compile errors, dashboard container stays healthy after restart.
</action>
<read_first>
  - dashboard/backend/src/db/schema.ts
  - dashboard/backend/src/db/enums.ts
  - dashboard/backend/src/db/types.ts
  - dashboard/Dockerfile
</read_first>
<acceptance_criteria>
- `docker compose build dashboard` exits 0
- `docker compose ps --format '{{.Service}} {{.Health}}' | grep '^dashboard healthy'` matches after restart
- `docker compose exec -T dashboard ls dist/backend/src/db/schema.js` exits 0
</acceptance_criteria>
</task>

<task id="5">
<action>
**[BLOCKING]** Run `drizzle-kit push` against the live Postgres container, targeting the `mailbox` schema. This is the mandatory schema-push step — the plan CANNOT pass verification without it. Plans 03–08 assume the tables exist as rows, not TypeScript types.

```bash
docker compose exec -T dashboard sh -c '
  export DATABASE_URL="postgresql://${POSTGRES_USER:-mailbox}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB:-mailbox}"
  npx drizzle-kit push --force
'
```

Note: `--force` skips the interactive confirmation that drizzle-kit normally prompts for; this is required because we are running inside a non-TTY container exec. The `mailbox` schema already exists from Phase 1's `scripts/init-db/00-schemas.sql`, so drizzle will push tables into it, not `public`, per the `schemaFilter: ['mailbox']` in `drizzle.config.ts`.
</action>
<read_first>
  - dashboard/drizzle.config.ts  (from Plan 01 — confirms schemaFilter)
  - dashboard/backend/src/db/schema.ts
  - scripts/init-db/00-schemas.sql  (mailbox schema exists)
</read_first>
<acceptance_criteria>
- `docker compose exec -T dashboard npx drizzle-kit push --force` exits 0
- `docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema='mailbox' AND table_name IN ('email_raw','classification_log','draft_queue','sent_history','rejected_history','historical_sent','persona','onboarding');"` returns `8`
- `docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT count(*) FROM pg_type WHERE typname IN ('onboarding_stage','classification_category','draft_queue_status','draft_source');"` returns `4`
- FK constraints exist: `docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT count(*) FROM information_schema.table_constraints WHERE table_schema='mailbox' AND constraint_type='FOREIGN KEY';"` returns at least `5` (classification_log, draft_queue, sent_history×2 cols, rejected_history×2 cols → drizzle emits one FK per declaration; minimum 5).
- Uniqueness invariants hold: `psql -Atc "SELECT count(*) FROM pg_indexes WHERE schemaname='mailbox' AND indexname IN ('classification_log_email_raw_id_uq','draft_queue_email_raw_id_uq','draft_queue_outbound_id_uq','sent_history_outbound_id_uq');"` returns `4`.
- draft_queue_status has 6 values: `psql -Atc "SELECT count(*) FROM pg_enum WHERE enumtypid=(SELECT oid FROM pg_type WHERE typname='draft_queue_status');"` returns `6`.
</acceptance_criteria>
</task>

<task id="6">
<action>
Seed an `onboarding` row with `stage='pending_admin'` so the live gate in later plans has something to read. Create a one-off seed script at `dashboard/backend/scripts/seed-onboarding.ts`:

```ts
import { db } from '../src/db/client.js';
import { onboarding } from '../src/db/schema.js';
import { sql } from 'drizzle-orm';

async function main() {
  await db.insert(onboarding).values({
    customerKey: 'default',
    stage: 'pending_admin',
  }).onConflictDoNothing({ target: onboarding.customerKey });
  const rows = await db.execute(sql`SELECT customer_key, stage FROM mailbox.onboarding;`);
  console.log('onboarding rows:', rows.rows);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
```

Then run it once:

```bash
docker compose exec -T dashboard sh -c '
  npx tsx backend/scripts/seed-onboarding.ts
'
```
</action>
<read_first>
  - dashboard/backend/src/db/schema.ts
  - dashboard/backend/src/db/client.ts
</read_first>
<acceptance_criteria>
- `dashboard/backend/scripts/seed-onboarding.ts` exists
- `docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT stage FROM mailbox.onboarding WHERE customer_key='default';"` returns `pending_admin`
</acceptance_criteria>
</task>

</tasks>

<verification>
```bash
# 1. All 8 tables present in mailbox schema
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "
  SELECT table_name FROM information_schema.tables
  WHERE table_schema='mailbox'
  ORDER BY table_name;
" | sort | tr '\n' ' '
# Expected: classification_log draft_queue email_raw historical_sent onboarding persona rejected_history sent_history

# 2. draft_queue column shape matches D-17 + review fixes
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "
  SELECT column_name FROM information_schema.columns
  WHERE table_schema='mailbox' AND table_name='draft_queue'
  ORDER BY ordinal_position;
"
# Must include: draft_source, classification_category, classification_confidence,
# rag_context_refs, auto_send_blocked, status, approved_at, sent_at,
# retry_count, last_error, outbound_id, send_started_at, cc_addr, account_key

# 2b. FK constraints in place (02-02 review fix)
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "
  SELECT conname FROM pg_constraint
  WHERE connamespace = 'mailbox'::regnamespace AND contype = 'f'
  ORDER BY conname;
"
# Must include: classification_log_email_raw_fk, draft_queue_email_raw_fk,
# sent_history_email_raw_fk, rejected_history_email_raw_fk

# 3. Enum values match D-16 for onboarding_stage
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "
  SELECT enumlabel FROM pg_enum
  WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname='onboarding_stage')
  ORDER BY enumsortorder;
" | tr '\n' ' '
# Expected: pending_admin pending_email ingesting pending_tuning tuning_in_progress live

# 4. draft_queue GIN index on rag_context_refs exists
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "
  SELECT indexname FROM pg_indexes
  WHERE schemaname='mailbox' AND tablename='draft_queue'
    AND indexname='draft_queue_rag_refs_gin';
"

# 5. Seed row exists
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "
  SELECT stage FROM mailbox.onboarding WHERE customer_key='default';
"
# Expected: pending_admin
```
</verification>
