# Spec: Agent Job Templates — Ship-with-the-Box Catalog

**Version:** v0.1.0
**Date:** 2026-06-07
**Status:** Draft — for review
**Author:** Claude (session), for Dustin
**Product:** AgentBOX (formerly MailBOX; project consolidated 2026-06-07)
**Milestone:** Skills & Jobs (`390d6bbd-…`)
**Supersedes / extends:** nothing — additive to the existing Skills & Jobs milestone

---

## TL;DR

A fresh AgentBOX today ships with **one** working automation the operator sees: the triage→draft→approve→send queue. Everything else valuable the box *can* do — daily digest, follow-up sweeps, VIP alerts, auto-archive — is either off, bespoke, or invisible. This spec defines an **Agent Job Templates catalog**: a curated library of preconfigured, operator-toggleable agent jobs that ship *on the box* so customer #N gets day-one value without artisanal setup. Substrate is **hybrid and rule-driven** — n8n workflow templates where the job is event/schedule + Gmail/IO-shaped (the common case), dashboard jobs (`lib/jobs/`) where the job is DB-shaped, fast, or needs first-class run tracking. The catalog is a *registry over substrates*, not a new engine. It is the natural seed for tier- and Pack-gated entitlements.

---

## §0. Context & Prior Art (read first)

This is **not a new track.** The `Skills & Jobs` milestone already holds the substrate pieces — they're just unstarted (progress 0) and uncoordinated (all siblings, no parent epic):

| Existing milestone issue | Role in this spec |
|---|---|
| Scheduled jobs engine (cron-like agent runs) | The **dashboard-jobs substrate** (Rail B below) |
| Jobs dashboard surface (list, status, control, logs) | The operator UI this catalog populates |
| Reference job — daily digest | First catalog entry (already live as `MailBOX-Digest`) |
| Reference job — follow-up sweep | Second catalog entry (detection live, MBOX-377) |
| Curated on-box skill catalog v1 | The **skill** analog — sibling concept, shares the registry/trust model |
| Skillpack registry & install flow | Install/activation plumbing this catalog reuses |
| Skill authoring, trust & permissions model | Trust model the catalog inherits |
| Per-job model selector when scheduling Agent Jobs | Per-template default + per-instance override (§5.3) |
| Agent Jobs: sort list by Department | UI detail on the surface |

**The gap this spec fills:** those issues build the *engine, the surface, and two reference jobs*. None of them define **the collection** — the curated library of templates that actually ships, the substrate decision rule, or the packaging/entitlement model. That's this document.

### What already behaves like an Agent Job (de-facto jobs to formalize)

| Capability | Where it lives | Substrate today |
|---|---|---|
| Daily digest | `MailBOX-Digest.json` + `lib/digest/*` + `/api/internal/digest` | n8n schedule → dashboard render |
| Follow-up / no-reply detection | `getAwaitingReply` + amber digest section (MBOX-377) | dashboard query, surfaced in digest |
| Urgency / VIP escalation | `lib/urgency.ts` (MBOX-134, migration 028) | dashboard, set-wise SQL |
| Classify backfill sweep | `lib/jobs/classify-sweeper.ts` | dashboard job + `job-runs.ts` |
| Gmail rate-limit sweeper | `lib/jobs/gmail-ratelimit-sweeper.ts` | dashboard job |
| Stuck-stub sweeper | `lib/jobs/stuck-stub-sweeper.ts` | dashboard job |
| Alert check | `MailBOX-AlertCheck.json` | n8n schedule |

**Key finding:** the dashboard already has a jobs framework — `dashboard/lib/jobs/` with **`job-runs.ts`** (run tracking) and three live sweepers. And n8n already ships **7 workflow JSONs** in `n8n/workflows/`. Both rails of the hybrid exist. This spec is a unifying *catalog layer*, not new infrastructure.

---

## §1. Problem

1. **Cold-start value gap.** A newly provisioned box does one visible thing. The operator must be told (or SSH'd into) to get digests, follow-up nudges, VIP alerts. That's artisanal — exactly what M5 productization fought to kill.
2. **No catalog primitive.** "Agent Job" is not a first-class noun anywhere in the codebase. Jobs are scattered across n8n JSON, `lib/jobs/`, and inline features with no registry, no shared enable/disable, no shared run history surface.
3. **No packaging hook.** AgentBOX is sold with purchasable Packs and (future) hardware tiers. There is no clean unit to gate, bundle, or sell "this box comes with the Sales-Ops job bundle." Templates are that unit.
4. **Reinvention per customer.** Each new vertical re-derives the same handful of automations (chase quotes, archive newsletters, OOO ack) by hand. A template library makes them ship-once, configure-light.

---

## §2. Concept Model

Four nouns. Keep them distinct.

- **Agent Job** — a unit of recurring or triggered agent work beyond the core reply loop. Has a trigger (schedule or event), an action, and operator visibility (status + run history).
- **Job Template** — a *definition* of an Agent Job, shipped in the repo, substrate-tagged, parameterized, not yet bound to a box. The catalog is a set of these.
- **Job Instance** — a Template **enabled on a specific box** with its parameters filled (schedule, recipient, thresholds, model). Has run history.
- **Catalog** — the curated, versioned set of Templates that ships with an AgentBOX image, filtered by entitlement (tier + Packs).

```
Job Template (repo, substrate-tagged)
      │  enable + parameterize (onboarding or dashboard)
      ▼
Job Instance (box-local row) ──runs──> Job Run (job-runs.ts history) ──> Jobs dashboard surface
```

---

## §3. Substrate Decision Rule (the core design choice)

Per the directive: **n8n when it makes sense; dashboard jobs as the alternative.** Made concrete so it's not a judgment call per template:

**Rail A — n8n workflow template** (default for IO/integration jobs). Use when the job:
- touches Gmail / Graph / external APIs with retry, OR
- is schedule- or webhook-triggered and orchestration-shaped, OR
- benefits from the existing rate-limit circuit breaker + execution_entity audit trail.
- Ships as `n8n/workflows/<name>.json`, imported by the installer, activated per the `mailbox-n8n-verify` gate.

**Rail B — dashboard job** (`dashboard/lib/jobs/`). Use when the job:
- is primarily a DB sweep / set-wise SQL operation, OR
- must complete in well under the n8n 5-min poll granularity, OR
- needs first-class typed run tracking via `job-runs.ts`, OR
- has no external IO (pure on-box computation).

**Decision table for v1 templates:**

| Job | Rail | Why |
|---|---|---|
| Daily digest | A (n8n schedule) → B (render) | already this shape; keep |
| Follow-up / no-reply nudge | A | sends Gmail replies; needs cooldown breaker |
| Unanswered-quote / reorder chaser | A | Gmail send + aging |
| Auto-archive newsletters & marketing | A | Gmail modify (gmail.modify scope confirmed, MBOX-369) |
| VIP escalation alert | B | DB-shaped detection; alert via existing channel |
| After-hours / OOO auto-acknowledge | A | event-shaped Gmail reply |
| Meeting-request → calendar draft | A | external (Calendar) IO; **net-new, gated** |
| Inbox hygiene digest (orphans/aging) | B | pure on-box sweep |

**Invariant:** the *catalog/registry* is substrate-agnostic. A Template row names its rail; the operator never sees the distinction. This keeps Rail A/B an implementation detail, swappable per template without touching the surface.

---

## §4. The v1 Template Collection

Tier column is **proposed** (graduates with the Hardware-tiers + Persona-Packs milestones). "Status today" is honest about reuse vs net-new.

| # | Template | Trigger | Rail | Status today | Tier (proposed) |
|---|---|---|---|---|---|
| T1 | Daily inbox digest | schedule (DIGEST_SEND_HOUR) | A→B | **live** (`MailBOX-Digest`) | Core |
| T2 | Follow-up / no-reply nudge | schedule (daily) | A | detection live (MBOX-377); auto-nudge net-new | Core |
| T3 | Unanswered-quote / reorder chaser | schedule | A | partial (urgency `aged`) | Pro |
| T4 | Auto-archive newsletters & marketing | event (on-classify) | A | partial (spam drop + row actions) | Core |
| T5 | VIP escalation alert | event/schedule | B | partial (`vip_senders`, mig 028) | Core |
| T6 | After-hours / OOO auto-acknowledge | event (inbound) | A | net-new | Pro |
| T7 | Inbox hygiene digest (orphans, aging, stuck) | schedule | B | partial (status page stats) | Core |
| T8 | Meeting-request → calendar draft | event | A | **net-new, gated** (needs Calendar) | Pro/Pack |

**Scope discipline:** v1 ships **T1, T2, T4, T5, T7** (all reuse-heavy, no net-new external integrations). T3, T6, T8 are v1.1+ (T8 blocked on Calendar). This keeps the first shippable catalog to "formalize + package what mostly exists," not "build 8 new features."

---

## §5. Packaging & Shipping Model

### §5.1 How templates ship on the box
Templates live in the repo as a **versioned registry** (§6). The installer/factory-bootstrap imports Rail-A workflow JSONs and seeds Rail-B job definitions. Nothing customer-specific bakes in — templates are *definitions*; instances are created at onboarding.

### §5.2 Enable at onboarding, not by SSH
Onboarding wizard gains a **"Recommended Jobs"** step: the entitlement-filtered catalog with smart defaults pre-checked (Core templates on by default). Operator confirms; instances are created. This is the cold-start fix — a fresh box lights up the digest + follow-up + hygiene jobs without a console.

### §5.3 Entitlement / tier gating
The catalog is filtered by **(hardware tier × installed Packs)**. A template declares `entitlement: { min_tier, pack? }`. Un-entitled templates render in the surface as upsell-locked (consistent with the Persona-Packs entitlement model). Per-job **model selector** (existing milestone issue) is a per-instance override on top of the template default — Core boxes default cheaper local/cloud, Pro boxes may default to larger local model.

### §5.4 Versioning & OTA
The catalog is versioned (`catalog@vN`). OTA updates ship new/changed templates; existing instances keep their parameters and are migrated only on explicit operator opt-in (templates are definitions, instances are state — never silently mutate instance config on update, per the `rag_context_refs` point-in-time discipline).

---

## §6. Architecture Sketch

### §6.1 Registry format (proposed)
A single source of truth listing every template, substrate-tagged:

```
dashboard/lib/jobs/catalog/
  index.ts            // typed registry: JobTemplate[]
  templates/
    daily-digest.ts   // { id, title, rail:'n8n', workflow:'MailBOX-Digest', params, entitlement, defaults }
    followup-nudge.ts
    vip-alert.ts      // { id, rail:'dashboard', runner: ..., schedule, params, entitlement }
    ...
```

`JobTemplate` shape (sketch — finalize in implementation):
```ts
type JobTemplate = {
  id: string;                 // stable slug
  title: string; summary: string;
  rail: 'n8n' | 'dashboard';
  trigger: { kind: 'schedule' | 'event'; default: string };
  params: ParamSpec[];        // operator-tunable, with defaults
  entitlement: { minTier: Tier; pack?: PackId };
  defaultModel?: ModelRef;
  // rail:'n8n'  -> workflow: string (JSON name in n8n/workflows/)
  // rail:'dashboard' -> runner: (ctx) => Promise<JobRunResult>
};
```

### §6.2 Instances + run history
- **Instances:** new `mailbox.job_instances` table (template_id, enabled, params jsonb, schedule, model, created_by). Migration-gated (next free high-water; verify before assigning).
- **Runs:** reuse `dashboard/lib/jobs/job-runs.ts` (already tracks dashboard-job runs). Extend to record Rail-A runs by mirroring n8n `execution_entity` outcomes, so the surface shows **one** unified history regardless of rail.

### §6.3 Dashboard surface
Populate the existing "Jobs dashboard surface" issue from the registry: list (catalog + instances), per-instance status/last-run/next-run, enable/disable, params edit, run-now, logs (last N runs from `job-runs.ts`). Department sort = existing sibling issue.

### §6.4 Scheduling
Rail-A jobs schedule in n8n (existing). Rail-B jobs need a scheduler — this is the existing **"Scheduled jobs engine"** issue. Recommend a single in-dashboard cron loop (node-cron or a DB-claimed tick) reading `job_instances WHERE rail='dashboard' AND enabled`, writing `job-runs`. Keep it boringly simple; the 8 GB envelope and single-tenant trust make a heavyweight queue unnecessary.

---

## §7. Mapping to Existing Milestone Issues

This spec **coordinates** the loose Skills & Jobs issues under one deliverable rather than duplicating them:

| Existing issue | Becomes / relates |
|---|---|
| Scheduled jobs engine | §6.4 — Rail-B scheduler (prerequisite for B templates) |
| Jobs dashboard surface | §6.3 — registry-driven surface |
| Reference job — daily digest | T1 — formalize the live digest into a Template |
| Reference job — follow-up sweep | T2 — formalize MBOX-377 into a Template + add nudge action |
| Per-job model selector | §5.3 — per-instance override |
| Agent Jobs: sort by Department | §6.3 surface detail |
| Curated on-box skill catalog v1 | parallel sibling (skills, not jobs) — shares registry/trust shape; cross-reference, don't merge |
| Skillpack registry / authoring / trust | install + trust plumbing reused by §6.1 |

**Proposed:** a new parent epic in the Skills & Jobs milestone — *"Agent Job Templates — ship-with-the-box catalog"* — that parents the catalog/registry + T1–T7 + onboarding step, and *depends on* Scheduled-jobs-engine + Jobs-dashboard-surface. (Operator to reparent the existing reference-job siblings; this session won't restructure issues it didn't create.)

---

## §8. Phasing

- **P0 — Registry + two formalized references.** `lib/jobs/catalog/` + `JobTemplate` type; convert T1 (digest) and T2 (follow-up) into Templates; `job_instances` table; unify run history. No new user-facing jobs. *Proves the abstraction over both rails.*
- **P1 — Surface + onboarding step.** Jobs dashboard surface from the registry; "Recommended Jobs" onboarding step; enable/disable/run-now. *Closes the cold-start gap.*
- **P2 — Fill the Core catalog.** T4 auto-archive, T5 VIP alert, T7 hygiene digest. *First "collection" worth shipping.*
- **P3 — Entitlement gating + Pro templates.** Tier/Pack filter; T3 chaser, T6 OOO ack. *Packaging hook lights up.*
- **P4 — Calendar + net-new.** T8 meeting→calendar (blocked on Calendar integration). *Defer until Calendar lands.*

Gating: P0/P1 depend on the Scheduled-jobs-engine + Jobs-surface issues. P3 depends on the Hardware-tiers entitlement layer.

---

## §9. Open Decisions (graduate to DR-NN on ratification)

> Numbered locally (D1…) to avoid DR/SM/NC collision; assign DR numbers at ratification after a definition-not-presence collision check (per `reference_prd_numbering_highwater`).

- **D1 — Scheduler for Rail B.** In-dashboard cron loop vs. lean DB-claimed tick vs. lean queue. *Recommend:* DB-claimed tick. Single-tenant, 8 GB — no queue.
- **D2 — Unified run history.** Mirror n8n executions into `job-runs` vs. federate two sources at read time. *Recommend:* mirror, so the surface has one query.
- **D3 — Default-on Core templates.** Which templates are pre-checked at onboarding (silent value vs. consent). *Recommend:* digest + hygiene on; anything that *sends* email (follow-up nudge, OOO) off-by-default until operator opts in — sending without consent is a trust violation.
- **D4 — Template vs. Skill boundary.** When is an automation a Job Template vs. a gbrain Skill? *Recommend:* Jobs = scheduled/triggered agent *actions* with run history; Skills = capabilities a Pack grants the agent. A Job may *use* a Skill.
- **D5 — Entitlement source of truth.** Where tier/Pack entitlement is read (shared with Persona Packs). Defer to the entitlement layer in the Hardware-tiers milestone; don't invent a second one here.

---

## §10. Out of Scope (v1)

- A general user-authored job builder (operators pick from the catalog; authoring is a later, trust-gated feature aligned with skill authoring).
- Multi-tenant / fleet-level job orchestration (single-box only; fleet is a separate concern).
- Net-new external integrations beyond what templates reuse (Calendar gates T8; no Notion/Slack jobs in v1).
- Marketplace / third-party template distribution (catalog is first-party, repo-shipped).

---

## Appendix A — Why "registry over substrates," not a new engine

The temptation is to build one job engine and port everything to it. Rejected: n8n already does retrying IO orchestration with a battle-tested rate-limit breaker, and `lib/jobs/` already does fast DB sweeps with run tracking. Forcing either into the other loses what each is good at. The cheap, correct move is a **thin catalog/registry** that tags each template's rail and presents one operator surface — ~1 new table, 1 type, 1 scheduler for the B rail, reusing everything else. This matches the repo's "smallest correct change" and the 8 GB envelope.
