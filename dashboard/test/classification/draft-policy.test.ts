// Spec 002 FR5 (Stage 2b-3) — bucket reply-policy → draft gating. Pure, no DB.

import { describe, expect, it } from 'vitest';
import {
  BUCKET_REPLY_POLICY,
  canDraft,
  DRAFTABLE_POLICIES,
  draftGate,
  replyPolicyFor,
} from '@/lib/classification/draft-policy';
import { CATEGORIES, type Category } from '@/lib/classification/prompt';

// The canonical canDraft table (FR5). Design buckets are verbatim from
// seed/buckets.yaml; legacy-coarse keys inherit via live_to_design_map.
const EXPECTED: Record<Category, boolean> = {
  // legacy coarse
  inquiry: true, // -> client_request (draft)
  reorder: true, // -> client_request (draft)
  scheduling: true, // light_draft
  follow_up: true, // -> client_request (draft)
  internal: true, // sometimes
  spam_marketing: false, // -> spam / marketing_promo (none)
  escalate: true, // draft
  unknown: false, // no policy
  // design taxonomy
  client_request: true, // draft
  proposal_request: false, // after_scope_approval — NOT reply-worthy
  sales_lead: true, // often
  meeting_invite: false, // none
  meeting_notes: false, // none
  receipt: false, // none
  marketplace_notification: false, // none
  marketing_promo: false, // none
  vendor_partner: true, // sometimes
  finance_legal: false, // rarely
  admin_account: false, // rarely
  invoice_payable: false, // rarely
  contract_legal: true, // sometimes
  notification: false, // none
  spam: false, // none
};

describe('canDraft — FR5 reply-worthy gate', () => {
  it('matches the expected table for every bucket', () => {
    for (const bucket of Object.keys(EXPECTED) as Category[]) {
      expect(canDraft(bucket), `canDraft(${bucket})`).toBe(EXPECTED[bucket]);
    }
  });

  it('only draft/often/light_draft/sometimes are draftable (FR5 verbatim)', () => {
    expect([...DRAFTABLE_POLICIES].sort()).toEqual(
      ['draft', 'light_draft', 'often', 'sometimes'].sort(),
    );
  });

  it('the explicitly-forbidden buckets MUST NOT draft', () => {
    for (const b of [
      'receipt',
      'marketplace_notification',
      'marketing_promo',
      'notification',
      'spam',
      'finance_legal',
      'admin_account',
      'invoice_payable',
      'proposal_request',
    ] as Category[]) {
      expect(canDraft(b), b).toBe(false);
    }
  });

  it('fails closed for an unknown bucket string', () => {
    // Garbage value never seen in CATEGORIES → not draftable.
    expect(canDraft('totally_made_up' as Category)).toBe(false);
    expect(replyPolicyFor('totally_made_up' as Category)).toBe('none');
  });
});

describe('BUCKET_REPLY_POLICY exhaustiveness', () => {
  it('assigns a policy to every CATEGORY the classifier can emit', () => {
    for (const c of CATEGORIES) {
      expect(BUCKET_REPLY_POLICY[c], `policy for ${c}`).toBeDefined();
    }
  });

  it('the EXPECTED table covers exactly the live CATEGORIES set', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...CATEGORIES].sort());
  });
});

describe('draftGate — typed refusal', () => {
  it('returns { draftable: true } for a reply-worthy bucket', () => {
    expect(draftGate('client_request')).toEqual({ draftable: true });
  });

  it('returns a typed refusal (no generation) for a non-draftable bucket', () => {
    const r = draftGate('receipt');
    expect(r.draftable).toBe(false);
    if (!r.draftable) {
      expect(r.bucket).toBe('receipt');
      expect(r.policy).toBe('none');
      expect(r.reason).toContain('not draftable');
      expect(r.reason).toContain('FR5');
    }
  });

  it('refuses proposal_request (after_scope_approval is not reply-worthy)', () => {
    const r = draftGate('proposal_request');
    expect(r.draftable).toBe(false);
    if (!r.draftable) expect(r.policy).toBe('after_scope_approval');
  });
});
