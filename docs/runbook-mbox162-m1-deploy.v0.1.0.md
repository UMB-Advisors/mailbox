# Runbook — M1 deploy: catch up MBOX-162 (V1–V3 + UI-port P1–P4) + multi-provider P0

**Version:** 0.1.0 · **Date:** 2026-05-29 · **Box:** M1 (`mailbox1`, Heron Labs, `mailbox.heronlabsinc.com`)
**Prep by:** agent (deploy-prep for MBOX-162). **Run by:** operator — appliance `.env` edits + `docker compose up -d` are agent-blocked by design.

## TL;DR

M1 is **5 commits behind master** with **2 pending migrations (037, 038)**. All MBOX-162 committed scope
(multi-account V1–V3, UI-port P1–P4) is merged but **not yet live**. This deploy catches up the whole backlog
in one pass. Both migrations are **additive, idempotent, non-breaking**; the live single-account pipeline is
**behavior-neutral** after deploy (accounts=1 → V1–V3 dormant until a 2nd inbox is connected). Risk: **low**.

## What's in the gap (M1 `45e803e` → master HEAD `98e2e68`)

| Commit | PR | What | Migration |
|---|---|---|---|
| `7e55c80` | #184 | MBOX-356 P0 — MailProvider seam + `accounts.provider` dimension | **037** |
| `5b46756` | #186 | docs: DR/NC/SM renumber | — |
| `373851a` | #187 | docs: revert that renumber | — |
| `4f306ee` | #188 | MBOX-162 **P4** — right pane (Calendar/Drive) + `operator_settings` | **038** |
| `98e2e68` | #190 | chore(deps): `@umb-advisors/llm` 0.1.0 → **0.1.2** (MBOX-120 grammar passthrough) | — |

### Pending migrations (both verified clean)

- **037 `add-account-provider`** — `ALTER TABLE mailbox.accounts ADD COLUMN provider text NOT NULL DEFAULT 'gmail' CHECK (...)` + `provider_config jsonb DEFAULT '{}'`. Backfills every existing (Gmail) account deterministically. No DML, no live-path change.
- **038 `create-operator-settings`** — `CREATE TABLE IF NOT EXISTS mailbox.operator_settings` (singleton id=1) + seed `INSERT ... ON CONFLICT DO NOTHING`. Fully idempotent; feeds the P4 right pane only.

The runner (`dashboard/migrations/runner.ts`) tracks applied versions in `mailbox.migrations`, sorts by filename,
skips applied, applies the rest in order — so `--profile migrate` applies 037 then 038 and records both.

## Pre-flight caveats (read before running)

1. **`GITHUB_PACKAGES_TOKEN` must be live in `~/mailbox/.env`.** Both the migrate container (npm-installs at runtime) and the dashboard image build pull `@umb-advisors/llm@0.1.2` from GitHub Packages. History of **403 on this exact package** (fixed 2026-05-26) — if the build fails on the install step, check the token first.
2. **Always `--remove-orphans`** on the full-stack `up` (removed services keep host port bindings otherwise).
3. **This deploy is cross-track** — it brings up multi-provider P0 (#184) + the dep bump (#190) alongside P4, not just MBOX-162. Expected per the "M1 deploys catch up the WHOLE backlog" rule. Nothing in the gap changes runtime behavior for the live single-account Gmail pipeline.
4. **P3 flag (`MAILBOX_REDRAFT_ENABLED`)** — comments conflict on whether it's already set on M1 (the 18:02 [P3 ENABLED] comment says `flag_in_container=[1]`; the 19:04 [P4] comment says still outstanding). **Verify, don't assume** — step 7 below.

## Steps (run on the box)

```bash
ssh mailbox1
cd ~/mailbox
```

**1. Pre-flight git_state (MBOX-163) — confirm the gap before pulling.**
```bash
# from your workstation (or on-box), $PW = M1 Caddy basic_auth (op item get 'mailbox.heronlabsinc.com' --vault MailBOX --reveal --fields password)
curl -su "admin:$PW" https://mailbox.heronlabsinc.com/dashboard/api/system/status | jq .git_state
# expect: commits_behind_master ~5, dirty=false, git_branch=master
```

**2. DB backup BEFORE migrate.**
```bash
mkdir -p .deploy-backup-mbox162
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' \
  > .deploy-backup-mbox162/pre-038-$(date +%Y%m%d-%H%M%S).dump
ls -la .deploy-backup-mbox162/   # confirm non-zero size
```

**3. Pull + submodule.**
```bash
git fetch origin
git log --oneline HEAD..origin/master   # sanity: the 5 commits above
git pull
git submodule update --init             # vendor/thumbox-common; "canonical not found" => this was skipped
```

**4. Apply pending migrations (037, 038).**
```bash
docker compose --profile migrate run --rm mailbox-migrate
# expect: [skip] up to 036, [apply] 037..., [apply] 038...
```

**5. Build + swap (pulls @umb-advisors/llm@0.1.2).**
```bash
docker compose up -d --build --remove-orphans
```

**6. Verify deploy.**
```bash
# n8n: all 4 MailBOX workflows active (exit 0)
docker compose --profile n8n-verify run --rm mailbox-n8n-verify

# dashboard up
curl -s -o /dev/null -w 'queue=%{http_code}\n' -u "admin:$PW" https://mailbox.heronlabsinc.com/dashboard/queue   # 200

# git_state caught up
curl -su "admin:$PW" https://mailbox.heronlabsinc.com/dashboard/api/system/status | jq .git_state   # 0 behind / 0 ahead, dirty=false

# migrations recorded
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" "$POSTGRES_DB" -c "SELECT version FROM mailbox.migrations ORDER BY version DESC LIMIT 4;"'
# expect 038-create-operator-settings..., 037-add-account-provider..., 036..., 035...
```

**7. P3 redraft flag — verify, set only if missing.**
```bash
docker exec mailbox-dashboard printenv | grep MAILBOX_REDRAFT_ENABLED || echo "MISSING"
# if MISSING:
#   echo 'MAILBOX_REDRAFT_ENABLED=1' >> ~/mailbox/.env && docker compose up -d mailbox-dashboard
#   (flag is in docker-compose.yml dashboard environment since #182; .env edit + up -d is enough)
```

**8. Optional smoke** — open `/dashboard/queue` and `/settings/workspace`; the right pane Calendar/Drive tabs
should render the "Open Workspace settings" CTA (no embed configured yet — expected).

## Rollback

Migrations are additive — a code rollback (`git checkout 45e803e && docker compose up -d --build`) leaves 037/038
harmless (unused columns/table). If a true DB rollback is needed, restore the step-2 dump:
```bash
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" "$POSTGRES_DB"' < .deploy-backup-mbox162/pre-038-<ts>.dump
```
Or apply the per-migration reversal SQL noted in each file's header comment.

## After this deploy — MBOX-162 status

- **Live & complete:** multi-account V1–V3 + UI-port P1–P4 (all behavior-neutral at accounts=1).
- **Deferred (own epic / Phase 3+):** P5 Tuning, V4 cross-account intelligence.
- **On 2nd-inbox connect:** connect its Gmail OAuth, run `scripts/rekey-qdrant-account-point-ids.ts` to engage per-account RAG/KB isolation; selector + badge become active.
- **Human product decisions:** NC-30 (M365 forcing function), NC-31 (accounts cap), NC-32 (tier).
