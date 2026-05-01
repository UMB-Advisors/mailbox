<!-- GSD:project-start source:PROJECT.md -->
## Project

**MailBox One Dashboard**

Standalone Next.js 14 dashboard for the MailBox One T2 appliance. Exposes a human-in-the-loop approval queue for LLM-generated email drafts; on approve, triggers a real Gmail send via an n8n webhook.

This closes Phase 1 deliverable #6 (dashboard approval queue) and ships workflow #3 (send pipeline) of the MailBox One product roadmap.

**Core Value:** The operator can review, edit, approve, or reject LLM-drafted email replies on their phone in under 30 seconds, and approval results in a real Gmail reply going out. Without the dashboard, drafts sit in `mailbox.drafts` with no path to send.
<!-- GSD:project-end -->

<!-- GSD:stack-start source:STACK.md -->
## Technology Stack

Defer to root `../CLAUDE.md` for the appliance-wide stack. Dashboard-specific layers:

- **Next.js 14.2.x** (App Router) — internal API routes under `app/api/**/route.ts`; pages under `app/**/page.tsx`
- **Raw `pg` (8.x)** + Postgres `mailbox` schema. Pool client in `lib/db.ts`; SQL helpers in `lib/queries*.ts`. Plain `.sql` migrations under `migrations/NNN-*.sql` run via `migrations/runner.ts` (custom tsx script, no drizzle-kit). Per 2026-04-27 ADR: keep raw pg for MVP. ORM migration deferred post-customer-#2 (STAQPRO-136)
- **Tailwind CSS v3.4.x** — utility classes; mobile-responsive approval queue
- **zod** (planned, not yet in deps) — runtime validation. **STAQPRO-138 (in flight)**: plain `z.object({...})` schemas in `lib/schemas/`, parsed by shared `lib/middleware/validate.ts`. No ORM-derived schemas (no Drizzle to derive from)

The dashboard runs as the `mailbox-dashboard` service in the appliance Docker Compose stack. It is reachable behind Caddy at `https://mailbox.heronlabsinc.com/dashboard/queue` (basic_auth gated per STAQPRO-131) and over the LAN/Tailnet on port `3001`.
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

> Source of truth lives in root `../CLAUDE.md` Conventions section. This file cross-references the dashboard-relevant subset; do not duplicate.

- **Route handler pattern** — App Router contract: export named `GET`/`POST`/`PATCH`/`DELETE` from `app/api/**/route.ts` accepting `(request: Request, { params })`. Internal routes under `/api/internal/*` are not Caddy basic_auth gated — they are called from n8n inside the docker network. Treat them as trust-boundary inputs anyway (zod-validate per STAQPRO-138).
- **Status state machine** — `mailbox.drafts.status` lifecycle (live CHECK): `pending` → `awaiting_cloud` (cloud call in flight) → (`approved` | `rejected` | `edited`) → (`sent` | `failed`). Source of truth = the Postgres CHECK constraint in `migrations/003-evolve-drafts-to-queue-shape-v1-2026-04-27.sql`. Planned home for the TS-side enum constant is `lib/types.ts` — STAQPRO-137 will consolidate so route handlers import once instead of redeclaring string literals.
- **Draft source values** — `drafts.draft_source` = `local` | `cloud` (the route taken). The model used is recorded separately in `drafts.model`. Constraint also permits legacy `local_qwen3` / `cloud_haiku` but the live drafting path writes `local` / `cloud`.
- **SQL convention** — Hand-rolled SQL via `pg.Pool` from `lib/db.ts`. Two surface patterns: (a) named query helpers in `lib/queries*.ts` (preferred — keeps SQL out of route handlers) and (b) inline `pool.query(sql, params)` for one-off queries. Promote to `lib/queries*.ts` when 2+ routes need the same query. Always parameterize.
- **Validation** — request body / query / params validation goes through zod schemas in `dashboard/lib/schemas/` via the shared `dashboard/lib/middleware/validate.ts` middleware. No inline `typeof x !== 'string'` checks in handlers.
- **Internal route auth** — `/api/internal/*` callers should send the n8n internal HMAC header (when wired). Until then, treat exposure as the threat model and zod-validate aggressively.
- **Migration comments** — every `.sql` migration opens with a 2-3 line block comment per the migration 007 standard: what, why (link issue or DR), reversal note. The comment is the only documentation — there's no separate ADR per migration.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

The dashboard plays two roles in the appliance:

1. **Operator UI** — approval queue at `/dashboard/queue`. Renders pending drafts from `mailbox.drafts` (status `pending_approval`); operator can approve/reject/edit. On approve, the dashboard fires the `MailBOX-Send` sub-workflow via the n8n webhook URL in `N8N_WEBHOOK_URL`.
2. **Internal API for n8n** — n8n's classify/draft sub-workflows call back into the dashboard for prompt assembly, output normalization, and live-gate checks. These routes live under `/api/internal/*` and are reached over the docker network.

### Routes (App Router)

CRUD (operator-facing, basic_auth gated by Caddy):
- `app/api/drafts/route.ts` — `GET` list of pending drafts
- `app/api/drafts/[id]/route.ts` — `GET` single draft
- `app/api/drafts/[id]/approve/route.ts` — `POST` approve + fire send webhook
- `app/api/drafts/[id]/reject/route.ts` — `POST` reject
- `app/api/drafts/[id]/edit/route.ts` — `PATCH` edit body before approve
- `app/api/drafts/[id]/retry/route.ts` — `POST` re-run draft generation

Internal (n8n-facing, docker network only):
- `app/api/internal/classification-prompt/route.ts` — assemble classify prompt for the Qwen3 call
- `app/api/internal/classification-normalize/route.ts` — normalize Qwen3 classify output → enum + confidence
- `app/api/internal/draft-prompt/route.ts` — assemble drafting prompt (route-aware: local vs cloud persona blocks)
- `app/api/internal/draft-finalize/route.ts` — accept LLM draft output, persist to `mailbox.drafts`, set `status = pending_approval`
- `app/api/onboarding/live-gate/route.ts` — gate classify/draft execution behind onboarding completion. Bypass via `MAILBOX_LIVE_GATE_BYPASS=1` for dogfood

### Data layer

- `lib/db.ts` — `pg.Pool` client, lazy-initialized from `POSTGRES_URL`
- `lib/queries.ts` — drafts queue + dashboard CRUD helpers
- `lib/queries-onboarding.ts` — onboarding state queries
- `lib/queries-persona.ts` — persona config queries
- `lib/types.ts` — hand-rolled TS types (incrementally being replaced as zod schemas land per STAQPRO-138)

Migrations live as plain `.sql` files in `migrations/NNN-*.sql`. The runner is `migrations/runner.ts` (custom tsx script that tracks applied versions in `mailbox.migrations`). The separate `mailbox-migrate` compose service runs the same script: `docker compose --profile migrate run mailbox-migrate`.

### Routing logic

`dashboard/lib/classification/prompt.ts:routeFor` decides local vs cloud per the rules in root `../CLAUDE.md` (Architecture > Routing rules). When this file is edited, also re-run the eval baselines (see `scripts/eval-output-2026-05-01-tuned.md` for the live behavior reference).

### Tests

None yet — STAQPRO-133 is in flight to add Vitest with pipeline smoke + schema invariants + per-route tests + workflow JSON drift. Until then, behavior is exercised by `scripts/smoke-test.sh` (infrastructure only) and the in-container `smoke-draft.mjs` chain.
<!-- GSD:architecture-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd:quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd:debug` for investigation and bug fixing
- `/gsd:execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->



<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd:profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
