// dashboard/lib/mail/gmail-fetch.ts
//
// MBOX-399 (MBOX-162 V6 P3) — Gmail REST Sent fetch for the per-account voice
// backfill. Plain fetch (no googleapis dep — CLAUDE.md dependency-light
// constraint), Bearer access token from the per-account google_gmail grant
// (lib/oauth/google.getAccessToken). The pure mapping is in gmail-parse.ts; the
// provider seam (GmailProvider.backfillSent) delegates here. NOT CI-runnable
// (needs a live Google token) — M1-validated. Best-effort: a message we can't
// fetch/parse is skipped, never fatal to the whole backfill.

import { type GmailMessage, gmailMessageToCanonical } from '@/lib/mail/gmail-parse';
import type { CanonicalMessage } from '@/lib/mail/providers/types';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

export interface GmailFetchOptions {
  lookbackHours: number;
  maxMessages: number;
}

async function gmailGet<T>(path: string, accessToken: string): Promise<T> {
  const res = await fetch(`${GMAIL_API}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Gmail API ${res.status} on ${path}: ${detail.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

// Stream the account's Sent messages over the lookback window as
// CanonicalMessages. `now` is injected so the mapping stays deterministic in a
// test; the list query's `after:` bound uses the wall clock (this is live I/O,
// not a pure unit). messages.list returns newest-first, so the natural slice is
// already the most-recent N.
export async function* fetchSentViaGmail(
  accessToken: string,
  opts: GmailFetchOptions,
): AsyncIterable<CanonicalMessage> {
  // Gmail's `after:` query takes a unix-seconds timestamp; scope to the window.
  const afterSec = Math.floor((Date.now() - opts.lookbackHours * 3600 * 1000) / 1000);
  const q = encodeURIComponent(`in:sent after:${afterSec}`);
  const list = await gmailGet<{ messages?: Array<{ id: string }> }>(
    `/messages?q=${q}&maxResults=${opts.maxMessages}`,
    accessToken,
  );
  const ids = (list.messages ?? []).slice(0, opts.maxMessages);
  const now = new Date();
  for (const { id } of ids) {
    let msg: GmailMessage;
    try {
      msg = await gmailGet<GmailMessage>(`/messages/${id}?format=full`, accessToken);
    } catch {
      continue; // skip a message we couldn't fetch — never abort the backfill
    }
    const canonical = gmailMessageToCanonical(msg, now);
    // A row with no stable id or no body teaches nothing about voice — skip it
    // (mirrors the IMAP path's malformed-skip, but pre-filtered here).
    if (!canonical.provider_message_id || !canonical.body) continue;
    yield canonical;
  }
}

// AgentBOX mailbox Phase 1 — NATIVE inbound ingestion sibling of
// fetchSentViaGmail. Streams UNREAD inbound messages over a bounded recent
// window as CanonicalMessages tagged direction:'inbound' and carrying Gmail's
// native threadId (the Sent path doesn't need a thread id; inbound ingestion
// does, so the inbox row threads correctly). Read-only: gmail.readonly + a
// list/get over users/me — never sends or modifies. Best-effort per-message
// skip mirrors the Sent path. BOUNDED by maxMessages (the caller caps this for
// the single-account validation).
export async function* fetchInboxViaGmail(
  accessToken: string,
  opts: GmailFetchOptions,
): AsyncIterable<CanonicalMessage> {
  // newer_than:Nd is Gmail's relative-window operator; derive whole days from
  // the lookback hours (min 1) so the validation's 7d window maps cleanly.
  const days = Math.max(1, Math.ceil(opts.lookbackHours / 24));
  // is:unread in:inbox -from:me — only fresh inbound, exclude our own sends that
  // Gmail also files under the conversation. Bounded by newer_than to keep the
  // list small on a busy mailbox.
  const q = encodeURIComponent(`is:unread in:inbox -from:me newer_than:${days}d`);
  const list = await gmailGet<{ messages?: Array<{ id: string }> }>(
    `/messages?q=${q}&maxResults=${opts.maxMessages}`,
    accessToken,
  );
  const ids = (list.messages ?? []).slice(0, opts.maxMessages);
  const now = new Date();
  for (const { id } of ids) {
    let msg: GmailMessageWithThread;
    try {
      msg = await gmailGet<GmailMessageWithThread>(`/messages/${id}?format=full`, accessToken);
    } catch {
      continue; // skip a message we couldn't fetch — never abort the sweep
    }
    const canonical = gmailMessageToCanonical(msg, now);
    if (!canonical.provider_message_id || !canonical.body) continue;
    // gmailMessageToCanonical hardcodes the Sent-path values (thread_id:null,
    // direction:'outbound'); inbound ingestion needs the real threadId so the
    // inbox row threads, and the inbound direction.
    yield { ...canonical, thread_id: msg.threadId ?? null, direction: 'inbound' };
  }
}

// users.messages.get?format=full also returns a top-level threadId that the
// pure gmail-parse mapper (Sent-only, thread-id-agnostic) doesn't model.
interface GmailMessageWithThread extends GmailMessage {
  threadId?: string;
}
