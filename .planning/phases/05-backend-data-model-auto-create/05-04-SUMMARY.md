# Plan 05-04 Summary — Gated agentbox3 Deploy & Live Verification

**Completed:** 2026-07-28
**Status:** Complete — deployed and verified live
**Requirements:** MAP-04, FILT-05
**Executed by:** orchestrator directly (not delegated — live-infrastructure step)

## What shipped

Migration 057 and the Phase 5 runtime code are live on `agentbox3`. All 6 connected
accounts are now linked to CRM businesses, and every business carries a frozen slug.

## Pre-flight (recon + safety)

Verified before touching anything:

| Check | Result |
|---|---|
| Box migration state | `056` — 057 not yet applied |
| `accounts.business_id` / `businesses.slug` present | 0 — clean starting point |
| `~/.hermes/cron/jobs.json` business slugs | exactly one: `altitude` — **D-14 held** |
| Containers healthy | postgres, dashboard, n8n, qdrant, ollama all Up |

**Backup taken:** `~/mailbox-pre-057-20260728-1526.sql` (19 MB, `pg_dump --schema=mailbox`).
Pre-deploy row counts recorded: accounts 6, businesses 3, departments 1,
inbox_messages 584, drafts 48.

## Deploy sequence (and why this order)

The box runs a **baked** Docker image. Migration 057 makes `businesses.slug` NOT NULL,
and the pre-057 image's `createBusiness` inserts without a slug — so applying the
migration while the old image was serving would have made `POST /api/crm/businesses`
throw 23502 until the container was replaced. The image was therefore **built first**
(build needs no DB), so the exposure window was reduced to the seconds between migration
COMMIT and container restart.

1. **Pushed** `811016f..7faf347` to `origin/master`.
2. **Discovered a checkout ambiguity:** neither `~/mailbox` nor `~/agentbox/mailbox` is a
   git repo — both are snapshots. `~/mailbox` is the live deploy dir (holds the working
   26 KB `.env`); `~/agentbox/mailbox` is the build checkout that actually produced the
   running image (it has the CRM routes; `~/mailbox/dashboard` is stale at migration 051).
   Synced the unified master source into the **build** checkout via `rsync -az --delete`,
   excluding `node_modules/`, `.next/`, `.env*`.
3. **Built** `mailbox-dashboard:057` (259 MB). Tagged the outgoing image
   `mailbox-dashboard:pre-057-20260728` for rollback, then retagged `057` → `local`.
4. **Applied migration 057** as a single atomic psql transaction (`BEGIN` … migration …
   tracker `INSERT` … `COMMIT`, with `ON_ERROR_STOP=1`), matching what `runner.ts` does.
   Output: `UPDATE 3` (base slug backfill), `DO` (collision pass, no collisions),
   `UPDATE 1` (the `altitude` legacy seed), `CREATE INDEX`, `INSERT 0 1`.
5. **Restarted** the dashboard on the new image — healthy, `HTTP 200`, sweepers started.
6. **Ran the backfill** — dry run first, then live, then a third time to prove idempotency.

## Backfill result — exactly D-09

Dry run previewed 3 reuse + 3 create; the live run matched it precisely:

```
processed=6  businesses_created=3  failed=0  still_unlinked=0
```

| Account | → Business | Slug | Path |
|---|---|---|---|
| mike@umbadvisors.com | #3 UMB Advisors | `umb-advisors` | reused existing |
| mike@autocsr.com | #4 AutoCSR | `autocsr` | reused existing |
| mike@altitudeguitar.com | #2 Altitude Guitar | **`altitude`** | reused existing |
| mike@jiffyautoglass.com | #8 Jiffy Auto Glass | `jiffy-auto-glass` | created |
| mike@elevatedadvisors.co | #9 Elevated Advisory | `elevated-advisory` | created |
| mike@bonvillain-design.com | #10 Bonvillian Design | `bonvillian-design` | created |

A second live run reported `0 candidate account(s)` — **idempotent, confirmed against real
data**, not just against a test fixture.

## Verification evidence

- **MAP-04 / D-09:** `unlinked_accounts = 0`. All six accounts carry a `business_id`.
- **FILT-05 / D-14:** Altitude Guitar's slug is `altitude`, so the one live cron job
  carrying that string keeps resolving when Phase 7 repoints the sidecar.
- **Data integrity vs. pre-deploy counts:** accounts 6→6, departments 1→1, drafts 48→48,
  businesses 3→6 (the 3 intended creations). `inbox_messages` 584→590 — a +6 delta from
  mail arriving normally during the deploy window, not a migration side effect.
- **Live API:** `GET /dashboard/api/crm/businesses` → `200`. This is the specific route
  that would have failed had the image/migration order been reversed.

## Deviations from plan

1. **Backfill could not run inside the runtime container.** `docker exec mailbox-dashboard
   npx tsx scripts/business-link-backfill.ts` fails with `MODULE_NOT_FOUND` — the runner
   stage is a stripped Next standalone build without the dev deps `tsx` needs to resolve
   `lib/crm/auto-link.ts`'s imports. Resolved by building the Dockerfile's `builder`
   target (`mailbox-dashboard:builder`, warm cache, fast) and running the script there on
   the `mailbox_default` network. **Worth knowing for Phase 6+** — any future one-shot
   script on this appliance needs the builder image, not the runtime image.
2. **`POSTGRES_URL` could not be reconstructed from `.env` by shell parsing** (the password
   contains characters that broke naive `cut`/`tr` extraction → `ERR_INVALID_URL`). Read
   the exact value out of the running container's config instead
   (`docker inspect mailbox-dashboard`), which is both correct and avoids echoing the
   secret.

## Rollback path (retained)

- Image: `mailbox-dashboard:pre-057-20260728` (plus older `pre-unified-20260711`,
  `pre-crm-20260709`).
- DB: `~/mailbox-pre-057-20260728-1526.sql`, and the migration header carries literal
  reversal SQL (drop index → drop `slug` → drop `business_id` → delete the tracker row).

## Follow-ups (not blocking)

- `~/mailbox/dashboard` on the box remains a stale (migration-051-era) snapshot while
  `~/agentbox/mailbox/dashboard` is the real build source, even though
  `~/mailbox/docker-compose.yml` declares `build: context: ./dashboard`. The image is
  consumed by tag so nothing is broken today, but the two should be reconciled to one
  canonical deploy dir before the next appliance rebuild.
- The GSD `state.update-progress` frontmatter quirk logged in plan 05-01 is still open;
  it is a tooling issue, unrelated to this phase's code.
