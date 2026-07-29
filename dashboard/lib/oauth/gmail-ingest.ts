// Account-agnostic Gmail ingestion credentials (connect-and-go onboarding).
//
// THE SIMPLIFICATION (MBOX — multi-account onboarding): instead of one n8n
// `gmailOAuth2` credential per account wired into its own workflow branch (manual
// editor surgery per client), n8n ingests with a single account-agnostic loop:
//
//     GET /api/internal/gmail/accounts        -> the connected mailboxes
//     for each: GET /api/internal/gmail/token -> a fresh Gmail access token
//     -> HTTP Gmail API -> POST /api/internal/inbox-messages (account_email)
//
// Credentials live ONLY here (mailbox.oauth_tokens, provider 'google_gmail',
// populated from the dashboard's single source of truth — see
// scripts/sync-google-accounts-from-hermes.ts). Connecting a new account in the
// dashboard is then the ONLY onboarding step; the loop auto-discovers it. No n8n
// change per account, ever.
//
// These refresh tokens were minted by the dashboard's Google OAuth *Web* client,
// so refreshing them needs THAT client's id/secret — GOOGLE_DASHBOARD_CLIENT_ID /
// GOOGLE_DASHBOARD_CLIENT_SECRET (falling back to the appliance's GOOGLE_OAUTH_*
// when the dashboard reuses the appliance client).

import { getPool } from '@/lib/db';
import { decryptToken } from '@/lib/oauth/google';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GMAIL_INGEST_PROVIDER = 'google_gmail';

export interface IngestAccount {
  account_id: number;
  account_email: string;
}

// Every mailbox that has a stored Gmail ingestion token. This is the list n8n
// loops over — its length is the only thing that changes when a client connects
// or disconnects an account.
export async function listIngestAccounts(): Promise<IngestAccount[]> {
  const pool = getPool();
  const r = await pool.query<{ account_id: number; account_email: string }>(
    `SELECT a.id AS account_id, a.email_address AS account_email
       FROM mailbox.accounts a
       JOIN mailbox.oauth_tokens o
         ON o.account_id = a.id AND o.provider = $1
      WHERE o.refresh_token_enc IS NOT NULL
      ORDER BY a.id`,
    [GMAIL_INGEST_PROVIDER],
  );
  return r.rows;
}

function dashboardClientCreds(): { clientId: string; clientSecret: string } {
  const clientId = (process.env.GOOGLE_DASHBOARD_CLIENT_ID || process.env.GOOGLE_OAUTH_CLIENT_ID || '').trim();
  const clientSecret = (
    process.env.GOOGLE_DASHBOARD_CLIENT_SECRET ||
    process.env.GOOGLE_OAUTH_CLIENT_SECRET ||
    ''
  ).trim();
  if (!clientId || !clientSecret) {
    throw new Error(
      'GOOGLE_DASHBOARD_CLIENT_ID / GOOGLE_DASHBOARD_CLIENT_SECRET not set — ' +
        'needed to refresh dashboard-issued Gmail tokens',
    );
  }
  return { clientId, clientSecret };
}

export interface MintedToken {
  account_id: number;
  account_email: string;
  access_token: string;
  expiry_date: number; // epoch ms
}

export class GmailIngestError extends Error {
  constructor(
    message: string,
    readonly kind: 'not_connected' | 'auth' | 'transient',
    readonly status?: number,
  ) {
    super(message);
    this.name = 'GmailIngestError';
  }
}

// Mint a short-lived Gmail access token for one connected account from its stored
// refresh token. Typed errors so the n8n loop / caller can branch: 'not_connected'
// (no token row), 'auth' (refresh rejected → reconnect in dashboard), 'transient'
// (network/5xx → retry next cycle).
export async function mintGmailAccessToken(accountId: number): Promise<MintedToken> {
  const pool = getPool();
  const r = await pool.query<{ refresh_token_enc: string | null; account_email: string | null }>(
    `SELECT o.refresh_token_enc, a.email_address AS account_email
       FROM mailbox.oauth_tokens o
       JOIN mailbox.accounts a ON a.id = o.account_id
      WHERE o.provider = $1 AND o.account_id = $2`,
    [GMAIL_INGEST_PROVIDER, accountId],
  );
  const row = r.rows[0];
  if (!row?.refresh_token_enc) {
    throw new GmailIngestError(`account ${accountId} has no Gmail ingestion token`, 'not_connected', 404);
  }
  const refreshToken = decryptToken(row.refresh_token_enc);
  const { clientId, clientSecret } = dashboardClientCreds();

  let res: Response;
  try {
    res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new GmailIngestError(
      `token endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`,
      'transient',
    );
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new GmailIngestError(
      `Gmail token refresh failed (${res.status}): ${detail.slice(0, 200)}`,
      res.status >= 500 ? 'transient' : 'auth',
      res.status,
    );
  }
  const json = (await res.json().catch(() => null)) as { access_token?: string; expires_in?: number } | null;
  if (!json?.access_token) {
    throw new GmailIngestError('token endpoint returned no access_token', 'auth', res.status);
  }
  // Stamp last_fetched_at best-effort (mirrors lib/oauth/google.ts markFetched).
  pool
    .query(
      `UPDATE mailbox.oauth_tokens SET last_fetched_at = NOW(), updated_at = NOW()
        WHERE provider = $1 AND account_id = $2`,
      [GMAIL_INGEST_PROVIDER, accountId],
    )
    .catch(() => {});

  return {
    account_id: accountId,
    account_email: row.account_email ?? '',
    access_token: json.access_token,
    expiry_date: Date.now() + Number(json.expires_in ?? 3600) * 1000,
  };
}

// ── Server-side Gmail fetch + parse (so n8n stays a dumb loop) ────────────────
//
// The same query + per-account cap the legacy single-account n8n Gmail node used
// (is:unread in:inbox -from:me newer_than:2d) — recent unread only, so a huge
// mailbox never floods the classify/draft pipeline. maxResults is hard-capped.

const GMAIL_QUERY = 'is:unread in:inbox -from:me newer_than:2d';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const MAX_PER_ACCOUNT = 50;

// Normalized message — field names match what /api/internal/inbox-messages and
// the classify pipeline expect (formerly produced by n8n's "Extract Fields").
export interface NormalizedMessage {
  message_id: string;
  thread_id: string;
  from_addr: string;
  to_addr: string;
  subject: string;
  received_at: string;
  snippet: string;
  body: string;
  in_reply_to: string;
  references: string;
  account_id: number;
  account_email: string;
}

interface GmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
  headers?: Array<{ name: string; value: string }>;
}

function header(headers: Array<{ name: string; value: string }> | undefined, name: string): string {
  const h = headers?.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h?.value ?? '';
}

function addrFrom(headerValue: string): string {
  const m = headerValue.match(/<([^>]+)>/);
  if (m) return m[1].trim();
  const t = headerValue.trim();
  return t.includes('@') ? t : '';
}

function decodeB64Url(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf8');
}

// Prefer text/plain; fall back to a tag-stripped text/html. Walks nested parts.
function extractBody(payload: GmailPart | undefined): string {
  if (!payload) return '';
  let html = '';
  const walk = (p: GmailPart): string | null => {
    const mime = p.mimeType ?? '';
    if (mime === 'text/plain' && p.body?.data) return decodeB64Url(p.body.data);
    if (mime === 'text/html' && p.body?.data && !html) html = decodeB64Url(p.body.data);
    for (const child of p.parts ?? []) {
      const r = walk(child);
      if (r) return r;
    }
    return null;
  };
  const plain = walk(payload);
  if (plain) return plain;
  if (html) return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return '';
}

async function gmailGet(path: string, accessToken: string): Promise<unknown> {
  const res = await fetch(`${GMAIL_API}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new GmailIngestError(
      `Gmail API ${path.split('?')[0]} failed (${res.status}): ${detail.slice(0, 160)}`,
      res.status >= 500 ? 'transient' : 'auth',
      res.status,
    );
  }
  return res.json();
}

// Fetch + normalize recent-unread messages for one connected account.
async function fetchUnreadForAccount(acct: IngestAccount, limit: number): Promise<NormalizedMessage[]> {
  const { access_token } = await mintGmailAccessToken(acct.account_id);
  const list = (await gmailGet(
    `/messages?q=${encodeURIComponent(GMAIL_QUERY)}&maxResults=${limit}`,
    access_token,
  )) as { messages?: Array<{ id: string }> };
  const ids = (list.messages ?? []).map((m) => m.id);
  const out: NormalizedMessage[] = [];
  for (const id of ids) {
    const msg = (await gmailGet(`/messages/${id}?format=full`, access_token)) as {
      id: string;
      threadId: string;
      snippet?: string;
      internalDate?: string;
      payload?: GmailPart;
    };
    const h = msg.payload?.headers;
    const dateHdr = header(h, 'Date');
    // Normalize to ISO-8601 — the raw RFC-2822 Date header (e.g.
    // "Fri, 5 Jun 2026 23:11:34 +0000 (UTC)") is rejected by Postgres
    // TIMESTAMPTZ. Prefer the Date header, fall back to internalDate (epoch ms).
    const parsedDate = dateHdr
      ? new Date(dateHdr)
      : msg.internalDate
        ? new Date(Number(msg.internalDate))
        : null;
    const received_at =
      parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate.toISOString() : '';
    out.push({
      message_id: msg.id,
      thread_id: msg.threadId,
      from_addr: addrFrom(header(h, 'From')),
      to_addr: addrFrom(header(h, 'To')),
      subject: header(h, 'Subject'),
      received_at,
      snippet: (msg.snippet ?? '').slice(0, 200),
      body: extractBody(msg.payload),
      in_reply_to: header(h, 'In-Reply-To'),
      references: header(h, 'References'),
      account_id: acct.account_id,
      account_email: acct.account_email,
    });
  }
  return out;
}

export interface IngestBatchResult {
  messages: NormalizedMessage[];
  per_account: Array<{ account_id: number; account_email: string; count: number; error?: string }>;
}

// Account-agnostic batch: every connected account's recent-unread mail, flat and
// tagged, ready for n8n to insert one-by-one. One account's failure is isolated
// (reported in per_account) so a single bad grant never blocks the others.
export async function ingestBatch(limit = 25): Promise<IngestBatchResult> {
  const cap = Math.max(1, Math.min(limit, MAX_PER_ACCOUNT));
  const accounts = await listIngestAccounts();
  const messages: NormalizedMessage[] = [];
  const per_account: IngestBatchResult['per_account'] = [];
  for (const acct of accounts) {
    try {
      const msgs = await fetchUnreadForAccount(acct, cap);
      messages.push(...msgs);
      per_account.push({ account_id: acct.account_id, account_email: acct.account_email, count: msgs.length });
    } catch (err) {
      per_account.push({
        account_id: acct.account_id,
        account_email: acct.account_email,
        count: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { messages, per_account };
}
