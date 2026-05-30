// dashboard/lib/mail/imap-fetch.ts
//
// MBOX-373 (MBOX-162 V6 P2) — the IMAP Sent-folder fetch I/O. The only place the
// dashboard opens an IMAP read connection. Imports imapflow + mailparser at
// runtime, so it is loaded LAZILY (dynamic import in lib/voice/imap-backfill.ts)
// — the orchestrator + its tests stay free of these native deps. Pure helpers
// (mailbox selection, RFC822 mapping) live in imap-parse.ts and are unit-tested.
//
// NOT exercised in CI (no IMAP server) — validate on M1 against a real inbox.
// Best-effort: a message we can't parse is skipped, never fatal.

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import {
  type ImapFetchCreds,
  type ImapFetchOptions,
  parsedToCanonicalSent,
  pickSentMailbox,
} from '@/lib/mail/imap-parse';
import type { CanonicalMessage } from '@/lib/mail/providers/types';

export type { ImapFetchCreds, ImapFetchOptions } from '@/lib/mail/imap-parse';

export async function* fetchSentViaImap(
  creds: ImapFetchCreds,
  opts: ImapFetchOptions,
): AsyncIterable<CanonicalMessage> {
  const client = new ImapFlow({
    host: creds.host,
    port: creds.port,
    secure: creds.secure,
    auth: { user: creds.user, pass: creds.pass },
    logger: false,
    // Don't let one slow mailbox hang the request indefinitely.
    socketTimeout: 60_000,
  });

  await client.connect();
  try {
    const boxes = await client.list();
    const sentPath = pickSentMailbox(boxes);
    if (!sentPath) return; // no Sent folder → nothing to learn from

    const lock = await client.getMailboxLock(sentPath);
    try {
      const since = new Date(Date.now() - opts.lookbackHours * 3600 * 1000);
      const uids = (await client.search({ since }, { uid: true })) || [];
      if (uids.length === 0) return;
      // Most-recent `maxMessages` (search returns ascending UID order).
      const slice = uids.slice(-opts.maxMessages);
      const now = new Date();
      for await (const msg of client.fetch(slice, { uid: true, source: true }, { uid: true })) {
        if (!msg.source) continue;
        let canonical: CanonicalMessage;
        try {
          canonical = parsedToCanonicalSent(await simpleParser(msg.source), now);
        } catch {
          continue; // unparseable message — skip, never fail the whole backfill
        }
        if (!canonical.provider_message_id || !canonical.body) continue;
        yield canonical;
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {
      // best-effort close; the connection is torn down regardless
    });
  }
}
