// dashboard/lib/jobs/catalog/types.ts
//
// Agent Job Templates — catalog type SoT (MBOX-462 P0).
// Spec: docs/spec-agent-job-templates-v0_1-2026-06-07.md.
//
// A JobTemplate is a repo-shipped *definition* of an agent job. The catalog
// (./index.ts) is the curated set of these. A JobInstance
// (mailbox.job_instances, lib/queries-job-instances.ts) is a template enabled
// + parameterized on one box. The registry is substrate-agnostic: each
// template names its `rail`, but the operator never sees the distinction
// (spec §3) and the persisted instance never stores it.

// Substrate rails (spec §3). 'n8n' = Rail A (IO/schedule orchestration in an
// n8n workflow). 'dashboard' = Rail B (DB-shaped/fast/no-IO job in lib/jobs/).
export const JOB_RAILS = ['n8n', 'dashboard'] as const;
export type JobRail = (typeof JOB_RAILS)[number];

export const JOB_TRIGGER_KINDS = ['schedule', 'event'] as const;
export type JobTriggerKind = (typeof JOB_TRIGGER_KINDS)[number];

// A template is 'available' when its substrate is fully wired (the n8n workflow
// ships / the dashboard runner exists) and 'planned' when the definition is in
// the catalog but the substrate is not built yet (e.g. follow-up detection is
// live but the auto-nudge workflow is net-new). Planned templates are visible
// in the catalog but cannot be enabled into a running instance.
export const JOB_AVAILABILITIES = ['available', 'planned'] as const;
export type JobAvailability = (typeof JOB_AVAILABILITIES)[number];

// Proposed entitlement tiers (graduate with the Hardware-tiers milestone).
// Kept local to the jobs domain until the shared entitlement layer lands
// (spec §9 D5) — do not duplicate into lib/types.ts yet.
export const JOB_TIERS = ['core', 'pro', 'enterprise'] as const;
export type JobTier = (typeof JOB_TIERS)[number];

export type JobParamType = 'string' | 'number' | 'boolean';

export interface JobParamSpec {
  key: string;
  label: string;
  type: JobParamType;
  required: boolean;
  default?: string | number | boolean;
  help?: string;
}

export interface JobEntitlement {
  minTier: JobTier;
  // Optional Pack that must be installed for this template to be entitled.
  pack?: string;
}

export interface JobTrigger {
  kind: JobTriggerKind;
  // schedule → a cron expression or the name of an env var holding one.
  // event    → the event name the job reacts to.
  default: string;
}

interface JobTemplateBase {
  id: string; // stable kebab slug; matches JobInstance.template_id
  title: string;
  summary: string;
  availability: JobAvailability;
  trigger: JobTrigger;
  params: JobParamSpec[];
  entitlement: JobEntitlement;
  // Does this job send to / mutate a counterparty's view (an outbound reply,
  // a nudge)? A box-internal email to the operator (the digest) is NOT a
  // counterparty send. Drives the onboarding default-on guard (spec §9 D3).
  sendsToCounterparty: boolean;
  // Pre-checked at onboarding. The catalog invariant forbids this being true
  // for a counterparty-sending job — consent before the agent acts (D3).
  recommendOnByDefault: boolean;
  // Per-instance model override default (spec §5.3). Optional.
  defaultModel?: string;
}

// Discriminated union on `rail` (TS convention: discriminated unions over
// optional fields). Rail A carries the n8n workflow basename; Rail B carries a
// runner registry key resolved by the scheduler at run time — kept as a string
// so the catalog stays pure/serializable and testable without importing any
// runtime.
export interface N8nJobTemplate extends JobTemplateBase {
  rail: 'n8n';
  workflow: string; // basename in n8n/workflows/, e.g. 'MailBOX-Digest'
}

export interface DashboardJobTemplate extends JobTemplateBase {
  rail: 'dashboard';
  runner: string; // runner key resolved by the Rail-B scheduler
}

export type JobTemplate = N8nJobTemplate | DashboardJobTemplate;
