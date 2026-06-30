# Triage classification brain (Spec 002)

The "classification brain" is the layer that decides **what an inbound email is**
and **whether it is worth drafting a reply to**. It widens the classifier's
taxonomy to real-world buckets, makes routing **trainable** (per-sender rules +
few-shot exemplars), promotes genuinely urgent automated alerts, and gates
reply-drafting so only reply-worthy mail ever produces a draft.

Everything here is **additive and reversible**: new tables/columns and new pure
library code only. Nothing in this change sends mail, auto-approves a draft, or
touches the n8n workflows.

## What it does

### 1. Full taxonomy (FR1/FR2) — migration 048
The live classifier only emitted 8 coarse categories with no marketing /
notification / finance distinction, which caused real mis-sorts (a marketing
blast read as a client request; a "payroll ran" alert read as an escalation).
Migration 048 **additively widens** the category `CHECK` constraint on every
enforcing table to the union of the 8 legacy values and the full design taxonomy
(23 values total: `client_request`, `proposal_request`, `sales_lead`,
`meeting_invite`, `meeting_notes`, `receipt`, `marketplace_notification`,
`marketing_promo`, `vendor_partner`, `finance_legal`, `admin_account`,
`invoice_payable`, `contract_legal`, `notification`, `spam`, …).

The 8 coarse values stay **valid**, so historical rows are untouched — old mail
is display-mapped to the new buckets, never re-classified. `prompt.ts` CATEGORIES
and `types.ts` `ClassificationCategory` are kept in lockstep with the constraint
by `test/schema-invariants.test.ts`.

### 2. Trainable routing (FR7) — migrations 049 + 050
Two mechanisms let an operator correct the classifier without code changes:

- **Sender rules** (`mailbox.sender_rules`, migration 049) map a sender (exact
  email or whole domain) to a target bucket in one of two modes:
  - **`bias`** (the default, safe path) — a strong **prior** the classifier still
    reconciles. Feeds a prompt hint; message content can override. Used for
    **multi-intent** senders (clients, colleagues, marketplaces).
  - **`force`** (narrow, opt-in) — a hard pre-LLM route, allowed **only** for
    single-purpose automated senders that emit exactly one type
    (e.g. a meeting-notes bot → `meeting_notes`, payroll → `notification`).

  The apply lib (`lib/classification/sender-rules.ts`) is account-scoped,
  fail-open, and kill-switchable (`SENDER_RULES_DISABLE=1`). Generic,
  universally-useful defaults are seeded by `scripts/seed-sender-rules.ts`
  (meeting-notes bot, payroll, password/account notices, common marketing
  domains); org-specific rules are left as a commented example for each
  deployment to fill in.

- **Few-shot exemplars** (`mailbox.classification_exemplars`, migration 050) store
  labeled `(snippet → bucket)` examples injected into the classifier prompt, so
  lookalike mail from **new** senders is nudged into the right bucket — the fuzzy
  cases a single sender rule can't cover. Each operator correction becomes an
  exemplar (`source_msg_id`), mirroring the existing drafting-exemplar surface.

#### The force/bias safety lesson (MBOX-368 / MBOX-370)
An earlier "force-to-category" override (migration 041) was **reverted**
(migration 043) because it mis-filed multi-intent senders' *other* mail: once you
hard-route a sender to one bucket, everything else they send is wrong. The
force/bias split is the fix — **bias is the default** (a prior the model
reconciles, never a bypass), and `force` is reserved for senders that genuinely
only ever send one thing. The same lesson is why a multi-intent marketplace is
routed by **subject pattern** (`lib/classification/reverb-routing.ts`), not a
single force rule.

### 3. Escalation-promotion (FR4) — `lib/classification/escalation-promotion.ts`
A pure, DB-free post-classify step that runs only on a `notification` verdict:
- If the notification matches an **escalation signal** by intent (payment failed,
  account suspension, filing/tax due, legal/compliance, security breach, commerce
  dispute) it is **promoted to `escalate`** so money/risk/deadline items stay in
  the main queue.
- Otherwise, if it's a **review** subtype (business-profile / marketplace review)
  it stays `notification` but is flagged important so the triage UI surfaces it.

Matching is conservative intent heuristics (a routine new-sign-in is not a
breach; "payroll ran" is not a payment failure).

### 4. Draft-gating + auto-draft OFF by default (FR5/FR6)
- **Draft-gating** (`lib/classification/draft-policy.ts`): every bucket carries a
  reply policy from `seed/buckets.yaml`. Only reply-worthy policies
  (`draft` / `often` / `light_draft` / `sometimes`) may produce a draft;
  receipts, notifications, marketing, spam, FYI/finance buckets **never** draft.
  `unknown` is fail-closed.
- **Auto-draft** (`lib/classification/autodraft.ts`): drafting is
  **on-demand-for-all** initially — **no bucket auto-drafts**. Auto-draft is a
  deferred opt-in toggle (`AUTODRAFT_BUCKETS`, **default OFF / empty**). Even when
  enabled, a bucket auto-drafts only if the FR5 gate also allows it, and the
  enqueue produces a **pending** draft stub — it **never sends**.

## Migrations

| Migration | Adds | Spec |
|---|---|---|
| 048 | Widens the category `CHECK` to the 23-value taxonomy on 5 tables (additive) | 002 FR1/FR2 |
| 049 | `mailbox.sender_rules` table (force/bias trainable routing) | 002 FR7 |
| 050 | `mailbox.classification_exemplars` table (few-shot) | 002 FR7b |
| 051 | `mailbox.inbox_messages.triage_state` + audit columns + index | **003** (pairs with the sidecar PR) |

Migration 051 belongs to Spec 003 (the triage action surface) but lives on the
dashboard schema, so it ships here and pairs with the sibling sidecar PR. All
migrations are `.sql` files run by `migrations/runner.ts`; **they must be run
against a real database** to take effect.

## Safety properties

- **Additive + reversible.** Every migration is new tables/columns or a widened
  (never narrowed) constraint. The 8 legacy categories stay valid; historical
  rows are untouched. Each migration documents a manual rollback.
- **Nothing sends.** No code path here sends mail or auto-approves. `auto_send_audit`
  is untouched.
- **Auto-draft is OFF by default** and gated by the reply-policy check even when on.
- **n8n untouched.** No workflow JSON changes; the classification libs are pure and
  unit-tested.
- **Fail-open / kill-switchable.** Sender-rule lookups degrade to the normal
  classify path on any DB error and can be disabled via `SENDER_RULES_DISABLE=1`.
- **Migrations need a real DB run** to take effect — applying this code alone does
  not alter any schema.
