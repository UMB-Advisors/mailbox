# Feature Research

**Domain:** Entity/organization auto-provisioning + single-source-of-truth entity picker (multi-business email appliance CRM) — **Unified Entities milestone**
**Researched:** 2026-07-11
**Confidence:** MEDIUM (patterns cross-checked against Front, HubSpot, WorkOS/Clerk docs via web search + grounded in this repo's actual schema; no vendor source was deep-crawled, so treat specifics as directional, not gospel)

> Note: this file replaces the prior milestone's FEATURES.md (product-level competitor research for the base email-agent appliance, dated 2026-04-02). That research is superseded for the current milestone; if it's needed for reference, retrieve it from git history.

## Grounding: what already exists in this codebase

Before the feature landscape, the concrete substrate this milestone builds on/around:

- `mailbox.accounts` (migration 033) — one row per connected mailbox identity: `id`, `email_address UNIQUE`, `display_label`, `is_default`, `provider` (`gmail|imap|microsoft`), `provider_config`. **No `business_id` column today** — this is the missing link the milestone must add.
- `mailbox.businesses` (migration 053) — `id`, `name UNIQUE`, `description`. Already supports "a business with no inbox" structurally (nothing requires an account to reference it).
- `mailbox.departments` — `business_id` nullable FK, `ON DELETE SET NULL`. This is the exact un-mapping pattern (FK to businesses, nullable, non-cascading) the new `accounts.business_id` should copy.
- OAuth callback (`dashboard/app/api/oauth/google/callback/route.ts`) currently only exchanges the code, saves the token, and redirects — it does **not** touch `businesses` at all. This is the exact insertion point for auto-provisioning.
- **Two parallel "entity" concepts exist today and must be reconciled per the milestone:**
  1. CRM `mailbox.businesses` (this repo, real DB rows, id-keyed) — the target source of truth.
  2. gbrain digest entity slugs — a fixed string taxonomy (`heron`, `state`, `cde`, `krunchy`, ...) hardcoded in the sidecar's `ENTITY_OPTIONS` (`agentbox-sidecar/web/src/lib/entities.ts`) and mirrored server-side in `agentbox-sidecar/src/agentbox_sidecar/features/digest.py`, itself sourced from `AGENTBOX_ENTITY_SLUGS` env or `$HERMES_HOME/entities.json` (written by the separate `agentbox-seed` org-layer repo, ultimately derived from `gbrain-ingest/entity_map.yaml`). This is a **different, older, org-config-driven axis** — not a CRM table, not owned by this repo, and not trivially mergeable in one milestone.

## Feature Landscape

### Table Stakes (Users Expect These)

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Auto-create a business when a Gmail account is authorized (default ON) | Standard "connect account → provisions a workspace" pattern (WorkOS AuthKit JIT org provisioning, Slack/Notion first-workspace-on-signup). Users expect *not* to hit a dead end after OAuth with nowhere for the account to live. | LOW | Insert into OAuth callback (`route.ts:58-69`) right after `saveToken`. Needs `accounts.business_id` column first (new migration). |
| Domain/duplicate check before auto-creating | If the operator reconnects the same email, or connects a second account on a domain that already has a business, silently creating a second "Heron Labs" business is the #1 complaint pattern in JIT-provisioning designs (WorkOS explicitly matches on verified domain before creating new). | LOW-MEDIUM | Match on `email_address` domain against existing `businesses` (needs a domain or slug field, or a join through existing accounts) before INSERT. |
| Renaming an auto-created business | Every workspace/org-auto-name pattern (Slack channel names, Notion workspaces, WorkOS orgs) treats the auto-name as a *starting point*, never final. The CRUD UI for businesses already exists — this is "make sure auto-created rows are indistinguishable from manually created ones." | LOW | Already have `PATCH /api/crm/businesses/[id]`. Just needs the auto-created row to not be special-cased/locked. |
| Adding departments to an auto-created business | Same reasoning — auto-created must be a first-class citizen, not a stub. | LOW | Already works via existing `departments` CRUD; only needs `business_id` populated. |
| Manually creating a business with no inbox | Required for holding companies / departments-only businesses (this appliance already models multi-business operators — Ekim-style holding structures are the exact use case). Front/HubSpot analog: you can create a team/inbox shell before connecting any channel. | LOW | `businesses` table already supports this — no schema change, just a "New Business" entry point independent of the OAuth flow. |
| Re-mapping an account to a different business | Operators mis-click, restructure, or want to consolidate. HubSpot models this as a distinct explicit action (Disconnect ≠ Reassign); the underlying primitive is "connection record and org record are separate, linked objects." | LOW-MEDIUM | `UPDATE accounts SET business_id = ? WHERE id = ?` + UI. No cascading side effects if `departments`/other data stays keyed by `business_id`, not `account_id`. |
| Every business/department picker reads the one CRM source | This *is* the milestone's stated core bug (`ENTITY_OPTIONS` hardcode in `agentbox-sidecar/web/src/lib/entities.ts` + `CronPage.tsx`). Table stakes because a picker showing options that don't match what's assignable elsewhere is a correctness bug, not a feature gap. | MEDIUM | Requires the sidecar to fetch from `GET /api/crm/businesses` (dashboard side, this repo) instead of importing a static array — this is a cross-repo change (sidecar lives in `UMB-Advisors/agentbox-sidecar`). |
| Un-mapping an account without deleting the business | Mirrors the `departments.business_id` `ON DELETE SET NULL` pattern already in this schema. Deleting a business because its last account was disconnected would orphan departments/team/history — a data-loss anti-pattern the HubSpot "Disconnect ≠ delete the CRM object" split explicitly avoids. | LOW | `accounts.business_id` should be nullable, `ON DELETE SET NULL` — un-mapping just nulls it; business row and its departments/team persist. |

### Differentiators (Competitive Advantage)

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Smart default name from `display_label` / domain (not just raw domain string) | `display_label` is already operator-set text (e.g. "Primary (backfilled)" per migration 033 comments) — using it when present, falling back to a Title-Cased domain-minus-TLD heuristic when absent, produces a materially better first impression than "heronlabsinc-com" as a business name. | LOW-MEDIUM | Naming precedence: `accounts.display_label` (if set and not a generic placeholder like "Primary") → derived-from-domain heuristic → generic "New Business N". Surface an inline rename nudge post-create rather than assuming the heuristic is right. |
| "Link to existing business?" suggestion instead of silent auto-create | When a newly connected account's domain matches an existing business's account domain, prompting rather than auto-creating avoids the most common duplicate-org failure mode (per general SaaS multi-tenant provisioning guidance: match on a stable attribute to an existing tenant before creating a new one). | MEDIUM | Needs a domain-derivable signal on `businesses` (a domain column, or infer from constituent accounts' email domains at check-time). |
| Business merge (combine two businesses, reparent departments/team/accounts) | Real operators will create a duplicate at some point (typo, mis-click, or before the domain-check ships) and want a way out short of manual SQL. | HIGH | Requires reparenting every FK-referencing table (`departments`, and once `accounts.business_id` exists, `accounts` too) in one transaction, plus a UI to pick which name/description "wins." Defer past MVP. |
| One-way bridge from CRM `businesses` to the gbrain digest entity axis (e.g., an optional `slug` column mapping a business to its digest `entity` filter value) | Lets the Daily Brief / digest entity filter eventually read real CRM businesses instead of the separate hardcoded slug list, without requiring a full merge of two independently-owned config systems. | MEDIUM-HIGH | This is the "reconcile" line item in requirements. A full two-way sync with `gbrain-ingest/entity_map.yaml` (owned by a different repo, `agentbox-seed`) is out of reach for one milestone — a derived, one-directional bridge (CRM business → optional digest slug) is the realistic scope. Flag for deeper phase-specific research; this is exactly the kind of cross-repo config-ownership question a roadmap phase should scope tightly. |

### Anti-Features (Commonly Requested, Often Problematic)

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Auto-delete business when its last/only account is disconnected | Feels like "cleanup" | Orphans departments, team members, and historical drafts/classification rows tied to that business via departments — a hard data-loss footgun (this is precisely the soft-delete-then-restore duplication trap called out in general multi-tenant provisioning guidance). | Un-map only (null the FK). Deletion is a separate, explicit, confirmed action on the business itself, independent of account lifecycle. |
| Silent automatic merge of businesses sharing an email domain | Seems like the "smart" thing to do given the domain-match signal above | A holding company (this operator's own Ekim Holdings / KMK Holdings structure is the live example) can legitimately run several *distinct* businesses off variants of one domain, or one business can legitimately have multiple unrelated domains. Auto-merging on a heuristic risks silently combining two real, separate entities. | Suggest-and-confirm only, never silent. Merge is always an explicit operator action (see Differentiators). |
| Full two-way sync / unification of CRM `businesses` with the gbrain `entity_map.yaml` / `AGENTBOX_ENTITY_SLUGS` config in this milestone | The requirement says "reconcile" and it's tempting to just fully replace one with the other | `entity_map.yaml` is owned and written by a separate repo (`agentbox-seed`, the "org layer"), consumed by yet another repo (the sidecar/gbrain). Rewriting that ownership boundary is a cross-repo architecture change, not a feature — doing it inside this milestone risks scope blowout and breaking a system this repo doesn't own. | Ship a one-way, additive bridge (CRM business carries an optional digest-slug reference) and leave `entity_map.yaml` as the authority for the digest axis until a dedicated cross-repo phase addresses full unification. |
| Building general multi-tenant auth boundaries (per-business RBAC, SSO, tenant isolation) à la WorkOS/Auth0 Organizations | The "organization" language in comparable products implies a full multi-tenant identity layer | This appliance has exactly one operator/admin per device (per root `CLAUDE.md`: "single admin user in v1" is an explicit non-goal elsewhere in this project). Businesses here are a *classification/filter* dimension, not a security boundary — there is no multi-user access control problem to solve. | Keep `businesses` as a plain reference table with CRUD, no auth semantics attached. |

## Feature Dependencies

```
accounts.business_id column (new migration, nullable FK ON DELETE SET NULL)
    └──requires──> mailbox.businesses table (exists, migration 053)

Auto-create business on Gmail OAuth
    └──requires──> accounts.business_id column
    └──requires──> naming heuristic (display_label → domain fallback)
    └──enhances──> Domain/duplicate check (should land in the SAME phase — shipping
                    auto-create without the duplicate check guarantees duplicate
                    businesses on every re-auth/second-account connect)

Manual business creation (no inbox)
    └──requires──> mailbox.businesses table only (already works structurally)

Re-mapping an account to a different business
    └──requires──> accounts.business_id column
    └──enhances──> Un-mapping (same UI surface, same column)

Single-source-of-truth entity pickers (Agent Jobs / CronPage, Daily Brief, Proposals, mail triage)
    └──requires──> GET /api/crm/businesses exposed and stable (exists, this repo)
    └──requires──> sidecar-side removal of ENTITY_OPTIONS hardcode (cross-repo:
                    UMB-Advisors/agentbox-sidecar)
    └──conflicts with──> leaving the digest entity slug list as a SEPARATE,
                    un-derived hardcoded list (the two pickers would show
                    different option sets to the operator — must not ship both
                    "fixed" pickers and an unreconciled digest picker in the same
                    release)

Digest entity axis reconciliation (CRM businesses <-> gbrain entity slugs)
    └──requires──> a stable business identifier the digest layer can key off
                    (e.g. an optional slug field on businesses)
    └──is a precondition for──> fully retiring AGENTBOX_ENTITY_SLUGS/entities.json
                    as a parallel source (explicitly OUT of this milestone's
                    realistic scope per Anti-Features above)

Business merge
    └──requires──> accounts.business_id AND departments.business_id both live
                    (reparents both in one transaction)
    └──is deferred past MVP (see MVP Definition)
```

### Dependency Notes

- **Auto-create requires the duplicate check in the same phase, not a later one:** shipping auto-provisioning without duplicate/domain matching guarantees the exact failure mode research flagged (WorkOS JIT provisioning explicitly checks the verified-domain match *before* creating a new org). Splitting these into separate phases would ship a known bug window.
- **Single-source pickers conflict with an unreconciled digest slug list:** if Agent Jobs/Daily Brief/Proposals all switch to reading live CRM businesses while the Daily Brief's own *entity filter* (the digest axis) still reads the old hardcoded slug list, the operator sees two different, inconsistent "business" option sets in the same dashboard. The roadmap should either bridge the digest axis in the same milestone (at least additively) or explicitly and visibly scope the digest filter out with a note, not leave it silently stale.
- **Merge is the one high-complexity item safe to defer:** nothing else in the requirements depends on merge existing; the duplicate-prevention feature (domain check at auto-create time) is what keeps merge from being needed on day one.

## MVP Definition

### Launch With (v1)

- [ ] `accounts.business_id` migration (nullable FK, `ON DELETE SET NULL`, mirroring the existing `departments.business_id` pattern) — everything else depends on this
- [ ] Auto-create business on Gmail OAuth connect, default ON, naming precedence `display_label` → domain-derived Title Case → "New Business N" fallback
- [ ] Domain-match duplicate check at auto-create time (prompt "link to existing business?" instead of silently creating a new one) — must ship alongside auto-create, not after
- [ ] Manual "New Business" creation flow independent of OAuth (no-inbox business)
- [ ] Re-map / un-map account-to-business UI (sets or nulls `business_id`)
- [ ] Agent Jobs (`CronPage` in `agentbox-sidecar`) entity picker reads `GET /api/crm/businesses` instead of `ENTITY_OPTIONS` — this is the concrete, named-in-scope bug fix
- [ ] Daily Brief and Proposals surfaces' business/department pickers wired the same way

### Add After Validation (v1.x)

- [ ] Digest entity axis bridge — additive optional slug/mapping field on `businesses` so the digest filter *can* derive from CRM data, without retiring `entity_map.yaml` as the org-layer authority yet
- [ ] Rename nudge/toast on auto-created businesses ("We created **X** from your connected account — rename it?") — trigger: operator feedback that the domain-derived name is frequently wrong
- [ ] Business merge tool — trigger: a real duplicate-business support request occurs despite the duplicate check

### Future Consideration (v2+)

- [ ] Full two-way unification of CRM businesses with `gbrain-ingest/entity_map.yaml` / `agentbox-seed` — defer until the org-layer repo ownership question is explicitly scoped as its own cross-repo initiative
- [ ] Any RBAC/multi-tenant auth semantics on top of businesses — defer indefinitely; out of scope for a single-operator appliance per project constraints

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| `accounts.business_id` migration | HIGH | LOW | P1 |
| Auto-create business on Gmail connect | HIGH | LOW | P1 |
| Domain-match duplicate check | HIGH | LOW-MEDIUM | P1 |
| Manual business creation (no inbox) | MEDIUM | LOW | P1 |
| Re-map / un-map account | HIGH | LOW-MEDIUM | P1 |
| Sidecar CronPage picker → live CRM data | HIGH | MEDIUM | P1 |
| Daily Brief / Proposals picker → live CRM data | HIGH | MEDIUM | P1 |
| Rename-on-create UX nudge | MEDIUM | LOW | P2 |
| Digest entity axis bridge (one-way) | MEDIUM | MEDIUM-HIGH | P2 |
| Business merge tool | LOW-MEDIUM | HIGH | P3 |
| Full digest/CRM two-way unification | LOW (near-term) | HIGH | P3 |

**Priority key:**
- P1: Must have for this milestone
- P2: Should have, add when possible within milestone or immediately after
- P3: Nice to have, explicitly deferred

## Competitor Feature Analysis

| Feature | Front (shared inbox SaaS) | HubSpot (CRM connected inbox) | WorkOS/Clerk (B2B auth-as-a-service) | Our Approach |
|---------|---------------------------|-------------------------------|----------------------------------------|--------------|
| Account-to-org mapping model | Inbox = organizational container; channels (email/SMS/chat) connect INTO an inbox; no separate "team inbox" object — it's a shared inbox with restricted access | Personal email connection and team/conversations-inbox connection are separate, explicitly distinct actions | Users/orgs are the core primitive; JIT-provision into an org on verified-domain match, else create new | Business = organizational container; accounts (Gmail/IMAP/Microsoft) connect INTO a business via `business_id` FK — same shape as Front's inbox model |
| Auto-provisioning on connect | Not really — inboxes are created explicitly, channels attached after | Not applicable — HubSpot orgs are seat/billing based, not per-connect | Yes — JIT org provisioning on signup/domain match is a first-class documented pattern | Yes, default ON per requirement — closest to the WorkOS JIT pattern, applied to a lighter-weight internal CRM concept |
| Disconnect vs delete | Transfer inbox to another teammate; inbox itself persists | Disconnect (personal) and Disconnect (team) are explicit, separate actions from the CRM company record | Not directly researched (no clear rename/merge/dedup docs surfaced) | Un-map (null FK) always separate from delete; delete requires explicit confirmed action on the business itself |
| Duplicate prevention | Not applicable (inboxes are manually named, not auto-created) | Not applicable | Match to existing org via verified email domain before creating new | Same domain-match-before-create approach, scaled down for a single-appliance CRM (no verified-domain infrastructure needed, just email-domain string match) |

## Sources

- [Add and use shared inboxes — Front Help](https://help.front.com/en/articles/2057)
- [Explaining Front inboxes, empty inboxes, and channels](https://help.front.com/en/articles/2137)
- [How to transfer a shared inbox to a teammate](https://help.front.com/en/articles/2182)
- [HubSpot connected inboxes — FAQ](https://knowledge.hubspot.com/connected-email/hubspot-crm-email-integration-faq)
- [Disconnect or reconnect your inbox from HubSpot](https://knowledge.hubspot.com/connected-email/disconnect-your-inbox-from-hubspot)
- [Users and Organizations — AuthKit — WorkOS Docs](https://workos.com/docs/authkit/users-organizations)
- [Configure Organization settings in Clerk Dashboard](https://clerk.com/docs/guides/organizations/configure)
- [Create and manage Organizations with Clerk](https://clerk.com/docs/guides/organizations/create-and-manage)
- Repo grounding (not web sources, read directly): `dashboard/migrations/033-add-account-id-multi-account-v1-2026-05-28.sql`, `dashboard/migrations/052-create-crm-tables-v1-2026-06-04.sql`, `dashboard/migrations/053-crm-businesses-v1-2026-06-05.sql`, `dashboard/app/api/oauth/google/callback/route.ts`, `agentbox-sidecar/web/src/lib/entities.ts`, `agentbox-sidecar/src/agentbox_sidecar/features/digest.py`

---
*Feature research for: Unified Entities milestone (AgentBOX fork) — entity auto-provisioning + single-source-of-truth CRM entity model*
*Researched: 2026-07-11*
