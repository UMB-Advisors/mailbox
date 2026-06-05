# Spec — Google Single-Source-of-Truth → MailBOX Integration

**Version:** v0.1.0 · **Date:** 2026-06-05 · **Status:** DRAFT (foundation landed; ingestion fork pending decision)
**Owner ask (Dustin, 2026-06-05):** *one* place to connect Google accounts, consumed by MailBOX
routing/ingestion (Incoming Messages) **and** the dashboard daily brief **and** every other surface.

---

## TL;DR

The Hermes **dashboard** already owns Google connection (multi-account OAuth, Settings → Google) and
writes the single source of truth: `$HERMES_HOME/google_accounts/<email>.json` (one `authorized_user`
token per account). MailBOX has its own credential stores and a *separate* email pipeline, which is why
connecting `dustin@umbadvisors.com` + `consultingfutures@gmail.com` did nothing to Incoming Messages.

**Approach A (chosen):** the dashboard files are the SoT; MailBOX *consumes* them. This spec lands the
safe, automatable foundation and isolates the one irreducible manual step the V1 n8n topology forces.

---

## Topology reality (must read)

| Thing | Where it lives |
|---|---|
| SoT token files `~/.hermes/google_accounts/<email>.json` | **dashboard box** (kiosk / mailbox2) |
| MailBOX appliance (Next.js :3001, Postgres, n8n, Qdrant — Docker) | **appliance box** (mailbox1) |
| Gmail **ingestion** | n8n workflow `MailBOX.json`, polls every 5 min with a per-node `gmailOAuth2` credential |
| `mailbox.accounts`, `mailbox.oauth_tokens` | appliance Postgres |

So the SoT and the appliance are on **different boxes**. The SoT files must be made reachable from the
appliance box (tailnet copy or mount) for any consumer there to read them. See `HERMES_GOOGLE_ACCOUNTS_DIR`.

---

## What landed in this branch (safe, no live mutation)

| Piece | File | Behavior |
|---|---|---|
| SoT → appliance provisioner | `dashboard/scripts/sync-google-accounts-from-hermes.ts` (`npm run google:sync-accounts`) | Reads the SoT dir; **upserts** `mailbox.accounts` (one row per connected account, never touches `is_default`); **stores** each account's Gmail refresh token in `mailbox.oauth_tokens(provider='google_gmail', account_id)` AES-256-GCM-encrypted. Idempotent. `DRY_RUN=1` previews. Does **not** touch n8n. |

This makes the appliance DB a faithful, re-runnable reflection of the dashboard SoT: account rows exist
(required by migration 033 for any per-account mail to land) and the ingestion grant is present in-DB.

---

## The fork that still needs a decision — getting creds into ingestion

n8n binds a Gmail credential **per node** (runbook-multi-account-ingestion §"Adding a second mailbox").
That forces a per-account Gmail-Get → Insert-Inbox branch wired **in the n8n editor** + Publish + restart.
Editing `workflow_entity` in SQL does not reach runtime for webhook workflows. So the *workflow topology*
change is irreducibly manual. The only question is how the **credential** gets created:

| Option | Cred source | Manual residue | Notes |
|---|---|---|---|
| **A1 (recommended next)** | Provision n8n `gmailOAuth2` credentials via the **n8n REST API** from the `google_gmail` refresh tokens this script stored | Per-account *branch wiring* only (no re-consent) | Honors SoT end-to-end for creds; n8n still owns the node wiring. Needs n8n API key + the GCP client id/secret. |
| A2 (runbook default) | Operator re-authorizes each account in the n8n editor (OAuth consent) | Consent **and** branch wiring | No code; matches the current runbook; ignores the SoT (re-consents). |
| A3 (biggest) | Replace the n8n Gmail node with HTTP-Request ingestion driven by `mailbox.oauth_tokens(google_gmail)` | None in n8n editor | True SoT, no credential duplication, but rewrites the ingestion path — a V-next architecture decision that touches the live poll loop. Out of scope for V1. |

**Recommendation:** ship the foundation (this branch) → do **A1** (an n8n-credential provisioner that reads
the `google_gmail` tokens and POSTs them to the n8n credentials API) → operator does the one-time per-account
branch wiring → verify. Defer A3 to a deliberate ingestion-rearchitecture.

This also keeps the **brief** correct: it already reads the same SoT files directly (google_brief.py), so the
SoT genuinely feeds both surfaces; the appliance reflection is purely for ingestion.

---

## On-box run sequence (when approved — appliance box / mailbox1)

```bash
# 0. Make the SoT reachable on the appliance box (tailnet copy of the dashboard's dir)
#    e.g. rsync dashboard-box:~/.hermes/google_accounts/ /srv/hermes-google-accounts/

# 1. Preview, then apply the SoT -> appliance DB sync (inside the dashboard container)
docker exec -e DRY_RUN=1 -e HERMES_GOOGLE_ACCOUNTS_DIR=/srv/hermes-google-accounts \
  mailbox-dashboard npm run -s google:sync-accounts
docker exec -e HERMES_GOOGLE_ACCOUNTS_DIR=/srv/hermes-google-accounts \
  mailbox-dashboard npm run -s google:sync-accounts

# 2. (A1) provision n8n gmailOAuth2 creds from the stored tokens  [TBD — pending fork decision]
# 3. n8n editor: add per-account Gmail-Get -> Insert-Inbox(account_email) branch, Publish, restart n8n
# 4. Verify
docker compose --profile n8n-verify run --rm mailbox-n8n-verify
docker exec mailbox-postgres psql -U mailbox -c \
  "SELECT id,email_address,is_default FROM mailbox.accounts ORDER BY id;"
```

## Acceptance

- [ ] `mailbox.accounts` has rows for umbadvisors + consultingfutures (non-default)
- [ ] `mailbox.oauth_tokens(google_gmail, account_id)` present + decryptable for each
- [ ] per-account ingest branch active; their mail lands in `inbox_messages` tagged with their `account_id`
- [ ] no regression to the heronlabs default-account flow
- [ ] brief + Incoming Messages both reflect the same connected-accounts set

---

## v0.2 — DECIDED: account-agnostic loop (connect-and-go onboarding)

The per-account n8n wiring (A1/A2) is too much for client onboarding. **Decision: ingestion is
account-agnostic** — n8n stops using per-account `gmailOAuth2` nodes and instead loops over whatever
accounts are connected, fetching short-lived tokens from the dashboard. Onboarding a client becomes:
**connect the Google account in the dashboard → done.** No n8n edit per account, ever.

**Built (committed, branch `feat/google-sot-mailbox-provisioner`):**
- `dashboard/lib/oauth/gmail-ingest.ts` — `listIngestAccounts()` + `mintGmailAccessToken(accountId)`
  (reads `oauth_tokens(google_gmail)`, refreshes with the dashboard OAuth client).
- `GET /api/internal/gmail/accounts` → connected mailboxes.
- `GET /api/internal/gmail/token?account_id=` → fresh Gmail access token.

**n8n topology (ONE-TIME, baked into the workflow template — not per client):**
```
Schedule (5 min) → cooldown/bootstrap gates
  → HTTP GET /api/internal/gmail/accounts
    → Loop Over Items (one item per connected account)
        → HTTP GET /api/internal/gmail/token?account_id={{id}}
        → HTTP GET Gmail API messages.list/get  (Bearer {{access_token}})
        → POST /api/internal/inbox-messages  (account_email = {{account_email}})
        → (existing) Classify → Draft
```
One Gmail-Get path, account from data — exactly what the per-node `gmailOAuth2` model couldn't do, now
possible because the token comes from the dashboard endpoint, not an n8n credential.

**One-time setup to go live (then zero per-client work):**
1. Deploy the dashboard image carrying the new endpoints to the appliance (normal `git pull && docker
   compose up -d --build`, via PR→merge).
2. Set `GOOGLE_DASHBOARD_CLIENT_ID` / `GOOGLE_DASHBOARD_CLIENT_SECRET` on the appliance (the dashboard's
   Google *Web* client that minted the SoT tokens) so they can be refreshed.
3. Rebuild the MailBOX ingestion workflow into the loop above (once), Publish, restart n8n, verify.
4. (Cleanup) the per-account `gmailOAuth2` creds created in the A1 spike ("Gmail account — consulting/
   — umbadvisors") are now unused under the loop — safe to delete.

**SoT transport still needed** dashboard-box → appliance-box so the appliance has each account's token
(today: `scripts/sync-google-accounts-from-hermes.ts`; productized: the connect flow pushes on connect).

## Open decisions

1. **SoT transport** dashboard-box → appliance-box: rsync-on-a-timer vs mount vs push-on-connect.
2. **Per-account send routing** (`MailBOX-Send`) — make it account-agnostic the same way (token endpoint)
   rather than per-node, in the same pass.
