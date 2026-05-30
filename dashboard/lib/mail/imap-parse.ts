// dashboard/lib/mail/imap-parse.ts
//
// MBOX-373 (MBOX-162 V6 P2) — PURE helpers for the IMAP Sent-folder backfill:
// mailbox selection + RFC822→CanonicalMessage mapping. Deliberately free of any
// RUNTIME dependency on imapflow / mailparser (only `import type`, which is
// erased) so this logic is unit-testable without those native deps installed —
// the I/O lives in imap-fetch.ts.

import type { ParsedMail } from 'mailparser';
import type { CanonicalMessage } from '@/lib/mail/providers/types';

// Minimal structural shape of an imapflow LIST entry — accepts the real
// ListResponse (which has both) without importing its type, and lets callers/
// tests pass `{ path }` alone.
export interface MailboxListEntry {
  path: string;
  specialUse?: string;
}

export interface ImapFetchCreds {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}

export interface ImapFetchOptions {
  lookbackHours: number;
  maxMessages: number;
}

// Common Sent-folder names across providers, lowercased, tried in order when the
// server doesn't advertise the SPECIAL-USE \Sent attribute (RFC 6154).
const SENT_FALLBACK_NAMES = [
  'sent',
  'sent mail',
  'sent items',
  'sent messages',
  '[gmail]/sent mail',
  'inbox.sent',
];

// Choose the Sent mailbox path from a LIST response. Prefers the \Sent
// special-use flag; else the first path whose name matches a known Sent alias.
// Returns null when nothing looks like a Sent folder.
export function pickSentMailbox(boxes: ReadonlyArray<MailboxListEntry>): string | null {
  const special = boxes.find((b) => b.specialUse === '\\Sent');
  if (special) return special.path;
  const named = boxes.find((b) => SENT_FALLBACK_NAMES.includes(b.path.toLowerCase()));
  return named ? named.path : null;
}

export function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+\n/g, '\n')
    .trim();
}

function firstAddress(field: ParsedMail['from']): string {
  if (!field) return '';
  const v = Array.isArray(field) ? field[0] : field;
  return v?.value?.[0]?.address ?? v?.text ?? '';
}

function renderTo(field: ParsedMail['to']): string {
  if (!field) return '';
  return (Array.isArray(field) ? field[0]?.text : field.text) ?? '';
}

function joinReferences(refs: ParsedMail['references']): string | null {
  if (!refs) return null;
  return Array.isArray(refs) ? refs.join(' ') : refs;
}

// Map a parsed RFC822 message to our outbound CanonicalMessage. `now` is injected
// so the no-Date fallback is deterministic in tests. Body is best-effort: the
// text/plain part, else a tag-stripped HTML part.
export function parsedToCanonicalSent(parsed: ParsedMail, now: Date): CanonicalMessage {
  const body = (parsed.text?.trim() || (parsed.html ? stripHtml(parsed.html) : '') || '').trim();
  const messageId = (parsed.messageId ?? '').replace(/^<|>$/g, '');
  return {
    provider_message_id: messageId,
    thread_id: null, // backfill doesn't need threading; persona extraction ignores it
    from_addr: firstAddress(parsed.from),
    to_addr: renderTo(parsed.to),
    subject: parsed.subject ?? '',
    body,
    in_reply_to: parsed.inReplyTo ?? null,
    references: joinReferences(parsed.references),
    received_at: (parsed.date ?? now).toISOString(),
    direction: 'outbound',
  };
}
