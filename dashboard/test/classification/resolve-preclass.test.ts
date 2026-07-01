import { afterEach, describe, expect, it } from 'vitest';
import { resolvePreclass } from '@/lib/classification/resolve-preclass';

// n8n-wire — unit tests for the shared force/reverb precedence helper
// extracted out of classify-one.ts so classify-one.ts, the classification-
// prompt route, and the classification-normalize route all run exactly the
// same check (see resolve-preclass.ts header for the force > reverb > bias
// ordering rationale). Pure — no DB (senderRuleLookup is injected).

describe('resolvePreclass', () => {
  afterEach(() => {
    delete process.env.REVERB_ROUTING_DISABLE;
  });

  it('a force-mode sender rule hard-routes, ignoring subject/reverb', async () => {
    const out = await resolvePreclass('gemini-notes@google.com', 'anything', {
      senderRuleLookup: async () => ({
        match: 'gemini-notes@google.com',
        kind: 'email',
        target_bucket: 'meeting_notes',
        mode: 'force',
      }),
    });
    expect(out).toEqual({
      forced: 'meeting_notes',
      senderPrior: undefined,
      preclass_source: 'sender-rule-force',
    });
  });

  it('a Reverb "Message about…" subject hard-routes to sales_lead even with a bias rule present', async () => {
    const out = await resolvePreclass('messages@reverb.com', 'Message about your Stratocaster', {
      senderRuleLookup: async () => ({
        match: 'reverb.com',
        kind: 'domain',
        target_bucket: 'marketing_promo',
        mode: 'bias',
      }),
    });
    expect(out.forced).toBe('sales_lead');
    expect(out.preclass_source).toBe('reverb-subject');
  });

  it('REVERB_ROUTING_DISABLE=1 falls through past a matching Reverb subject', async () => {
    process.env.REVERB_ROUTING_DISABLE = '1';
    const out = await resolvePreclass('messages@reverb.com', 'Message about your Stratocaster', {});
    expect(out.forced).toBeNull();
  });

  it('a bias-mode rule with no force/reverb match surfaces senderPrior only', async () => {
    const out = await resolvePreclass('vendor@example.com', 'hello', {
      senderRuleLookup: async () => ({
        match: 'vendor@example.com',
        kind: 'email',
        target_bucket: 'vendor_partner',
        mode: 'bias',
      }),
    });
    expect(out).toEqual({
      forced: null,
      senderPrior: 'vendor_partner',
      preclass_source: null,
    });
  });

  it('no rule, no reverb match → all null/undefined (unchanged default)', async () => {
    const out = await resolvePreclass('nobody@example.com', 'hi', {});
    expect(out).toEqual({ forced: null, senderPrior: undefined, preclass_source: null });
  });
});
