// Sync the dashboard "single source of truth" Google accounts into the MailBOX
// appliance (approach A — the Hermes dashboard owns Google connection; MailBOX
// consumes it).
//
// CONTEXT
// The Hermes dashboard (a SEPARATE app, runs on the kiosk box) lets the operator
// connect several Google accounts once, writing one token file per account to its
// single source of truth:
//
//     $HERMES_HOME/google_accounts/<email>.json   (google-auth "authorized_user"
//                                                   shape: client_id, client_secret,
//                                                   refresh_token, scopes, …)
//
// MailBOX has its OWN credential stores (mailbox.oauth_tokens, and n8n's internal
// credential store for Gmail ingestion). This script reflects the dashboard SoT
// into the appliance DB so MailBOX never re-asks for consent:
//
//   1. UPSERT one mailbox.accounts row per connected account (email + label).
//      Required before any per-account ingestion can land mail (migration 033).
//   2. STORE each account's Gmail refresh token in mailbox.oauth_tokens under a
//      new provider 'google_gmail', keyed (provider, account_id), encrypted at
//      rest with the existing AES-256-GCM helper. This is the appliance-side
//      reflection of the SoT that the n8n credential provisioner / a future
//      native ingest reads — it does NOT itself start ingestion.
//
// WHAT THIS DOES NOT DO (see docs/spec-google-sot-mailbox-integration-v0_1):
//   * It does not touch n8n. n8n binds a Gmail credential per node, so each
//     account still needs (a) its own gmailOAuth2 credential and (b) a
//     per-account Gmail-Get -> Insert-Inbox(account_email) branch wired in the
//     n8n editor (runbook-multi-account-ingestion §"Adding a second mailbox").
//     Those are the irreducible manual steps under the V1 n8n topology; this
//     script automates everything up to them.
//   * It never sets is_default — the migration-033 seed owns the default account.
//
// CROSS-BOX NOTE: the SoT files live on the dashboard box, not the appliance box.
// Point HERMES_GOOGLE_ACCOUNTS_DIR at a directory reachable from where this runs
// (a tailnet copy / mount). Defaults to $HERMES_HOME/google_accounts then
// ~/.hermes/google_accounts for a co-located/dev run.
//
// IDEMPOTENT. Re-running reconciles labels + rotates tokens; it never duplicates.
//
// USAGE
//   DRY_RUN=1 npx tsx scripts/sync-google-accounts-from-hermes.ts   # preview
//   npx tsx scripts/sync-google-accounts-from-hermes.ts             # apply
//
// ENV
//   POSTGRES_URL                 (lib/db) — appliance DB
//   MAILBOX_OAUTH_TOKEN_KEY      32-byte hex — AES key (lib/oauth/google.ts)
//   HERMES_GOOGLE_ACCOUNTS_DIR   override for the SoT directory
//   HERMES_HOME                  fallback base ($HERMES_HOME/google_accounts)
//   DRY_RUN=1                    preview without writing

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getPool } from '@/lib/db';
import { encryptToken } from '@/lib/oauth/google';

const DRY_RUN = process.env.DRY_RUN === '1';

// The provider key for an account's Gmail ingestion grant. Distinct from the
// calendar/tasks/drive providers in lib/oauth/google.ts (those are single-account
// pre-reads); 'google_gmail' is per-account, keyed by account_id.
const GMAIL_PROVIDER = 'google_gmail';
const GMAIL_INGEST_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

interface SotAccount {
  email: string;
  refreshToken: string;
  scope: string;
}

function sotDir(): string {
  const explicit = process.env.HERMES_GOOGLE_ACCOUNTS_DIR?.trim();
  if (explicit) return explicit;
  const home = process.env.HERMES_HOME?.trim();
  if (home) return join(home, 'google_accounts');
  return join(homedir(), '.hermes', 'google_accounts');
}

// Read the dashboard SoT directory into normalized accounts. The connected email
// is the filename (the dashboard writes google_accounts/<email>.json); the
// refresh token + granted scopes come from the authorized_user JSON inside.
function readSot(dir: string): SotAccount[] {
  if (!existsSync(dir)) {
    throw new Error(
      `SoT directory not found: ${dir}\n` +
        `Set HERMES_GOOGLE_ACCOUNTS_DIR to the dashboard's google_accounts dir ` +
        `(it lives on the dashboard box — copy/mount it where this runs).`,
    );
  }
  const out: SotAccount[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const email = name.slice(0, -'.json'.length).trim().toLowerCase();
    if (!email.includes('@')) continue; // skip non-account files
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<string, unknown>;
    } catch (err) {
      console.warn(`  ! skipping ${name}: unreadable JSON (${(err as Error).message})`);
      continue;
    }
    const refreshToken = typeof raw.refresh_token === 'string' ? raw.refresh_token : '';
    if (!refreshToken) {
      console.warn(`  ! skipping ${email}: no refresh_token in token file`);
      continue;
    }
    const scope = Array.isArray(raw.scopes)
      ? (raw.scopes as unknown[]).filter((s) => typeof s === 'string').join(' ')
      : typeof raw.scope === 'string'
        ? raw.scope
        : GMAIL_INGEST_SCOPE;
    out.push({ email, refreshToken, scope });
  }
  return out;
}

async function main(): Promise<void> {
  const dir = sotDir();
  console.log(`SoT directory: ${dir}`);
  console.log(DRY_RUN ? 'MODE: DRY RUN (no writes)\n' : 'MODE: APPLY\n');

  const accounts = readSot(dir);
  if (accounts.length === 0) {
    console.log('No connected accounts found in the SoT directory. Nothing to do.');
    return;
  }
  console.log(`Found ${accounts.length} connected account(s): ${accounts.map((a) => a.email).join(', ')}\n`);

  const pool = getPool();
  let upsertedAccounts = 0;
  let upsertedTokens = 0;

  for (const acct of accounts) {
    // 1. Resolve/create the account row (never touches is_default).
    const existing = await pool.query<{ id: number; is_default: boolean }>(
      'SELECT id, is_default FROM mailbox.accounts WHERE lower(email_address) = $1',
      [acct.email],
    );
    let accountId = existing.rows[0]?.id;
    const tag = existing.rows[0]
      ? existing.rows[0].is_default
        ? '(existing, default)'
        : '(existing)'
      : '(new)';

    if (!accountId) {
      if (DRY_RUN) {
        console.log(`  + would create account: ${acct.email}`);
      } else {
        const ins = await pool.query<{ id: number }>(
          `INSERT INTO mailbox.accounts (email_address, display_label, is_default)
           VALUES ($1, $2, false)
           RETURNING id`,
          [acct.email, acct.email],
        );
        accountId = ins.rows[0].id;
        console.log(`  + created account ${accountId}: ${acct.email}`);
      }
      upsertedAccounts++;
    } else {
      console.log(`  = account ${accountId}: ${acct.email} ${tag}`);
    }

    // 2. Reflect the Gmail refresh token into mailbox.oauth_tokens(google_gmail).
    if (DRY_RUN) {
      console.log(`      would store ${GMAIL_PROVIDER} token (scope: ${acct.scope.split(' ').length} scopes)`);
      upsertedTokens++;
      continue;
    }
    if (accountId === undefined) continue; // unreachable in apply mode
    const enc = encryptToken(acct.refreshToken);
    await pool.query(
      `INSERT INTO mailbox.oauth_tokens
         (provider, account_id, refresh_token_enc, scope, account_email, connected_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
       ON CONFLICT (provider, account_id) DO UPDATE
         SET refresh_token_enc = EXCLUDED.refresh_token_enc,
             scope = EXCLUDED.scope,
             account_email = EXCLUDED.account_email,
             updated_at = NOW()`,
      [GMAIL_PROVIDER, accountId, enc, acct.scope, acct.email],
    );
    console.log(`      stored ${GMAIL_PROVIDER} token for account ${accountId}`);
    upsertedTokens++;
  }

  console.log(
    `\n${DRY_RUN ? 'Would upsert' : 'Upserted'} ${upsertedAccounts} new account row(s); ` +
      `${DRY_RUN ? 'would store' : 'stored'} ${upsertedTokens} Gmail token(s).`,
  );
  console.log(
    '\nNEXT (manual, per runbook-multi-account-ingestion §"Adding a second mailbox"):\n' +
      '  For each NON-default account, in the n8n editor:\n' +
      '   1. create its own gmailOAuth2 credential (or provision via the n8n API\n' +
      '      from the token just stored — see the spec), and\n' +
      '   2. add a serial Gmail-Get -> Insert-Inbox branch that sets\n' +
      '      account_email = <that account>, then Publish + restart n8n.\n' +
      '  Verify: docker compose --profile n8n-verify run --rm mailbox-n8n-verify',
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.stack : err);
    process.exit(1);
  });
