-- Migration 048 — Spec 002 FR1 (Stage 2a): widen the classification-category
-- CHECK to the design taxonomy.
-- WHAT: ADDITIVELY widens the category CHECK constraint on every enforcing table
--       to the UNION of the 8 current coarse values AND the full design taxonomy
--       from seed/buckets.yaml. Five constraints are widened (the spec/plan name
--       four; rejected_history shares the same enum and is widened too so a
--       re-routed draft can still be rejected — see ROLLBACK / note below):
--         1. classification_log.category        (classification_log_category_check, migration 002)
--         2. drafts.classification_category     (drafts_classification_category_check, migration 003)
--         3. sent_history.classification_category   (sent_history_category_check, migration 004)
--         4. rejected_history.classification_category (rejected_history_category_check, migration 004) — 5th, additive
--         5. auto_send_rules.category           (auto_send_rules_category_check, migration 032)
-- WHY:  The live classifier emitted only 8 coarse categories with no marketing /
--       notification distinction, which caused real mis-sorts (Spec 002 "Why now":
--       a marketing campaign read as a client request; a "payroll ran" alert read
--       as an escalation). 2a widens the enum so new mail can land in the right
--       bucket; lib/classification/prompt.ts CATEGORIES + lib/types.ts
--       ClassificationCategory are updated to the same set and pinned by
--       test/schema-invariants.test.ts.
-- ADDITIVE + REVERSIBLE: the 8 coarse values stay VALID so historical rows are
--       untouched (Spec 002 FR2 — historical mail is display-mapped via
--       seed/buckets.yaml::live_to_design_map, NOT re-classified). No DML, no data
--       loss. A LATER migration drops the coarse values once rows are reconciled.
-- ROLLBACK (no down-runner in this repo — manual, per migration 046/047 style):
--   For each of the 5 tables: DROP CONSTRAINT IF EXISTS <name>; then re-ADD the
--   pre-048 8-coarse CHECK below. Safe only after confirming no row holds a
--   design-taxonomy value (SELECT DISTINCT classification_category ...).
--     ALTER TABLE mailbox.classification_log DROP CONSTRAINT IF EXISTS classification_log_category_check;
--     ALTER TABLE mailbox.classification_log ADD CONSTRAINT classification_log_category_check
--       CHECK (category = ANY (ARRAY['inquiry','reorder','scheduling','follow_up','internal','spam_marketing','escalate','unknown']));
--   (…repeat for drafts / sent_history / rejected_history / auto_send_rules with
--    their original nullability — see migrations 002/003/004/032.)
-- Also revert lib/classification/prompt.ts (CATEGORIES + CATEGORY_DESCRIPTIONS),
-- lib/types.ts (ClassificationCategory), test/schema-invariants.test.ts, and the
-- test/fixtures/schema.sql snapshot.

-- 1. classification_log.category (NOT NULL)
ALTER TABLE mailbox.classification_log
  DROP CONSTRAINT IF EXISTS classification_log_category_check;
ALTER TABLE mailbox.classification_log
  ADD CONSTRAINT classification_log_category_check
  CHECK (category = ANY (ARRAY[
    -- current coarse (kept valid during transition)
    'inquiry','reorder','scheduling','follow_up','internal','spam_marketing','escalate','unknown',
    -- design taxonomy (seed/buckets.yaml)
    'client_request','proposal_request','sales_lead','meeting_invite','meeting_notes',
    'receipt','marketplace_notification','marketing_promo','vendor_partner','finance_legal',
    'admin_account','invoice_payable','contract_legal','notification','spam'
  ]));

-- 2. drafts.classification_category (nullable)
ALTER TABLE mailbox.drafts
  DROP CONSTRAINT IF EXISTS drafts_classification_category_check;
ALTER TABLE mailbox.drafts
  ADD CONSTRAINT drafts_classification_category_check
  CHECK (classification_category IS NULL OR classification_category = ANY (ARRAY[
    'inquiry','reorder','scheduling','follow_up','internal','spam_marketing','escalate','unknown',
    'client_request','proposal_request','sales_lead','meeting_invite','meeting_notes',
    'receipt','marketplace_notification','marketing_promo','vendor_partner','finance_legal',
    'admin_account','invoice_payable','contract_legal','notification','spam'
  ]));

-- 3. sent_history.classification_category (NOT NULL)
ALTER TABLE mailbox.sent_history
  DROP CONSTRAINT IF EXISTS sent_history_category_check;
ALTER TABLE mailbox.sent_history
  ADD CONSTRAINT sent_history_category_check
  CHECK (classification_category = ANY (ARRAY[
    'inquiry','reorder','scheduling','follow_up','internal','spam_marketing','escalate','unknown',
    'client_request','proposal_request','sales_lead','meeting_invite','meeting_notes',
    'receipt','marketplace_notification','marketing_promo','vendor_partner','finance_legal',
    'admin_account','invoice_payable','contract_legal','notification','spam'
  ]));

-- 4. rejected_history.classification_category (NOT NULL) — 5th constraint, additive
ALTER TABLE mailbox.rejected_history
  DROP CONSTRAINT IF EXISTS rejected_history_category_check;
ALTER TABLE mailbox.rejected_history
  ADD CONSTRAINT rejected_history_category_check
  CHECK (classification_category = ANY (ARRAY[
    'inquiry','reorder','scheduling','follow_up','internal','spam_marketing','escalate','unknown',
    'client_request','proposal_request','sales_lead','meeting_invite','meeting_notes',
    'receipt','marketplace_notification','marketing_promo','vendor_partner','finance_legal',
    'admin_account','invoice_payable','contract_legal','notification','spam'
  ]));

-- 5. auto_send_rules.category (nullable)
ALTER TABLE mailbox.auto_send_rules
  DROP CONSTRAINT IF EXISTS auto_send_rules_category_check;
ALTER TABLE mailbox.auto_send_rules
  ADD CONSTRAINT auto_send_rules_category_check
  CHECK (category IS NULL OR category = ANY (ARRAY[
    'inquiry','reorder','scheduling','follow_up','internal','spam_marketing','escalate','unknown',
    'client_request','proposal_request','sales_lead','meeting_invite','meeting_notes',
    'receipt','marketplace_notification','marketing_promo','vendor_partner','finance_legal',
    'admin_account','invoice_payable','contract_legal','notification','spam'
  ]));
