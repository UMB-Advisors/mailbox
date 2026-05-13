-- MailBox One: Phase 2 enum types
-- Runs only on first volume creation via /docker-entrypoint-initdb.d/, after
-- 00-schemas.sql creates the `mailbox` schema.
--
-- These types are pre-created here (instead of via drizzle-kit push) because
-- drizzle-kit 0.22.x silently omits CREATE TYPE statements for enums declared
-- through pgSchema('mailbox').enum(). Pre-creating the enums lets the
-- subsequent `npx drizzle-kit push` in 02-02 succeed on a fresh install.
--
-- IF YOU CHANGE THESE VALUES, also update dashboard/backend/src/db/enums.ts.

CREATE TYPE mailbox.onboarding_stage AS ENUM (
  'pending_admin',
  'pending_email',
  'ingesting',
  'pending_tuning',
  'tuning_in_progress',
  'live'
);

CREATE TYPE mailbox.classification_category AS ENUM (
  'inquiry',
  'reorder',
  'scheduling',
  'follow_up',
  'internal',
  'spam_marketing',
  'escalate',
  'unknown'
);

CREATE TYPE mailbox.draft_queue_status AS ENUM (
  'pending_drafting',
  'pending_review',
  'awaiting_cloud',
  'approved',
  'sending',
  'rejected'
);

CREATE TYPE mailbox.draft_source AS ENUM (
  'local_qwen3',
  'cloud_haiku'
);
