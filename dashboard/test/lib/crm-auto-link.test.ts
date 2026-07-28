import { describe, expect, it } from 'vitest';
import {
  extractEmailDomain,
  FREE_MAIL_DOMAINS,
  generateSlug,
  isFreeMailDomain,
  resolveBusinessName,
} from '@/lib/crm/auto-link';

// M5 Phase 5 Plan 2 — the single shared account→business resolution rule
// (D-16). This block is pure-function only — no I/O, must run on every CI
// machine with no TEST_POSTGRES_URL set.

describe('auto-link — pure functions (no DB)', () => {
  describe('generateSlug', () => {
    it.each([
      ['Altitude Guitar', 'altitude-guitar'],
      ['UMB Advisors', 'umb-advisors'],
      ['AutoCSR', 'autocsr'],
      ['Jiffy Auto Glass', 'jiffy-auto-glass'],
      ['Elevated Advisory', 'elevated-advisory'],
      ['Bonvillian Design', 'bonvillian-design'],
      ['  Café  Ünïcode  ', 'cafe-unicode'],
      ['!!!', 'business'],
    ])('generateSlug(%j) -> %j', (input, expected) => {
      expect(generateSlug(input)).toBe(expected);
    });

    it('is idempotent for every live business name plus the edge cases', () => {
      const names = [
        'Altitude Guitar',
        'UMB Advisors',
        'AutoCSR',
        'Jiffy Auto Glass',
        'Elevated Advisory',
        'Bonvillian Design',
        '  Café  Ünïcode  ',
        '!!!',
      ];
      for (const name of names) {
        const once = generateSlug(name);
        const twice = generateSlug(once);
        expect(twice).toBe(once);
      }
    });
  });

  describe('extractEmailDomain', () => {
    it('lowercases and extracts the domain', () => {
      expect(extractEmailDomain('mike@Altitudeguitar.com')).toBe('altitudeguitar.com');
    });

    it('returns empty string when there is no @', () => {
      expect(extractEmailDomain('not-an-email')).toBe('');
    });
  });

  describe('isFreeMailDomain', () => {
    it('matches case-insensitively', () => {
      expect(isFreeMailDomain('GMAIL.com')).toBe(true);
    });

    it('returns false for a non-free-mail domain', () => {
      expect(isFreeMailDomain('umbadvisors.com')).toBe(false);
    });

    it('contains exactly the twelve D-07 hosts', () => {
      expect([...FREE_MAIL_DOMAINS].sort()).toEqual(
        [
          'gmail.com',
          'googlemail.com',
          'outlook.com',
          'hotmail.com',
          'live.com',
          'yahoo.com',
          'icloud.com',
          'me.com',
          'aol.com',
          'proton.me',
          'protonmail.com',
          'msn.com',
        ].sort(),
      );
    });
  });

  describe('resolveBusinessName', () => {
    it('prefers a non-blank display label (D-06)', () => {
      expect(resolveBusinessName('mike@autocsr.com', 'AutoCSR')).toBe('AutoCSR');
    });

    it('falls back to the email domain when no label', () => {
      expect(resolveBusinessName('mike@autocsr.com', null)).toBe('autocsr.com');
    });

    it('treats a whitespace-only label as no label', () => {
      expect(resolveBusinessName('mike@autocsr.com', '   ')).toBe('autocsr.com');
    });

    it('resolves names identically for free-mail domains (Pitfall 3)', () => {
      expect(resolveBusinessName('mike@gmail.com', 'Mike Personal')).toBe('Mike Personal');
    });
  });
});
