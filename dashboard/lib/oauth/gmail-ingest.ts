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
