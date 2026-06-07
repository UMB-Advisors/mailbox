// dashboard/lib/jobs/catalog/index.ts
//
// Agent Job Templates — the shipped catalog (MBOX-462 P0).
// Spec: docs/spec-agent-job-templates-v0_1-2026-06-07.md.
//
// This is the registry "over substrates" (spec Appendix A): a thin, pure list
// of template definitions tagged by rail. To ship a new template, add its
// module here. The catalog is the SoT for which jobs exist; mailbox.job_instances
// (lib/queries-job-instances.ts) is the per-box enabled/parameterized state.

import { dailyDigest } from './templates/daily-digest';
import { followupNudge } from './templates/followup-nudge';
import type { JobTemplate } from './types';

// Display order = array order. T1, T2 land in P0; P2 fills the Core catalog.
export const JOB_TEMPLATES: readonly JobTemplate[] = [dailyDigest, followupNudge] as const;

export function listJobTemplates(): readonly JobTemplate[] {
  return JOB_TEMPLATES;
}

export function getJobTemplate(id: string): JobTemplate | undefined {
  return JOB_TEMPLATES.find((t) => t.id === id);
}

// Templates the operator can actually enable into a running instance (the
// substrate is wired). Planned templates are catalog-visible but not enable-able.
export function listAvailableJobTemplates(): readonly JobTemplate[] {
  return JOB_TEMPLATES.filter((t) => t.availability === 'available');
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Validate the catalog's internal consistency. Throws on the first problem.
 * The catalog test is the gate; route/registry code can call it defensively.
 *
 * Invariants:
 *  - ids are non-empty kebab slugs and unique
 *  - a counterparty-sending job is never recommended-on-by-default (spec §9 D3)
 *  - rail-specific substrate reference is present (n8n.workflow / dashboard.runner)
 *  - param keys are unique within a template, and any default matches its type
 */
export function assertCatalogValid(templates: readonly JobTemplate[] = JOB_TEMPLATES): void {
  const seenIds = new Set<string>();
  for (const t of templates) {
    if (!SLUG_RE.test(t.id)) {
      throw new Error(
        `catalog: invalid template id ${JSON.stringify(t.id)} (must be a kebab slug)`,
      );
    }
    if (seenIds.has(t.id)) {
      throw new Error(`catalog: duplicate template id ${t.id}`);
    }
    seenIds.add(t.id);

    if (t.sendsToCounterparty && t.recommendOnByDefault) {
      throw new Error(
        `catalog: ${t.id} sends to counterparties and must not be recommendOnByDefault (spec §9 D3)`,
      );
    }

    if (t.rail === 'n8n' && !t.workflow.trim()) {
      throw new Error(`catalog: n8n template ${t.id} is missing a workflow name`);
    }
    if (t.rail === 'dashboard' && !t.runner.trim()) {
      throw new Error(`catalog: dashboard template ${t.id} is missing a runner key`);
    }

    const seenParams = new Set<string>();
    for (const p of t.params) {
      if (seenParams.has(p.key)) {
        throw new Error(`catalog: ${t.id} has duplicate param key ${p.key}`);
      }
      seenParams.add(p.key);
      if (p.default !== undefined && typeof p.default !== p.type) {
        throw new Error(
          `catalog: ${t.id} param ${p.key} default is ${typeof p.default}, expected ${p.type}`,
        );
      }
    }
  }
}

export type { JobTemplate } from './types';
