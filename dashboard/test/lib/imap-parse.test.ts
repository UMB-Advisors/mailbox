import type { ParsedMail } from 'mailparser';
import { describe, expect, it } from 'vitest';
import { parsedToCanonicalSent, pickSentMailbox, stripHtml } from '@/lib/mail/imap-parse';

// MBOX-373 (MBOX-162 V6 P2) — pure IMAP-backfill helpers. No DB, no network,
// no runtime imapflow/mailparser (type-only) → always runs.

const NOW = new Date('2026-05-30T12:00:00.000Z');

// Build a minimal ParsedMail. mailparser's real type is large; we only populate
// the fields parsedToCanonicalSent reads.
function parsed(overrides: Record<string, unknown>): ParsedMail {
  return overrides as unknown as ParsedMail;
}

describe('pickSentMailbox', () => {
  it('prefers the \\Sent special-use flag over the name', () => {
    const path = pickSentMailbox([
      { path: 'INBOX', specialUse: undefined },
      { path: 'Verzonden', specialUse: '\\Sent' }, // non-English name, but flagged
      { path: 'Sent', specialUse: undefined },
    ]);
    expect(path).toBe('Verzonden');
  });

  it('falls back to a known Sent alias (case-insensitive) when no flag', () => {
    expect(pickSentMailbox([{ path: 'INBOX' }, { path: '[Gmail]/Sent Mail' }])).toBe(
      '[Gmail]/Sent Mail',
    );
    expect(pickSentMailbox([{ path: 'Sent Items' }])).toBe('Sent Items');
  });

  it('returns null when nothing looks like a Sent folder', () => {
    expect(pickSentMailbox([{ path: 'INBOX' }, { path: 'Archive' }])).toBeNull();
  });
});

describe('parsedToCanonicalSent', () => {
  it('maps a text/plain message to an outbound CanonicalMessage', () => {
    const m = parsedToCanonicalSent(
      parsed({
        messageId: '<abc123@founder.test>',
        from: {
          value: [{ address: 'founder@startup.test' }],
          text: 'Founder <founder@startup.test>',
        },
        to: { text: 'customer@example.com' },
        subject: 'Re: your order',
        text: 'Hi there,\n\nHappy to help. Best,\nDustin',
        date: new Date('2026-05-01T09:00:00.000Z'),
        inReplyTo: '<inbound@example.com>',
        references: ['<root@example.com>', '<inbound@example.com>'],
      }),
      NOW,
    );
    expect(m).toEqual({
      provider_message_id: 'abc123@founder.test', // <> stripped
      thread_id: null,
      from_addr: 'founder@startup.test',
      to_addr: 'customer@example.com',
      subject: 'Re: your order',
      body: 'Hi there,\n\nHappy to help. Best,\nDustin',
      in_reply_to: '<inbound@example.com>',
      references: '<root@example.com> <inbound@example.com>',
      received_at: '2026-05-01T09:00:00.000Z',
      direction: 'outbound',
    });
  });

  it('derives body from HTML when there is no text part', () => {
    const m = parsedToCanonicalSent(
      parsed({
        messageId: 'no-brackets@test',
        from: { value: [{ address: 'a@b.test' }] },
        to: { text: 'c@d.test' },
        html: '<p>Hello&nbsp;<b>world</b></p><script>x()</script>',
        date: new Date('2026-05-02T00:00:00.000Z'),
      }),
      NOW,
    );
    expect(m.body).toBe('Hello world');
    expect(m.provider_message_id).toBe('no-brackets@test');
  });

  it('falls back to the injected now when the message has no Date', () => {
    const m = parsedToCanonicalSent(
      parsed({ messageId: 'x@y', from: { text: 'a@b' }, to: { text: 'c@d' }, text: 'hi' }),
      NOW,
    );
    expect(m.received_at).toBe(NOW.toISOString());
    expect(m.from_addr).toBe('a@b'); // falls back to .text when no parsed address
  });
});

describe('stripHtml', () => {
  it('removes tags, scripts/styles, and decodes basic entities', () => {
    expect(stripHtml('<style>p{}</style><p>a &amp; b</p>')).toBe('a & b');
  });
});
