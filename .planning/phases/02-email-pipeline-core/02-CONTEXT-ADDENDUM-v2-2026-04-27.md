---
phase: 2
addendum: v2-pivot
created: 2026-04-27
references: 02-CONTEXT.md (v1 decisions D-01..D-24)
---

# Phase 2 Context Addendum — Architectural Pivot Decisions

This addendum captures decisions that emerged during the 2026-04-27
re-scoping of Phase 2 plans against the Next.js + n8n architecture
adopted in the ADR (`.planning/STATE.md` "Architectural Decision
Record: Dashboard Stack Pivot").

Decisions D-01..D-24 in `02-CONTEXT.md` remain in force unless
explicitly superseded here. Decisions below are numbered D-25 onward
and are referenced from the v2 stub plans
(`02-03..08-*-PLAN-v2-2026-04-27-STUB.md`).

---

## Cross-Plan Architectural Decisions

### D-25 — Threading header storage

**Plan:** 02-03 (IMAP ingestion)

`mailbox.inbox_messages` (kept as canonical from Phase 1 sub-project,
per 02-02-v2) does not yet carry `in_reply_to` or `references`
headers. Required by FR-MAIL-04 for SMTP reply threading.

**Decision:** ALTER TABLE inbox_messages ADD COLUMN in_reply_to TEXT,
references TEXT via a new forward migration (likely 009). Mirrors the
columns already added to `mailbox.drafts` in 02-02-v2 migration 003.

Rejected: separate `headers JSONB` column (more flexible but harder
to query); storing on `drafts` only (couples ingestion to drafts).

### D-26 — n8n → Postgres write path

**Plan:** 02-03 (IMAP ingestion); pattern applies to all n8n workflow
writes throughout Phase 2.

**Decision:** n8n Postgres node directly INSERTs to `mailbox.*`
tables for high-frequency append-only writes (`inbox_messages`,
`classification_log`). Reserve Next.js API route writes for
state-mutating operations that need cross-table consistency or
trigger downstream effects (already shipped as `app/api/drafts/*` for
approve/reject/edit/retry).

n8n holds Postgres credentials in its encrypted credential store. No
plaintext credentials in workflow JSON files committed to git.

Rejected: routing all writes through Next.js (adds network hop and
auth surface for high-frequency ingestion).

### D-27 — IMAP credentials entry UX

**Plan:** 02-08 (onboarding wizard)

n8n stores Gmail OAuth2 / IMAP credentials in its encrypted store.
The UX for *entering* those credentials is the open question.

**Decision:** Defer to 02-08-v2 stub. The credentials-by-name pattern
in n8n is unchanged from v1; 02-03 reads them by name. 02-08 will
specify whether the operator enters them via dashboard wizard
(automated, requires n8n REST API integration) or manually via SSH
during white-glove onboarding (less automated, more reliable).

### D-28 — Watchdog failure notification

**Plan:** 02-03 (IMAP watchdog)

v1 specified emailing the operator after 2 consecutive watchdog
restart failures. Email path uses customer SMTP — the same account
being watched, creating a circular dependency if SMTP itself is dead.

**Decision (Phase 2):** Skip operator email entirely. Surface
watchdog failures only on the dashboard status page (Phase 4
deliverable). Watchdog continues to log failures to Postgres for
audit.

**Decision (deferred to Phase 3):** Add operator notification with
the auto-send/notifications work (NOTF-01, NOTF-02) — at that point
notification infrastructure exists and the circular dependency can
be addressed properly (e.g. via a separate transactional SMTP
provider or webhook).

Rejected: adding a third-party transactional SMTP dependency in
Phase 2 just for watchdog alerts.

---

## Format

Each new decision adds a `### D-NN — Title` section above this line,
with at minimum:

- **Plan:** which v2 stub raised it
- A 1-3 paragraph explanation
- The decision in **bold** below
- "Rejected:" line(s) for alternatives that were considered

When a stub gets promoted to a full v2 plan, the cross-references in
that plan should cite both `02-CONTEXT.md` (D-01..D-24) and this
addendum (D-25+).
