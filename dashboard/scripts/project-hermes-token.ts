// dashboard/scripts/project-hermes-token.ts
//
// AgentBOX mailbox Phase 1 — project a hermes-minted Google refresh token into
// mailbox.oauth_tokens so the dashboard's NATIVE Gmail code path (lib/oauth/
// google.getAccessToken) can mint access tokens for a SECOND account without
// re-running the consent flow.
//
// The 6 mailboxes were OAuth-connected by the hermes sidecar; their grants live
// at ~/.hermes/google_accounts/<email>.json (refresh_token, scopes, client_id/
// secret, token_uri) and were minted from the SAME GCP OAuth client as the
// dashboard's GOOGLE_OAUTH_CLIENT_ID. This script reads ONE such file and calls
// the dashboard's own saveToken(...) so the AES-256-GCM encryption + the
// (provider, account_id) row shape match exactly what getAccessToken/
// getRefreshToken expect.
//
// SAFETY: this only WRITES an oauth_tokens row (READ-ONLY gmail.readonly intent
// at use-time — the stored grant carries broader scope, see note below). It
// sends no mail and creates no drafts.
//
// Invocation (via the migrate profile, host token passed in env):
//   HERMES_REFRESH_TOKEN=... HERMES_SCOPES=... npx tsx \
//     scripts/project-hermes-token.ts owner@example.com
//
// The hermes JSON lives on the HOST (not in the container), so the caller reads
// refresh_token + scopes on the host and passes them via env. The account_id is
// resolved from mailbox.accounts by email_address.

import { saveToken } from '@/lib/oauth/google';
import { resolveIngestAccountId } from '@/lib/queries-accounts';

async function main() {
  const email = process.argv[2]?.trim();
  if (!email) {
    console.error('usage: tsx scripts/project-hermes-token.ts <account_email>');
    process.exit(1);
  }

  const refreshToken = process.env.HERMES_REFRESH_TOKEN?.trim();
  if (!refreshToken) {
    console.error('HERMES_REFRESH_TOKEN env not set (read it from the host hermes JSON)');
    process.exit(1);
  }

  // Space-delimited scope string. getAccessToken's scope-guard requires the
  // stored scope to COVER gmail.readonly (PROVIDER_SCOPE.google_gmail); the
  // hermes grant includes it among its broader scopes. We persist the full
  // scope list so scopeCovers() finds gmail.readonly and the guard passes.
  const scopes = process.env.HERMES_SCOPES?.trim();
  if (!scopes) {
    console.error('HERMES_SCOPES env not set (space-delimited scope list from the host hermes JSON)');
    process.exit(1);
  }
  if (!scopes.split(/\s+/).includes('https://www.googleapis.com/auth/gmail.readonly')) {
    console.error('refusing to project: hermes grant does not include gmail.readonly');
    process.exit(1);
  }

  const acct = await resolveIngestAccountId({ account_email: email });
  if (!acct.ok) {
    console.error(`could not resolve account for ${email}: ${acct.reason}`);
    process.exit(1);
  }

  await saveToken({
    provider: 'google_gmail',
    refreshToken,
    scope: scopes,
    accountEmail: email,
    accountId: acct.account_id,
  });

  console.log(
    JSON.stringify({
      ok: true,
      provider: 'google_gmail',
      account_email: email,
      account_id: acct.account_id,
      scope_count: scopes.split(/\s+/).length,
    }),
  );
  process.exit(0);
}

main().catch((err) => {
  console.error('project-hermes-token failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
