// Spec 002 FR4 (Stage 2b-1) — escalation-promotion + review-subtype flag.
// Pure function, no DB. Intent (not literal keyword): routine sign-ins and
// "payroll ran" must NOT promote.

import { describe, expect, it } from 'vitest';
import {
  detectEscalationSignal,
  isReviewSubtype,
  promoteEscalation,
} from '@/lib/classification/escalation-promotion';

describe('promoteEscalation (FR4)', () => {
  it('a non-notification verdict passes through untouched', () => {
    const r = promoteEscalation({
      category: 'client_request',
      subject: 'payment failed',
      body: 'card declined',
    });
    expect(r.category).toBe('client_request');
    expect(r.promoted).toBe(false);
    expect(r.important).toBe(false);
  });

  it('notification + payment_failed → escalate', () => {
    const r = promoteEscalation({
      category: 'notification',
      subject: 'Your payment failed',
      body: 'Your card was declined; please update your billing.',
    });
    expect(r.category).toBe('escalate');
    expect(r.promoted).toBe(true);
    expect(r.escalation_signal).toBe('payment_failed');
    expect(r.important).toBe(true);
  });

  it('notification + commerce_dispute (Shopify chargeback) → escalate', () => {
    const r = promoteEscalation({
      category: 'notification',
      subject: 'A chargeback was opened',
      body: 'A customer opened a dispute on order #1023.',
    });
    expect(r.category).toBe('escalate');
    expect(r.escalation_signal).toBe('commerce_dispute');
  });

  it('a routine "new sign-in" notification is NOT promoted (intent, not keyword)', () => {
    const r = promoteEscalation({
      category: 'notification',
      subject: 'New sign-in to your account',
      body: 'We noticed a new sign-in on Chrome.',
    });
    expect(r.category).toBe('notification');
    expect(r.promoted).toBe(false);
  });

  it('a "payroll ran" notification is NOT a payment failure', () => {
    const r = promoteEscalation({
      category: 'notification',
      subject: 'Payroll ran successfully',
      body: 'Your payroll for June has been processed.',
    });
    expect(r.category).toBe('notification');
    expect(r.promoted).toBe(false);
  });

  it('a review-subtype notification stays notification but is flagged important', () => {
    const r = promoteEscalation({
      category: 'notification',
      subject: 'You have a new review',
      body: 'Someone left you a review on your Google business profile.',
    });
    expect(r.category).toBe('notification');
    expect(r.promoted).toBe(false);
    expect(r.review_subtype).toBe(true);
    expect(r.important).toBe(true);
  });
});

describe('intent detectors', () => {
  it('account_suspension', () => {
    expect(
      detectEscalationSignal({
        category: 'notification',
        subject: 'Your account will be suspended',
        body: '',
      }),
    ).toBe('account_suspension');
  });
  it('filing_or_tax_due', () => {
    expect(
      detectEscalationSignal({
        category: 'notification',
        subject: 'Sales tax filing due Friday',
        body: '',
      }),
    ).toBe('filing_or_tax_due');
  });
  it('legal_or_compliance', () => {
    expect(
      detectEscalationSignal({
        category: 'notification',
        subject: 'Cease-and-desist notice',
        body: '',
      }),
    ).toBe('legal_or_compliance');
  });
  it('security_breach requires breach intent, not a routine login', () => {
    expect(
      detectEscalationSignal({
        category: 'notification',
        subject: 'We detected unauthorized access',
        body: '',
      }),
    ).toBe('security_breach');
    expect(
      detectEscalationSignal({
        category: 'notification',
        subject: 'New sign-in on Chrome',
        body: '',
      }),
    ).toBeNull();
  });
  it('isReviewSubtype', () => {
    expect(
      isReviewSubtype({ category: 'notification', subject: 'New review on Yelp', body: '' }),
    ).toBe(true);
    expect(isReviewSubtype({ category: 'notification', subject: 'Payroll ran', body: '' })).toBe(
      false,
    );
  });
});
