// dashboard/lib/mail/providers/__tests__/imap.test.ts
//
// MBOX-357 (P1) — ImapSmtpProvider pure logic (T1) + threading synthesis (T2).
// The threading cases are the S-MP-2 gate in miniature: prove that messages in
// the same conversation resolve to one stable thread_id from header chains.

import { describe, expect, it } from 'vitest';
import { ImapSmtpProvider, NotImplementedYet, providerFor, providerForKind } from '..';

const imap = new ImapSmtpProvider();

describe('ImapSmtpProvider.normalize', () => {
  it('maps an IMAP payload, tolerating n8n/imapflow key variants', () => {
    const msg = imap.normalize({
      messageId: '<abc@host>',
      from: 'a@x.com',
      to: 'b@y.com',
      subject: 'Re: hi',
      text: 'hello',
      inReplyTo: '<m1@x>',
      references: '<m0@x> <m1@x>',
      date: '2026-05-29T00:00:00.000Z',
    });
    expect(msg.provider_message_id).toBe('abc@host'); // angle brackets stripped
    expect(msg.from_addr).toBe('a@x.com');
    expect(msg.to_addr).toBe('b@y.com');
    expect(msg.body).toBe('hello'); // text → body
    expect(msg.in_reply_to).toBe('m1@x');
    expect(msg.received_at).toBe('2026-05-29T00:00:00.000Z'); // date → received_at
    expect(msg.direction).toBe('inbound');
  });

  it('also accepts the canonical snake_case keys', () => {
    const msg = imap.normalize({
      message_id: 'bare-id',
      from_addr: 'a@x.com',
      to_addr: 'b@y.com',
      body: 'hi',
      received_at: '2026-05-29T00:00:00.000Z',
    });
    expect(msg.provider_message_id).toBe('bare-id');
    expect(msg.in_reply_to).toBeNull();
    expect(msg.references).toBeNull();
  });
});

describe('ImapSmtpProvider.normalizeThreadId (S-MP-2 synthesis)', () => {
  it('uses the References ROOT (oldest id), not the most recent', () => {
    const m = imap.normalize({ message_id: '<r3@h>', references: '<root@h> <r2@h>' });
    // thread keyed on root@h, deterministic + provenance-prefixed
    expect(m.thread_id).toMatch(/^imap-[0-9a-f]{32}$/);
    expect(m.thread_id).toBe(
      imap.normalize({ message_id: '<other@h>', references: '<root@h>' }).thread_id,
    );
  });

  it('a root message and a reply that references it share ONE thread_id', () => {
    const root = imap.normalize({ message_id: '<root@h>' }); // no refs / no in-reply-to
    const reply = imap.normalize({
      message_id: '<r2@h>',
      references: '<root@h> <r1@h>',
      in_reply_to: '<r1@h>',
    });
    expect(root.thread_id).toBe(reply.thread_id);
  });

  it('falls back to In-Reply-To when there is no References header', () => {
    const m = imap.normalize({ message_id: '<r2@h>', in_reply_to: '<parent@h>' });
    expect(m.thread_id).toBe(imap.normalize({ message_id: '<parent@h>' }).thread_id);
  });

  it('treats a message with no chain headers as its own thread root', () => {
    const m = imap.normalize({ message_id: '<solo@h>' });
    expect(m.thread_id).not.toBeNull();
  });

  it('returns null thread_id when there is no usable identifier at all', () => {
    expect(imap.normalize({ subject: 'orphan' }).thread_id).toBeNull();
  });
});

describe('ImapSmtpProvider.parseRateLimit', () => {
  it('detects SMTP 4xx / textual throttle signals → future cooldown', () => {
    for (const e of [
      '421 4.7.0 Try again later',
      '450 mailbox busy',
      'Too many concurrent connections',
      new Error('Account temporarily rate limited'),
    ]) {
      const { until } = imap.parseRateLimit(e);
      expect(until).not.toBeNull();
      expect(until!.getTime()).toBeGreaterThan(Date.now());
    }
  });

  it('returns null for a non-throttle error', () => {
    expect(imap.parseRateLimit('550 mailbox not found').until).toBeNull();
    expect(imap.parseRateLimit('connection reset').until).toBeNull();
  });
});

describe('ImapSmtpProvider capabilities + boundaries', () => {
  it('declares synthesized threading, poll-only, generic quote strategy', () => {
    expect(imap.capabilities).toEqual({
      nativeThreading: false,
      push: false,
      quoteStrategy: 'generic',
    });
  });

  it('transport I/O throws NotImplementedYet (P1 T5, pending DR-56)', () => {
    const acct = { id: 1, provider: 'imap' as const, provider_config: {} };
    expect(() => imap.listNew(acct, null)).toThrow(NotImplementedYet);
    expect(() =>
      imap.send(acct, {
        thread_id: null,
        in_reply_to: null,
        to_addr: 'a@b.c',
        subject: 's',
        body: 'b',
      }),
    ).toThrow(NotImplementedYet);
    expect(() => imap.backfillSent(acct, { lookbackHours: 24 })).toThrow(NotImplementedYet);
  });
});

describe('providerFor factory — imap arm (P1)', () => {
  it('returns an ImapSmtpProvider for imap', () => {
    expect(providerForKind('imap')).toBeInstanceOf(ImapSmtpProvider);
    expect(providerFor({ provider: 'imap' }).kind).toBe('imap');
  });
});
