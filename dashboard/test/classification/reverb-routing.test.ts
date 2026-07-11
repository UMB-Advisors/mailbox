// Spec 002 FR7 (Stage 2b-2) — Reverb subject routing. Pure matcher, no DB.

import { describe, expect, it } from 'vitest';
import { isReverbSender, reverbRoute } from '@/lib/classification/reverb-routing';

describe('isReverbSender', () => {
  it('matches the bare domain and subdomains', () => {
    expect(isReverbSender('Reverb <messages@reverb.com>')).toBe(true);
    expect(isReverbSender('no-reply@mail.reverb.com')).toBe(true);
    expect(isReverbSender('marketplace@marketplace.reverb.com')).toBe(true);
  });
  it('does not match lookalikes or other domains', () => {
    expect(isReverbSender('a@notreverb.com')).toBe(false);
    expect(isReverbSender('a@reverb.com.evil.com')).toBe(false);
    expect(isReverbSender('a@gmail.com')).toBe(false);
    expect(isReverbSender(undefined)).toBe(false);
  });
});

describe('reverbRoute — subject patterns map to the 4 buckets', () => {
  const from = 'Reverb <messages@reverb.com>';

  it('"Message about…" → sales_lead', () => {
    expect(reverbRoute(from, 'Message about your Fender Stratocaster listing')).toBe('sales_lead');
  });
  it('payment / earnings / payout → receipt', () => {
    expect(reverbRoute(from, 'You got paid! Your payout is on the way')).toBe('receipt');
    expect(reverbRoute(from, 'Your earnings summary')).toBe('receipt');
  });
  it('feed / saved-search / matches → marketing_promo', () => {
    expect(reverbRoute(from, 'New matches from your saved search')).toBe('marketing_promo');
    expect(reverbRoute(from, 'We found new listings you might like')).toBe('marketing_promo');
  });
  it('offers → marketplace_notification', () => {
    expect(reverbRoute(from, 'Someone has an offer on your listing')).toBe(
      'marketplace_notification',
    );
    expect(reverbRoute(from, 'You received a counteroffer')).toBe('marketplace_notification');
  });

  it('non-Reverb sender → null (never hijacks other mail)', () => {
    expect(reverbRoute('buyer@gmail.com', 'Message about your guitar')).toBeNull();
  });
  it('Reverb sender with an unrecognized subject → null (falls through to LLM)', () => {
    expect(reverbRoute(from, 'Important account security update')).toBeNull();
    expect(reverbRoute(from, '')).toBeNull();
    expect(reverbRoute(from, null)).toBeNull();
  });

  it('payout outranks the generic buyer-inquiry catch (ordering)', () => {
    // a subject carrying both signals resolves to the more specific transactional bucket
    expect(reverbRoute(from, 'Payment received — message about order #123')).toBe('receipt');
  });
});
