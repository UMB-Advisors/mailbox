-- Migration 047 — MBOX-462 P0 (Agent Job Templates catalog): job instances.
-- WHAT: New mailbox.job_instances table. One row per Job Template enabled on
--       this box. `template_id` is the catalog slug (lib/jobs/catalog/*, NOT a
--       DB enum — the registry is code-owned so adding a template needs no
--       migration). `params` is the operator-tuned parameter set; `schedule`
--       (cron expr or null for event-triggered templates) and `model` (per-
--       instance model override, spec §5.3) are optional. UNIQUE(template_id):
--       one instance per template per box for v1 (single-tenant appliance).
-- WHY:  P0 of the Agent Job Templates spec
--       (docs/spec-agent-job-templates-v0_1-2026-06-07.md). Gives the catalog a
--       persistence seam (enable/disable + params) that is substrate-agnostic —
--       the row never stores the rail (n8n vs dashboard); that's looked up from
--       the code registry. Box-level (no account_id): v1 jobs are box-scoped;
--       account scoping is deferred with multi-account job work.
-- ROLLBACK: DROP TABLE mailbox.job_instances; then revert the registry
--           (dashboard/lib/jobs/catalog/*), the CRUD helpers
--           (dashboard/lib/queries-job-instances.ts), and the schema.ts +
--           test/fixtures/schema.sql entries. No data carried elsewhere — an
--           instance is pure box-local config; run history lives separately in
--           mailbox.job_runs (migration 024) and is keyed by job_name, not by
--           a FK to this table.

CREATE TABLE IF NOT EXISTS mailbox.job_instances (
  id           SERIAL PRIMARY KEY,
  -- Catalog slug. Matches a JobTemplate.id in lib/jobs/catalog. Open TEXT, not
  -- a CHECK enum: the registry is the SoT and must evolve without migrations.
  template_id  TEXT NOT NULL,
  -- Off by default: a fresh row is created disabled; onboarding / the Jobs
  -- surface flips it on. Aligns with spec §9 D3 (consent before the agent acts).
  enabled      BOOLEAN NOT NULL DEFAULT FALSE,
  -- Operator-tuned parameters, shape defined by the template's param specs.
  -- '{}' (not NULL) for the no-overrides case — keeps the read path null-free.
  params       JSONB NOT NULL DEFAULT '{}',
  -- Cron expression (or env-var name) for schedule-triggered templates; NULL
  -- for event-triggered ones.
  schedule     TEXT,
  -- Per-instance model override (spec §5.3). NULL = use the template default /
  -- the box default model.
  model        TEXT,
  -- Who enabled it. NULL = the single-operator-per-appliance default (mirrors
  -- prompt_rules.created_by / vip_senders.added_by — no per-user identity yet).
  created_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT job_instances_template_id_not_blank CHECK (length(trim(template_id)) > 0),
  CONSTRAINT job_instances_template_id_unique UNIQUE (template_id)
);

-- The Rail-B scheduler scans for enabled instances each tick; index the flag.
CREATE INDEX IF NOT EXISTS job_instances_enabled_idx
  ON mailbox.job_instances (enabled);
