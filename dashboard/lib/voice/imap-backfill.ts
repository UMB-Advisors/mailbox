// dashboard/lib/voice/imap-backfill.ts
//
// MBOX-373 (MBOX-162 V6 P2) — orchestrates the IMAP Sent-history backfill that
// gives a newly-connected inbox a voice to learn from. Loads the account's
// stored IMAP credential, pulls its recent Sent mail (fetchSentViaImap), and
// archives each message into mailbox.sent_history tagged with the account_id —
// from there the P1 account-scoped persona refresh extracts the voice.
//
// The IMAP fetch is injected (`deps.fetchSent`) so the ingest path is DB-testable
// without a live IMAP server; production uses the real imapflow fetch.

import { sql } from 'kysely';
import { getKysely } from '@/lib/db';
// Type-only — the runtime imapflow/mailparser I/O is dynamic-imported below so
// this module (and its tests, which inject `deps.fetchSent`) never loads those
// native deps.
import type { ImapFetchCreds } from '@/lib/mail/imap-parse';
import type { CanonicalMessage } from '@/lib/mail/providers/types';
import { decryptToken } from '@/lib/oauth/google';

// Default window for the cold-start pull. 1 year of Sent mail, capped — enough
// to characterize voice without an unbounded fetch on a large mailbox.
const DEFAULT_LOOKBACK_HOURS = 365 * 24;
const DEFAULT_MAX_MESSAGES = 500;

export interface ImapVoiceBackfillResult {
  account_id: number;
  fetched: number;
  inserted: number;
}

export type SentFetcher = (
  creds: ImapFetchCreds,
  opts: { lookbackHours: number; maxMessages: number },
) => AsyncIterable<CanonicalMessage>;

export interface ImapVoiceBackfillDeps {
  // Injectable for tests; defaults to the real imapflow fetch.
  fetchSent?: SentFetcher;
  lookbackHours?: number;
  maxMessages?: number;
}

export class VoiceBackfillError extends Error {
  constructor(
    public readonly code: 'not_found' | 'not_imap' | 'no_credential' | 'bad_config',
    message: string,
  ) {
    super(message);
    this.name = 'VoiceBackfillError';
  }
}

interface AccountCredRow {
  provider: string;
  provider_config: Record<string, unknown> | null;
  provider_secret_enc: string | null;
}

function buildCreds(cfg: Record<string, unknown>, pass: string): ImapFetchCreds {
  const host = cfg.imap_host;
  const port = cfg.imap_port;
  const user = cfg.username;
  if (typeof host !== 'string' || !host) {
    throw new VoiceBackfillError('bad_config', 'account provider_config is missing imap_host');
  }
  if (typeof user !== 'string' || !user) {
    throw new VoiceBackfillError('bad_config', 'account provider_config is missing username');
  }
  return {
    host,
    port: typeof port === 'number' ? port : 993,
    // tls defaults true (stored configs set tls:true); only an explicit false opts out.
    secure: cfg.tls !== false,
    user,
    pass,
  };
}

// Archive one fetched Sent message into sent_history for `accountId`. Mirrors the
// Gmail backfill's upsertReply contract (source='backfill', category 'unknown',
// draft_source 'local'), but sets account_id EXPLICITLY (this is account #2+).
// Dedup on the (account_id, message_id) partial unique index. Returns true on a
// fresh insert, false when the row already existed.
async function archiveSent(accountId: number, m: CanonicalMessage): Promise<boolean> {
  const db = getKysely();
  const r = await db
    .insertInto('sent_history')
    .values({
      account_id: accountId,
      message_id: m.provider_message_id,
      draft_id: null,
      inbox_message_id: null,
      from_addr: m.from_addr,
      to_addr: m.to_addr,
      subject: m.subject || null,
      body_text: null,
      thread_id: m.thread_id,
      draft_original: null,
      draft_sent: m.body,
      draft_source: 'local',
      classification_category: 'unknown',
      classification_confidence: 0,
      sent_at: m.received_at,
      source: 'backfill',
      rag_context_refs: sql`'[]'::jsonb`,
    })
    .onConflict((oc) =>
      oc.columns(['account_id', 'message_id']).where('message_id', 'is not', null).doNothing(),
    )
    .executeTakeFirst();
  return (r?.numInsertedOrUpdatedRows ?? BigInt(0)) !== BigInt(0);
}

export async function runImapVoiceBackfill(
  accountId: number,
  deps: ImapVoiceBackfillDeps = {},
): Promise<ImapVoiceBackfillResult> {
  const db = getKysely();
  const acct = (await db
    .selectFrom('accounts')
    .select(['provider', 'provider_config', 'provider_secret_enc'])
    .where('id', '=', accountId)
    .executeTakeFirst()) as AccountCredRow | undefined;

  if (!acct) throw new VoiceBackfillError('not_found', `no account with id ${accountId}`);
  if (acct.provider !== 'imap') {
    throw new VoiceBackfillError(
      'not_imap',
      `voice backfill is IMAP-only; account ${accountId} is '${acct.provider}'`,
    );
  }
  if (!acct.provider_secret_enc) {
    throw new VoiceBackfillError(
      'no_credential',
      `account ${accountId} has no stored IMAP credential — reconnect it first`,
    );
  }

  const creds = buildCreds(acct.provider_config ?? {}, decryptToken(acct.provider_secret_enc));
  // Lazy-load the imapflow I/O only on the real path; tests inject deps.fetchSent.
  const fetchSent = deps.fetchSent ?? (await import('@/lib/mail/imap-fetch')).fetchSentViaImap;
  const opts = {
    lookbackHours: deps.lookbackHours ?? DEFAULT_LOOKBACK_HOURS,
    maxMessages: deps.maxMessages ?? DEFAULT_MAX_MESSAGES,
  };

  let fetched = 0;
  let inserted = 0;
  for await (const m of fetchSent(creds, opts)) {
    fetched++;
    if (await archiveSent(accountId, m)) inserted++;
  }
  return { account_id: accountId, fetched, inserted };
}
