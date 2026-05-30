import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type GmailMessage, gmailMessageToCanonical } from '@/lib/mail/gmail-parse';
import { signState, verifyState } from '@/lib/oauth/google';

// MBOX-399 (MBOX-162 V6 P3) — pure cores: Gmail message→CanonicalMessage mapping
// and the account_id-in-state round-trip. No DB, no network.

const NOW = new Date('2026-05-30T12:00:00.000Z');
const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

function msg(overrides: Partial<GmailMessage>): GmailMessage {
  return overrides;
}

describe('gmailMessageToCanonical', () => {
  it('maps headers + a text/plain part to an outbound CanonicalMessage', () => {
    const m = gmailMessageToCanonical(
      msg({
        id: 'gmailid123',
        internalDate: '1748600000000',
        payload: {
          mimeType: 'multipart/alternative',
          headers: [
            { name: 'From', value: 'founder@startup.test' },
            { name: 'To', value: 'customer@example.com' },
            { name: 'Subject', value: 'Re: your order' },
            { name: 'Message-ID', value: '<abc@startup.test>' },
            { name: 'Date', value: 'Fri, 01 May 2026 09:00:00 +0000' },
            { name: 'References', value: '<root@x> <prev@x>' },
          ],
          parts: [
            { mimeType: 'text/plain', body: { data: b64url('Hi — happy to help. Best, Dustin') } },
            { mimeType: 'text/html', body: { data: b64url('<p>ignored</p>') } },
          ],
        },
      }),
      NOW,
    );
    expect(m).toEqual({
      provider_message_id: 'abc@startup.test',
      thread_id: null,
      from_addr: 'founder@startup.test',
      to_addr: 'customer@example.com',
      subject: 'Re: your order',
      body: 'Hi — happy to help. Best, Dustin',
      in_reply_to: null,
      references: '<root@x> <prev@x>',
      received_at: '2026-05-01T09:00:00.000Z',
      direction: 'outbound',
    });
  });

  it('falls back to tag-stripped HTML when there is no text/plain part', () => {
    const m = gmailMessageToCanonical(
      msg({
        payload: {
          mimeType: 'text/html',
          headers: [{ name: 'Message-ID', value: 'x@y' }],
          body: { data: b64url('<p>Hello&nbsp;<b>world</b></p>') },
        },
      }),
      NOW,
    );
    expect(m.body).toBe('Hello world');
    expect(m.provider_message_id).toBe('x@y');
  });

  it('uses internalDate then now when the Date header is missing/invalid', () => {
    const m = gmailMessageToCanonical(
      msg({
        internalDate: '1748600000000', // 2025-05-30T11:33:20Z
        payload: { headers: [{ name: 'Message-ID', value: 'a@b' }], body: { data: b64url('hi') } },
      }),
      NOW,
    );
    expect(m.received_at).toBe(new Date(1748600000000).toISOString());
  });
});

describe('signState / verifyState with account_id (MBOX-399)', () => {
  const saved = process.env.MAILBOX_OAUTH_STATE_SECRET;
  beforeAll(() => {
    process.env.MAILBOX_OAUTH_STATE_SECRET = 'test-state-secret';
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.MAILBOX_OAUTH_STATE_SECRET;
    else process.env.MAILBOX_OAUTH_STATE_SECRET = saved;
  });

  it('round-trips an account-scoped gmail grant', () => {
    const v = verifyState(signState('gmail', 'nonce123', 42));
    expect(v).toEqual({ provider: 'gmail', nonce: 'nonce123', accountId: 42 });
  });

  it('round-trips a legacy provider grant with no account_id (backward-compatible)', () => {
    const v = verifyState(signState('google_calendar', 'n0nce'));
    expect(v).toEqual({ provider: 'google_calendar', nonce: 'n0nce', accountId: undefined });
  });

  it('rejects a tampered state', () => {
    const s = signState('gmail', 'nonce123', 42);
    expect(verifyState(`${s}x`)).toBeNull();
  });
});
