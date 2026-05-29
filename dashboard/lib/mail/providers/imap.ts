// dashboard/lib/mail/providers/imap.ts
//
// MBOX-357 (P1) — ImapSmtpProvider: the first non-Gmail transport behind the
// MailProvider seam (DR-55). This file is the DECISION-INDEPENDENT core
// (T1 + T2): normalize, thread-id synthesis, rate-limit parsing, capabilities —
// all pure and unit-tested. It does NOT decide where IMAP I/O runs (n8n
// MailBOX-Imap workflow vs dashboard-owned poll loop, the DR-56 crux) — the
// transport methods throw NotImplementedYet until that's resolved (T5).
//
// The hard part is threading (FR-MP-1 / gate S-MP-2): IMAP has no native thread
// id, so we synthesize a stable one from the RFC5322 References / In-Reply-To
// header chain. See normalizeThreadId.

import { createHash } from 'node:crypto';
import type {
  BackfillOptions,
  CanonicalMessage,
  MailAccount,
  MailProvider,
  ProviderCapabilities,
  RateLimitHint,
  SendRequest,
  SendResult,
} from './types';

export class NotImplementedYet extends Error {
  constructor(method: string) {
    super(
      `ImapSmtpProvider.${method}() — transport I/O lands in P1 T5, pending the ` +
        `DR-56 decision (n8n MailBOX-Imap workflow vs dashboard-owned poll loop).`,
    );
    this.name = 'NotImplementedYet';
  }
}

// Default cooldown when a throttle signal is detected but the server gives no
// machine-readable retry hint (IMAP/SMTP rarely do). Conservative — the
// cooldown's only job is to stop an immediate re-fire. Overridable per host
// later via provider_config.
const DEFAULT_THROTTLE_COOLDOWN_MS = 15 * 60 * 1000;

// IMAP/SMTP throttle / temporary-failure signals. SMTP 4xx (421 service not
// available, 450/451 mailbox busy / local error) + common textual hints.
const THROTTLE_RE =
  /\b(421|45[01])\b|too many|throttl|rate limit|try again later|\[LIMIT\]|\[THROTTLED\]/i;

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

// Strip RFC5322 angle brackets + surrounding whitespace from a Message-ID.
// '<abc@host>' → 'abc@host'. Tolerant of already-bare ids and empty input.
function bareMsgId(v: unknown): string {
  return str(v).trim().replace(/^<|>$/g, '').trim();
}

function strOrNullId(v: unknown): string | null {
  const b = bareMsgId(v);
  return b.length > 0 ? b : null;
}

function asText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

// Deterministic, uniform-length thread key from a root identifier. Prefixed so a
// synthesized IMAP thread_id is visibly distinguishable from a native Gmail one
// when debugging mailbox.drafts.thread_id.
function synthThreadId(root: string): string {
  return `imap-${createHash('sha256').update(root).digest('hex').slice(0, 32)}`;
}

// First (oldest / root) Message-ID in a References header. References is a
// space-separated list ordered oldest→newest, so the FIRST entry is the
// conversation root — the stable key every message in the thread shares.
function referencesRoot(references: unknown): string | null {
  const raw = str(references).trim();
  if (!raw) return null;
  const first = raw.split(/\s+/).find((t) => t.trim().length > 0);
  return first ? bareMsgId(first) : null;
}

export class ImapSmtpProvider implements MailProvider {
  readonly kind = 'imap' as const;

  readonly capabilities: ProviderCapabilities = {
    nativeThreading: false, // synthesized from headers — see normalizeThreadId.
    push: false, // poll-only (IMAP IDLE is flaky across hosts; not used in v1).
    quoteStrategy: 'generic',
  };

  // Map an IMAP-shaped inbound payload → CanonicalMessage. Tolerant of the key
  // variants emitted by n8n's emailReadImap node and by imapflow envelopes.
  normalize(raw: unknown): CanonicalMessage {
    const r = (raw ?? {}) as Record<string, unknown>;
    const msg: CanonicalMessage = {
      provider_message_id: bareMsgId(r.message_id ?? r.messageId ?? r['message-id']),
      thread_id: null, // set below via normalizeThreadId once fields are populated
      from_addr: str(r.from_addr ?? r.from),
      to_addr: str(r.to_addr ?? r.to),
      subject: str(r.subject),
      body: str(r.body ?? r.text ?? r.snippet),
      in_reply_to: strOrNullId(r.in_reply_to ?? r.inReplyTo ?? r['in-reply-to']),
      references: ((): string | null => {
        const v = str(r.references).trim();
        return v.length > 0 ? v : null;
      })(),
      received_at: str(r.received_at ?? r.date),
      direction: r.direction === 'outbound' ? 'outbound' : 'inbound',
    };
    msg.thread_id = this.normalizeThreadId(msg);
    return msg;
  }

  // Synthesize a stable thread_id from the header chain (FR-MP-1):
  //   1. References root (oldest id in the chain) — the conversation anchor.
  //   2. else In-Reply-To — direct parent (single-reply threads with no References).
  //   3. else the message's own id — it IS a thread root (new conversation).
  //   4. else null — no usable identifier (degraded; flat handling upstream).
  // Every message in a thread resolves to the same root → same thread_id.
  // (A subject+participants fallback is intentionally NOT done — it risks
  //  false-merging unrelated mail; flagged low-confidence in the plan, deferred.)
  normalizeThreadId(msg: CanonicalMessage): string | null {
    const root =
      referencesRoot(msg.references) ?? msg.in_reply_to ?? (msg.provider_message_id || null);
    return root ? synthThreadId(root) : null;
  }

  // IMAP/SMTP have no standard machine-readable retry hint. Detect a throttle /
  // temporary-failure signal and return a conservative future cooldown; else
  // null. (Contrast GmailProvider, which parses Google's explicit "Retry after".)
  parseRateLimit(error: unknown): RateLimitHint {
    if (!THROTTLE_RE.test(asText(error))) return { until: null };
    return { until: new Date(Date.now() + DEFAULT_THROTTLE_COOLDOWN_MS) };
  }

  // --- Transport I/O: P1 T5, pending the DR-56 decision (see file header). ---
  listNew(
    _account: MailAccount,
    _cursor: unknown,
  ): Promise<{ messages: CanonicalMessage[]; cursor: unknown }> {
    throw new NotImplementedYet('listNew');
  }

  send(_account: MailAccount, _req: SendRequest): Promise<SendResult> {
    throw new NotImplementedYet('send');
  }

  backfillSent(_account: MailAccount, _opts: BackfillOptions): AsyncIterable<CanonicalMessage> {
    throw new NotImplementedYet('backfillSent');
  }
}
