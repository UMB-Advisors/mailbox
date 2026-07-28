# Phase 5: Backend Data Model & Auto-Create - Discussion Log

**Date:** 2026-07-28
**Participants:** Mike, Claude

> Human-reference record of the discussion. Not consumed by downstream agents —
> `05-CONTEXT.md` is the canonical output.

## Pre-discussion codebase scout

A read-only explorer agent mapped the account-creation and CRM code paths before any
questions were asked. Two findings materially changed the framing:

1. **No single account-creation choke point.** Three independent `.insertInto('accounts')`
   sites in `dashboard/lib/queries-accounts.ts`, plus a sentinel-adoption UPDATE branch on
   the IMAP/Microsoft paths. Google's OAuth callback creates nothing — it only attaches
   tokens. This resolved the ROADMAP-flagged research disagreement in favor of the
   ARCHITECTURE recommendation (hook the query layer), and added a requirement neither
   research pass caught (cover the adopt-UPDATE branch, not just INSERT).
2. **The hardcoded entity list is another company's.** `ENTITY_OPTIONS` in the sidecar is
   Heron Labs' customer roster; the one live cron-job slug on `agentbox3` is `altitude`,
   which isn't even in that list. FILT-05's back-compat scope collapsed from "11 slugs +
   file-aware rewrite with rollback" to "seed one row."

Live data pulled from `agentbox3` to make the questions concrete: 6 accounts, 3 businesses,
1 department, 4 cron jobs (1 with a business slug).

## Areas Discussed

### Area 1: Domain-match aggressiveness

**Options presented:** skip free-mail domains / domain-match everything / custom domains only
with personal skipped entirely.

**Selected:** Skip free-mail domains (recommended).

**Notes:** All 6 live accounts sit on custom domains, so the rule is invisible today — it
exists to stop a future personal gmail.com inbox from claiming the domain and silently
swallowing every later personal inbox. Accounts on free-mail domains still get a business,
named from `display_label`; they just never domain-match into an existing one.
→ D-07.

### Area 2: Backfill of the 3 unlinked accounts

**Options presented:** create the 3 missing businesses / link exact matches only / create
them but tag with an "auto-created" description.

**Selected:** Create the 3 missing (recommended).

**Notes:** Live state was 6 accounts against 3 businesses — Jiffy Auto Glass, Elevated
Advisory, and Bonvillian Design had no business row. Linking matches only would have left a
third of the accounts outside every entity filter the moment Phase 7 shipped, which defeats
the milestone goal. Decided the backfill reuses the runtime resolution rule rather than a
hand-written mapping table, so the backfill doubles as a live exercise of the hook logic.
→ D-09, D-10.

### Area 3: Slug behavior on rename

**Options presented:** frozen at creation / regenerate and rewrite references / frozen but
separately editable.

**Selected:** Frozen at creation (recommended).

**Notes:** Renaming becomes display-only, so no cron job or digest reference can be orphaned
by a rename. Accepted trade-off: a renamed business keeps its original slug internally.
Rejected the rewrite option because it turns every rename into a file mutation with rollback
against `jobs.json` — more moving parts than the problem justifies at 4 total jobs. No
slug-edit affordance in this phase; noted as a possible Phase 6 addition.
→ D-12, D-13.

### Area 4: Legacy slug seeding

**Options presented:** seed only what's live / seed live plus reserved sentinels / seed all 11
as businesses.

**Selected:** Seed only what's live (recommended).

**Notes:** Seed `altitude` onto the existing Altitude Guitar business; ignore the 11 Heron
slugs, which are not Mike's companies and die with `ENTITY_OPTIONS` in Phase 7. Seeding all
11 would have polluted the CRM with 10 businesses belonging to a different company.
→ D-14, D-15.

## Claude's Discretion

- Migration split (single vs. multiple files).
- Whether `slug` lands NOT NULL immediately or after backfill.
- Helper and constant naming.
- Test layout, within the existing `dbDescribe` idiom.

## Deferred Ideas

- Full business merge — out of scope for all of M5.
- Two-way gbrain ↔ CRM sync — M5 is one-way only.
- Connect-time "attach or create" prompt — rejected at milestone level (ENT-05).
- Per-business department uniqueness — `departments.name` is globally UNIQUE; will bite
  Phase 6 if departments are ever auto-created. Flagged, not fixed.
- Editable slugs — possible Phase 6 addition if freezing proves painful.

## Process Note

The formal "which areas do you want to discuss?" selection step was skipped. The codebase
scout had already narrowed the field to exactly four decisions with concrete live data behind
each, so they were presented directly as a single batched question set with recommendations.
All four recommendations were accepted.
