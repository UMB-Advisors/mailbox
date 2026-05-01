# MailBox Provisioning Runbook v0.1.0

**Status:** SKELETON — fill during 2026-05-02 walkthrough on customer #1 appliance, validate by reproducing on customer #2 (gates M3).

**Audience:** Whoever is provisioning a new MailBox appliance from a freshly-flashed Jetson + a customer's empty Google + DNS accounts. Assumes Dustin or successor.

**Tracks:** STAQPRO-163. Parent: STAQPRO-159 (M2 — 2nd-appliance readiness).

---

## How to use this doc

- Each section maps to one item in the STAQPRO-163 scope checklist.
- `TODO:` markers are walkthrough capture points — record the **exact command you'd type tonight**, not the tidied-up version.
- `OPEN Q:` markers are decisions/lookups that need a real answer before v1.0.0.
- `STALE:` markers are scope items the issue inherited from pre-DR-22 architecture; verify with Eric whether to drop or rewrite.
- Bump file version on revision: patch for typos, minor for added sections, major for structural rewrite.

## Pre-flight inventory (before touching the Jetson)

Collect from the customer **before** the unit ships:

- [ ] Domain to use (e.g. `mailbox.<customer>.com`) and DNS provider (Cloudflare assumed)
- [ ] Cloudflare API token (DNS-01 scope only — see §5)
- [ ] Google Workspace admin able to grant Gmail OAuth scopes
- [ ] Customer GCP project ID + billing contact (only relevant if §4 is reinstated; see STALE flag)
- [ ] Pooled UMB Anthropic API key allocation slot (Glue Co-managed)
- [ ] Tailscale invite delivered + accepted (for `mailbox-jetson-NN` enrollment)

`TODO:` Lift this into a customer-onboarding form (links to STAQPRO-164 sub-task "Customer GCP/DNS pre-flight").

---

## 1. Hardware bring-up

**Goal:** Jetson Orin Nano Super powered, JetPack 6.2.x installed, NVMe partitioned, Docker + nvidia-container-toolkit working, GPU passthrough verified.

- [ ] Flash JetPack 6.2.x via SDK Manager (host PC required; not scriptable)
- [ ] Install M.2 NVMe (500GB target per PRD §3.5)
- [ ] Partition NVMe — `p1` boot/EFI, `p2` rootfs, `p3` swap, `p4` data (LUKS-encrypted)
- [ ] Run `scripts/first-boot.sh` (existing, see `Install Guide/Install.md`)
- [ ] Install Docker via JetsonHacks `install_nvidia_docker.sh` (NOT `docker-ce` — breaks NVIDIA runtime)
- [ ] `nvidia-ctk runtime configure --runtime=docker`
- [ ] Verify GPU passthrough: `docker run --rm --runtime nvidia nvidia/cuda:12.3.0-base-ubuntu22.04 nvidia-smi`
- [ ] Confirm 25W power envelope under load (PRD §3.5) — `tegrastats` while Ollama loaded

`TODO:` Capture exact NVMe partition commands run on customer #1 (parted? sgdisk?). Existing `Install Guide/Install.md` covers flash + first-boot but stops short of the partition step.

`TODO:` Decide whether SDK Manager flashing stays manual or whether we ship pre-flashed eMMC images to customers.

---

## 2. Tailscale enrollment

**Goal:** Appliance reachable over the `consultingfutures@gmail.com` tailnet at a predictable hostname.

**Naming convention:** `mailbox-jetson-NN` (e.g. `mailbox-jetson-01` is customer #1 / Heron Labs).

- [ ] `curl -fsSL https://tailscale.com/install.sh | sh`
- [ ] `sudo tailscale up --ssh --hostname=mailbox-jetson-NN`
- [ ] Approve device in admin console; assign tag `tag:mailbox-appliance`
- [ ] Verify MagicDNS: `tailscale ping mailbox-jetson-NN.tail377a9a.ts.net` from workstation
- [ ] Document local SSH alias addition for ops team

`TODO:` Confirm `--ssh` (Tailscale SSH) is the standard, or whether we always copy `~/.ssh/authorized_keys` instead. Customer #1 + Dustin's box both have working sshd — picking one path.

`OPEN Q:` ACL tags and node-key signing — does each appliance get its own ACL group, or do they all share `tag:mailbox-appliance`?

---

## 3. Docker Compose stack bring-up

**Goal:** All 8 services healthy with version pins per CLAUDE.md "Service topology" table.

Services (per CLAUDE.md): `postgres`, `qdrant`, `ollama`, `n8n` (1.123.35 pinned per DR-17), `caddy`, `mailbox-dashboard`, `mailbox-migrate`. Operator shell access is via Tailscale SSH only — `ttyd` was removed 2026-05-01 per STAQPRO-126/182.

- [ ] `git clone https://github.com/UMB-Advisors/mailbox.git ~/mailbox`
- [ ] Copy `.env.example` → `.env`, fill secrets (see §4–§9 for each)
- [ ] `docker compose --profile migrate run --rm mailbox-migrate` (run migrations before app boot)
- [ ] `docker compose up -d --remove-orphans`
- [ ] `docker compose ps` — all services Healthy or Up
- [ ] Pull models inside Ollama container: `qwen3:4b-ctx4k` (custom 4096 ctx Modelfile per DR-18) + `nomic-embed-text:v1.5`
- [ ] n8n: import workflow JSONs (`n8n/MailBOX*.json`) + activate parent workflow only

`TODO:` Capture the exact Modelfile used to build `qwen3:4b-ctx4k` from `qwen3:4b`. Should live in `n8n/` or a new `models/` dir.

`TODO:` Document n8n credential setup — Postgres + Gmail OAuth + Ollama + Anthropic. Credentials go through n8n UI; capture screenshots or step list.

`TODO:` Activation gotcha — CLAUDE.md notes that sub-workflows invoked via `executeWorkflowTrigger` should have `active: false`. Capture the activation matrix (parent active, sub-workflows inactive).

---

## 4. Customer GCP project (Pub/Sub + OIDC + billing)

**`STALE:`** Original scope assumed Pub/Sub push ingress. **DR-22 KILLED 2026-04-30** — current ingress is Schedule trigger (5 min) + Gmail Get polling. No Pub/Sub topic, no OIDC service account, no public webhook for Gmail to push to.

**Decision required before writing v0.2.0:** drop this section entirely, or keep a thin GCP-project section just for the Anthropic billing alarm precedent? Default = drop; revisit if we ever re-introduce push.

If section is dropped, redirect §4 of the scope checklist into §9 (Anthropic key provisioning) and §10 (handoff/monitoring).

`OPEN Q:` Confirm with Eric that GCP project is no longer customer-side dependency. If true, this also simplifies pre-flight inventory.

---

## 5. Customer DNS + Cloudflare API token

**Goal:** `<subdomain>.<customer>.com` resolves to the appliance's public path; Caddy can complete DNS-01 challenge.

- [ ] Customer delegates `mailbox.<customer-domain>` (or chosen subdomain) to Cloudflare zone we control, OR keeps zone in their Cloudflare and creates a scoped token
- [ ] Cloudflare API token scope: **Zone → DNS → Edit** for the specific zone only (not account-wide)
- [ ] Token stored in `.env` as `CLOUDFLARE_API_TOKEN`
- [ ] DNS A/AAAA record points at appliance's public IP (or Tailscale Funnel endpoint, TBD)

`OPEN Q:` Public surface — customer #1 uses `mailbox.heronlabsinc.com` resolving to a public IP. Is customer #2 same model, or are we moving to Tailscale Funnel for cert + public access? Major architecture branch — decide before §5 walkthrough capture.

`TODO:` Record exact Cloudflare token-create UI clicks (token templates change; screenshot once and version).

---

## 6. Caddy bring-up + cert issuance

**Goal:** `https://<domain>/dashboard/queue` returns 200 (with basic_auth) using a valid Let's Encrypt cert via DNS-01.

- [ ] `Caddyfile` populated with customer domain
- [ ] `MAILBOX_BASIC_AUTH_HASH` set in `.env` — **escape every `$` to `$$`** (CLAUDE.md `.env` escaping note; bcrypt hash silently truncates otherwise)
- [ ] `docker compose up -d caddy`
- [ ] Tail logs for cert acquisition: `docker logs caddy -f` — look for "certificate obtained successfully"
- [ ] Verify from workstation: `curl -u user:pass https://<domain>/dashboard/queue` → 200
- [ ] Verify auth gate works on **all paths** including `/webhook/*` (STAQPRO-161 closed the bypass; regression-check it on every appliance)

`TODO:` First-cert-issuance can take 60–120s. Document expected log lines so a customer-side install session doesn't panic at the 30s mark.

`TODO:` Document cert renewal failure mode (Risk R1 in project description; tracked under STAQPRO-166).

---

## 7. Gmail OAuth + watch registration + historyId bootstrap

**Goal:** n8n's Gmail credential is authorized; the polling Schedule trigger picks up new mail every 5 min.

**`STALE:`** Original scope said "watch registration + historyId bootstrap." Those are the Gmail Push API artifacts that DR-22 retired. Current architecture is **Schedule trigger (5 min) + Gmail Get** — no `users.watch()` call, no historyId tracking. Replace this section with:

- [ ] Customer Workspace admin grants OAuth scopes to our Cloud project's OAuth client (scopes: `gmail.readonly`, `gmail.send`, `gmail.modify` — verify against current node)
- [ ] In n8n UI → Credentials → Gmail OAuth2 → "Connect" → complete OAuth dance
- [ ] Test credential against `Gmail Get` node — fetches latest 1 message
- [ ] Activate parent `MailBOX` workflow (Schedule trigger fires every 5 min)
- [ ] Verify first poll cycle: `docker logs n8n --tail 100` shows successful Gmail Get
- [ ] Empty-cycle behavior — CLAUDE.md notes `Insert Inbox (skip dupes)` with no Gmail returns produces an empty `$json` that fires `Run Classify Sub` once; harmless `Load Inbox Row` error is expected on idle 5-min cycles

`OPEN Q:` OAuth client — single Glue Co OAuth client used across customers, or per-customer client?

`TODO:` Document Google's "verified app" status of our OAuth client. Affects whether each new customer sees a scary "unverified" warning during consent.

---

## 8. Smoke test: full pipeline loop

**Goal:** Send a real email to the customer's connected inbox, see it appear in the approval queue, approve it, see the reply land in the original sender's inbox.

Steps:
- [ ] Send test email from a known external account (e.g. `provisioning-test@umbadvisors.com`) to the customer's connected Gmail
- [ ] Wait ≤ 5 min (next Schedule trigger fire)
- [ ] Verify in Postgres: `SELECT classification, draft_source, status FROM mailbox.drafts ORDER BY created_at DESC LIMIT 5;`
- [ ] Verify in dashboard: draft visible at `https://<domain>/dashboard/queue`
- [ ] Click Approve
- [ ] Verify reply received at sender mailbox within ~30s
- [ ] Verify final state: `status='sent'` in `mailbox.drafts`

Latency budget reminders (PRD §3.5): inbound → draft in queue ≤ 30s local / ≤ 60s cloud. **Note:** Schedule polling adds up to 5 min wait before the 30s/60s budget starts.

`TODO:` Build a `scripts/provisioning-smoke.sh` that automates the Postgres assertion. Existing `scripts/smoke-test.sh` is infra-only per CLAUDE.md, doesn't exercise the pipeline (STAQPRO-133 will close the deeper test gap).

---

## 9. Anthropic key provisioning (pooled UMB key)

**Goal:** Cloud-route drafts work. Currently default cloud path is **Ollama Cloud `gpt-oss:120b`** (per 2026-04-30 pivot superseding DR-23). Anthropic Haiku 4.5 is config-ready alt-cloud.

- [ ] Allocate appliance an `OLLAMA_CLOUD_API_KEY` slot from the pooled UMB Ollama Cloud account
- [ ] Set `OLLAMA_CLOUD_API_KEY` and `OLLAMA_CLOUD_MODEL=gpt-oss:120b` in `.env`
- [ ] (Optional alt-cloud) Set `ANTHROPIC_API_KEY` if customer prefers Haiku — currently commented out in `.env.example`
- [ ] Restart `mailbox-dashboard` so the draft route picks up env
- [ ] Verify cloud route: send an email matching `CLOUD_CATEGORIES` (`escalate`, `unknown`) and confirm `drafts.draft_source='cloud'`, `drafts.model='gpt-oss:120b'`

`TODO:` Billing model — customer is billed via Glue Co at cost + 20% per PRD. Document the meter source (assume `dashboard/app/api/system/status/route.ts` cloud spend meter from STAQPRO-146 covers display, but billing extraction TBD).

`OPEN Q:` Per-customer key isolation vs pooled key with usage tagging — current state is pooled; do we ever need per-customer for chargeback clarity?

---

## 10. Handoff checklist

**Goal:** Customer knows what they have, what they see, and what to do when something looks wrong. Glue Co knows what we monitor.

### What the customer sees / can do
- [ ] Approval queue URL + basic auth credentials (delivered out-of-band, e.g. 1Password vault share)
- [ ] How to approve / reject / edit a draft
- [ ] How to escalate (Slack channel? Email? Phone?)
- [ ] Expected polling cadence (5 min) — sets expectation that draft appearance isn't instant
- [ ] What "spam_marketing" classification does (silently drops — they won't see it)

### What we (Glue Co) monitor
- [ ] Tailscale device shows online
- [ ] `docker compose ps` all-green check (frequency: TBD, see STAQPRO-166 risk owners)
- [ ] Cert renewal status (Risk R1)
- [ ] Anthropic / Ollama Cloud spend (STAQPRO-146 status page surfaces this)
- [ ] Postgres free space + `mailbox.drafts` row count growth
- [ ] Classification accuracy spot-checks — sample N drafts/week, judge correctness

### Documentation to deliver to customer
- [ ] Operator quick-start (1-page PDF — TBD)
- [ ] Privacy guarantee statement (per PRD: all email content stays local)
- [ ] Support contact + SLA expectations

`TODO:` Decide who carries the pager for which signal. Most of these tie back to STAQPRO-166 (risk/SM owners). Cross-link the runbook to that issue's eventual owner table.

`OPEN Q:` SLA — what's the customer-facing response-time commitment? Not in PRD §3.5.

---

## Appendices

### A. Time-to-provision target

Per STAQPRO-163 acceptance criteria, this is a baseline metric to record on first-reproduction.

`TODO:` Stopwatch the customer #2 install. Capture wall-clock total + per-section subtotals. Bake the number into v0.2.0.

### B. Reference docs

- `Install Guide/Install.md` — flash + first-boot script (covers part of §1)
- `CLAUDE.md` "Service topology" table — service version pins
- `.env.example` — secret inventory
- `docker-compose.yml` — service definitions
- PRD §3.5 — power, latency, boot-time budgets
- DR-17 (n8n pin), DR-18 (Qwen3-4B 4k ctx), DR-22 (Pub/Sub KILLED), DR-24 (Next.js dashboard) — see CLAUDE.md "Active decision records"

### C. Known gotchas (CLAUDE.md "Conventions" lift-and-shift)

- `.env` bcrypt hashes need `$` → `$$` escaping
- n8n sub-workflows that run via `executeWorkflowTrigger` should be `active: false`
- `docker compose restart caddy` for config changes — NOT `caddy reload` (admin API stale-config trap)
- Empty 5-min poll cycles produce a benign `Load Inbox Row` error — don't panic
