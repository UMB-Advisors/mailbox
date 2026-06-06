# AgentBOX — JetPack 7.2 / CUDA 13 Reproduction Runbook

> **Created:** 2026-06-06
> **Status:** v0.1.0 — first JP7.2 bring-up validated on `agentbox2`
> **Relates to:** `scripts/agentbox-install.sh`, `docs/addendum-agentbox-solo-hermes-mailbox-v0_1-2026-05-31.md` (architecture lock, SM-97), `docker-compose.override.yml`, `scripts/systemd/`

## TL;DR

`agentbox-install.sh` (STAGE 0–6) ports cleanly to JetPack 7.2 / L4T r39.2 / CUDA 13 with **no code changes** — the stack is stock multi-arch images + Ollama, all of which run on r39. The work that was previously **manual/TODO** (STAGE 7 Hermes+gbrain, STAGE 8 boot-to-ready systemd) is now captured here and as committed artifacts (`scripts/systemd/*.service`). The unified `:9119` appliance was reproduced fresh on `agentbox2` and matches the `agentbox1` ground truth, on JP7.2.

## Ground-truth BOM (what a green AgentBOX runs)

- **Docker stack** (`docker compose up -d postgres qdrant ollama n8n mailbox-dashboard`, via `agentbox.service`): `postgres:17-alpine`, `qdrant:v1.17.1`, `ollama` (qwen3:4b-instruct + `qwen3:4b-ctx4k` + `nomic-embed-text:v1.5`), `n8nio/n8n:2.14.2`, `mailbox-dashboard:local`. Loopback ports published by `docker-compose.override.yml`: dashboard `:3001`, ollama `:11435`.
- **Hermes agent** (native, not containerized): **v0.15.1**, `~/.local/bin/hermes`, model `qwen3:4b-instruct` via provider `custom:local-qwen3-4b` → `http://127.0.0.1:11435/v1`, cloud fallback OpenRouter/OpenAI. Web dashboard on **`:9119`** via `hermes-dashboard.service`.
- **gbrain** memory MCP: `~/gbrain-src` (v0.41.x) run by bun, `GBRAIN_HOME=~/.hermesbox`, pglite engine, embeddings `ollama:nomic-embed-text` (768d) via the host Ollama `:11434`. Wired into Hermes as the `gbrain` MCP server.

## JP7.2 / CUDA 13 deltas from JP6 (validated)

| Item | JP6 (agentbox1) | JP7.2 (agentbox2) | Action |
|---|---|---|---|
| Docker + nvidia runtime | preinstalled | preinstalled, but **runtime not registered** | `sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker` |
| docker group | — | UMB not in `docker` group | `sudo usermod -aG docker $USER` (new login applies) |
| CUDA-in-container | works | works after runtime registered | verify: `docker run --rm --runtime nvidia ubuntu:24.04 nvidia-smi -L` |
| Stack images | multi-arch | identical, pull on r39 | none |
| Hermes 64K floor | n/a (0.15.1) | **0.16.0 enforces ≥64K ctx** → rejects local qwen | **pin Hermes to 0.15.1** (see below) |

## Reproduction steps

### 1. Base (one-time)
```
sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker
sudo usermod -aG docker "$USER"   # re-login
docker run --rm --runtime nvidia ubuntu:24.04 nvidia-smi -L   # expect: GPU 0: Orin (nvgpu)
```

### 2. App (STAGE 0–6) — the installer
```
git clone <mailbox> ~/mailbox && cd ~/mailbox && git checkout feat/agentbox-unified
scripts/agentbox-install.sh --prototype     # bench: throwaway secrets, skips caddy
```
**Dashboard build caveat:** STAGE 5 runs `docker compose up -d --build mailbox-dashboard`, which needs a **real** `GITHUB_PACKAGES_TOKEN` (read:packages on `@umb-advisors`) for `npm ci`. `.env.example` ships a placeholder, so a bench build fails `npm E401`. Either export a live token before running, or load a prebuilt image and skip the build:
```
# from a box that already has it:
ssh <src> 'docker save mailbox-dashboard:local | gzip' | ssh <dest> 'gunzip | docker load'
# then bring it up without --build:
docker compose up -d mailbox-dashboard n8n
```

### 3. Agent (STAGE 7–8) — previously manual, now scripted artifacts
**Hermes (pin 0.15.1):**
```
# install via NousResearch installer, then pin to the 0.15.1 ref:
cd ~/.hermes/hermes-agent && git fetch --tags && git checkout 927fa7a98 && uv sync
hermes --version   # Hermes Agent v0.15.1
```
Config: copy a working `~/.hermes/config.yaml` (model `qwen3:4b-instruct`, provider `custom:local-qwen3-4b` → `:11435`, gbrain MCP, fallbacks). The `:9119` dashboard needs a pre-built web dist; on a same-ref box: `tar -C ~/.hermes/hermes-agent/hermes_cli -czf - web_dist | ssh <dest> 'tar -C ~/.hermes/hermes-agent/hermes_cli -xzf -'` (or drop `--skip-build` once to build).

**gbrain:**
```
# bun preinstalled (1.3.14); deploy gbrain-src + a global wrapper:
printf '#!/usr/bin/env bash\nexec bun "$HOME/gbrain-src/src/cli.ts" "$@"\n' > ~/.bun/bin/gbrain && chmod +x ~/.bun/bin/gbrain
# fresh brain at ~/.hermesbox/.gbrain (pglite, ollama:nomic-embed-text 768d):
ollama pull nomic-embed-text   # into the HOST ollama (:11434)
GBRAIN_HOME=~/.hermesbox bun ~/gbrain-src/src/cli.ts apply-migrations --yes --non-interactive
hermes mcp list   # gbrain ✓ enabled
```

**Boot-to-ready (STAGE 8):** install the committed units and enable linger:
```
sudo loginctl enable-linger "$USER"
cp scripts/systemd/{agentbox,hermes-dashboard}.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now agentbox.service hermes-dashboard.service
```

## Verify
```
systemctl --user is-active agentbox.service hermes-dashboard.service   # active active
docker compose ps                                                      # 5 healthy
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:9119/        # 200
hermes -z 'Reply with one word: BANANA' --yolo --accept-hooks          # BANANA
hermes mcp list                                                        # gbrain ✓ enabled
```
View the dashboard from a tailnet client (loopback-bound by design):
`ssh -L 9120:127.0.0.1:9119 UMB@<box>` → http://localhost:9120

## Remaining (operator / fresh-state, not bench-automatable)
- Gmail OAuth (browser consent, per inbox); n8n credential re-link + workflow activation; qdrant collection bootstrap (its npm tool also needs a live token); OpenRouter/OpenAI fallback keys in `.env`.
- Rotate the appliance login/sudo password off the `admin` default.
- `hermes-gateway.service` (messaging) if Telegram/Discord/etc. are wanted.

## Open follow-ups for the installer (not yet automated)
- STAGE 5: add a `--skip-dashboard-build` / `DASHBOARD_IMAGE` path so a pre-loaded image is used without `--build` (avoids the token requirement on bench/offline installs).
- STAGE 7/8: fold the Hermes 0.15.1 pin + config + gbrain bootstrap + systemd-unit install into the installer so they're no longer manual.
