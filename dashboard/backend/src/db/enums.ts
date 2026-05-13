import { pgSchema } from 'drizzle-orm/pg-core';

// Enums live in the same `mailbox` schema as the tables that reference them.
// Using the schema-scoped `.enum()` (instead of bare `pgEnum`) so drizzle-kit
// emits `CREATE TYPE mailbox.<name>` and the `schemaFilter: ['mailbox']` in
// drizzle.config.ts includes them when diffing live state.
const mailbox = pgSchema('mailbox');

export const onboardingStageEnum = mailbox.enum('onboarding_stage', [
  'pending_admin',
  'pending_email',
  'ingesting',
  'pending_tuning',
  'tuning_in_progress',
  'live',
]);

export const classificationCategoryEnum = mailbox.enum('classification_category', [
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
export const draftQueueStatusEnum = mailbox.enum('draft_queue_status', [
  'pending_drafting',
  'pending_review',
  'awaiting_cloud',
  'approved',
  'sending',
  'rejected',
]);

export const draftSourceEnum = mailbox.enum('draft_source', [
  'local_qwen3',
  'cloud_haiku',
]);
