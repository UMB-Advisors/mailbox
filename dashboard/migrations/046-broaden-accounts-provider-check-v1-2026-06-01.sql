-- Migration 046 — AgentBOX Unified Inbox Phase 2: broaden accounts.provider so a
--       single `mailbox.accounts` row can represent a social/chat identity, not
--       only a mail transport — see HermesBOX/docs/unified-inbox CONTEXT Phase 2.
-- WHAT: (1) widen the auto-named `accounts_provider_check` CHECK to allow a single
--       inert `'social'` sentinel in addition to the existing mail transports, and
--       (2) make `accounts.email_address` NULLABLE so a social account (which has no
--       email) can be created and resolved by `account_id`. The UNIQUE on
--       email_address is preserved — Postgres permits multiple NULLs under a UNIQUE
--       constraint, so email accounts stay uniquely keyed while social rows carry NULL.
-- WHY:  Phase 2 D3/D5 (hybrid ingest, reuse-first): the locked single writer
--       (`/api/internal/inbox-messages`, STAQPRO-135) resolves the target mailbox
--       via `resolveIngestAccountId`. Social inbound resolves by explicit
--       `account_id`, which needs an `accounts` row whose provider passes the CHECK
--       and which does NOT require a synthetic unique email_address.
-- WHY 'social' (NOT the full channel set): `provider` (mail transport, consumed by
--       providerForKind() in lib/mail/providers) is a DIFFERENT axis from `channel`
--       (unified-inbox channel, migration 045). The actual channel lives in
--       accounts.channel (045); `provider` stays a small CLOSED mail-transport set so
--       the unchecked `row.provider as MailProviderKind` casts in queries-accounts.ts
--       (getAccountProviderById / getDraftProviderContext) remain trivially
--       defensible (a future `if (!MAIL_PROVIDERS.includes(p)) return null` guard).
--       A single inert sentinel keeps social rows legal without conflating the two
--       axes. The ingest path drives normalization off `provider` (DEFAULT 'gmail'
--       when omitted); the social payload omits `provider` AND the route
--       short-circuits normalization when channel != 'email', so 'social' is never
--       routed into the MailProvider factory. This CHECK only governs what DB values
--       are LEGAL for stored social account rows.
-- ADDITIVE + IDEMPOTENT: DROP CONSTRAINT IF EXISTS then ADD CONSTRAINT with the
--       broadened set (mirrors the named-idempotent idiom of the 045 channel
--       CHECKs). The 037 inline/unnamed CHECK is auto-named `accounts_provider_check`
--       (column-level convention <table>_<column>_check) so the DROP IF EXISTS hits
--       it. All existing provider values (gmail|imap|microsoft) remain valid; no
--       drops, no renames, no data migration. The running Gmail/IMAP path is
--       unaffected. The runner wraps this file in its own transaction (no BEGIN/
--       COMMIT here).
-- ROLLBACK:
--   ALTER TABLE mailbox.accounts ALTER COLUMN email_address SET NOT NULL;
--   ALTER TABLE mailbox.accounts DROP CONSTRAINT IF EXISTS accounts_provider_check;
--   ALTER TABLE mailbox.accounts ADD CONSTRAINT accounts_provider_check
--     CHECK (provider IN ('gmail', 'imap', 'microsoft'));
--   -- (SET NOT NULL only succeeds if no social rows with NULL email_address exist.)

-- (1) Broaden the provider domain to the email transports PLUS a single inert
--     'social' sentinel. Idempotent re-add so the set can be widened again later
--     without failing. Keeps provider a small closed mail-transport set (the actual
--     channel lives in accounts.channel, migration 045).
ALTER TABLE mailbox.accounts DROP CONSTRAINT IF EXISTS accounts_provider_check;
ALTER TABLE mailbox.accounts ADD CONSTRAINT accounts_provider_check
  CHECK (provider IN ('gmail','imap','microsoft','social'));

-- (2) Social accounts have no email. Relax NOT NULL so they can be created and
--     resolved by account_id; keep the existing UNIQUE (multiple NULLs allowed).
ALTER TABLE mailbox.accounts ALTER COLUMN email_address DROP NOT NULL;
