import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertCatalogValid,
  getJobTemplate,
  JOB_TEMPLATES,
  listAvailableJobTemplates,
} from '@/lib/jobs/catalog';

// MBOX-462 P0 — pure catalog invariants. No DB, no runtime imports: this is the
// gate that the shipped Agent Job Templates registry is internally consistent.
// Spec: docs/spec-agent-job-templates-v0_1-2026-06-07.md.

describe('Agent Job Templates catalog', () => {
  it('passes its own integrity checks', () => {
    expect(() => assertCatalogValid()).not.toThrow();
  });

  it('ships the P0 templates with unique ids', () => {
    const ids = JOB_TEMPLATES.map((t) => t.id);
    expect(ids).toContain('daily-digest');
    expect(ids).toContain('followup-nudge');
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('getJobTemplate resolves a known id and misses an unknown one', () => {
    expect(getJobTemplate('daily-digest')?.title).toBe('Daily inbox digest');
    expect(getJobTemplate('does-not-exist')).toBeUndefined();
  });

  it('never recommends a counterparty-sending job on by default (spec §9 D3)', () => {
    for (const t of JOB_TEMPLATES) {
      if (t.sendsToCounterparty) {
        expect(t.recommendOnByDefault, `${t.id} sends + default-on`).toBe(false);
      }
    }
  });

  it('rejects a catalog that defaults-on a counterparty-sending job', () => {
    const sender = getJobTemplate('followup-nudge');
    expect(sender?.sendsToCounterparty).toBe(true);
    const bad = [{ ...sender!, recommendOnByDefault: true }];
    expect(() => assertCatalogValid(bad)).toThrow(/D3/);
  });

  it('every AVAILABLE n8n template references a shipped workflow JSON', () => {
    const wfDir = join(process.cwd(), '..', 'n8n', 'workflows');
    for (const t of listAvailableJobTemplates()) {
      if (t.rail === 'n8n') {
        expect(
          existsSync(join(wfDir, `${t.workflow}.json`)),
          `${t.id} → n8n/workflows/${t.workflow}.json should exist`,
        ).toBe(true);
      }
    }
  });

  it('planned templates are catalog-visible but not enable-able', () => {
    const available = listAvailableJobTemplates().map((t) => t.id);
    expect(available).toContain('daily-digest'); // available
    expect(available).not.toContain('followup-nudge'); // planned (nudge workflow net-new)
  });
});
