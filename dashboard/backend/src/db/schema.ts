import { sql } from 'drizzle-orm';
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
    fkDraftQueue: foreignKey({
      name: 'sent_history_draft_queue_fk',
      columns: [t.draftQueueId],
      foreignColumns: [draftQueue.id],
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
    fkDraftQueue: foreignKey({
      name: 'rejected_history_draft_queue_fk',
      columns: [t.draftQueueId],
      foreignColumns: [draftQueue.id],
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
