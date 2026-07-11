-- Migration 051 — Spec 003 FR2/FR3 (Stage 3a): per-message triage lifecycle state.
-- WHAT: Add mailbox.inbox_messages.triage_state — the processing-state column the
--       Triage action surface filters on (Needs action · Accepted · Denied · Done ·
--       Snoozed). Closed enum, DEFAULT 'needs_action', NOT NULL so every row
--       (existing + future) carries a state with no backfill gap. Plus two light
--       audit columns (triage_state_updated_at / triage_state_updated_by) the
--       sidecar write path stamps on each transition, and a composite index on
--       (account_id, triage_state) for the per-tab / per-state list queries.
--       The 'snoozed' case REUSES the existing inbox_messages.snooze_until column
--       (migration 042) — this migration adds NO second snooze field.
-- WHY:  Spec 003 FR2 "every message MUST carry a processing state" + FR3 "acting on
--       a message MUST update its state and move it out of Needs-action; transitions
--       MUST be reversible". Per-message accepted/denied/done state is NET-NEW
--       (plan §3a "Reuse map" — inbox_messages had archived/deleted/snooze/read but
--       no triage lifecycle). The state_transitions audit table (migration 009) is a
--       drafts.status-only trigger and does NOT fire on inbox_messages, so the light
--       audit lives in two columns here rather than that table.
-- ADDITIVE + REVERSIBLE: new columns + index only, no DML, no change to existing
--       columns. The DEFAULT 'needs_action' backfills existing rows in place; the
--       CHECK is the closed 5-state enum, kept in lockstep with the sidecar
--       triage-state write path by test/inbox-triage-state-migration.test.ts.
-- ROLLBACK (no down-runner — manual, per migration 042/046/047/048/049/050 style):
--   DROP INDEX IF EXISTS mailbox.inbox_messages_account_triage_state_idx;
--   ALTER TABLE mailbox.inbox_messages
--     DROP CONSTRAINT IF EXISTS inbox_messages_triage_state_check,
--     DROP COLUMN IF EXISTS triage_state,
--     DROP COLUMN IF EXISTS triage_state_updated_at,
--     DROP COLUMN IF EXISTS triage_state_updated_by;
--   then revert the sidecar features/triage_state.py + features/triage.py body fix.
--   Self-contained — snooze_until (migration 042) is untouched.

ALTER TABLE mailbox.inbox_messages
  -- The processing state. DEFAULT 'needs_action' so the column is NOT NULL with
  -- no backfill step; acting on a message advances it (accepted/denied/done) or,
  -- for snooze, sets 'snoozed' alongside the existing snooze_until instant.
  ADD COLUMN IF NOT EXISTS triage_state            TEXT NOT NULL DEFAULT 'needs_action',
  -- Light audit (the state_transitions trigger is drafts-only, so it never fires
  -- here): when + who last changed triage_state. NULL until the first transition.
  ADD COLUMN IF NOT EXISTS triage_state_updated_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS triage_state_updated_by TEXT NULL;

-- Closed 5-state enum. Idempotent: drop-then-add so a re-run reconciles the list.
-- Kept in lockstep with the sidecar write path (features/_triage_state_logic.py
-- TRIAGE_STATES) by test/inbox-triage-state-migration.test.ts.
ALTER TABLE mailbox.inbox_messages
  DROP CONSTRAINT IF EXISTS inbox_messages_triage_state_check;
ALTER TABLE mailbox.inbox_messages
  ADD CONSTRAINT inbox_messages_triage_state_check
  CHECK (triage_state IN ('needs_action', 'accepted', 'denied', 'done', 'snoozed'));

-- Read pattern: each Triage tab is a slice of one account (or all) filtered by
-- triage_state (default 'needs_action'). A composite btree on
-- (account_id, triage_state) keeps the per-tab/per-state list query cheap.
CREATE INDEX IF NOT EXISTS inbox_messages_account_triage_state_idx
  ON mailbox.inbox_messages (account_id, triage_state);
