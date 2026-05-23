# Runbook — OpenShell + NemoClaw on Jetson Orin (cloud inference)

**For:** MBOX-291 (M0 spike) → feeds the M4 golden image (Task 5).
**Target:** Jetson Orin Nano Super 8GB, JetPack 6.2.x / L4T R36.5, kernel 5.15-tegra, Docker + nvidia runtime.
**Inference:** CLOUD only (NVIDIA NIM) — no local LLM.
**Reviewed against:** NemoClaw installer `nvidia.com/nemoclaw.sh`, `scripts/install.sh`, `scripts/setup-jetson.sh` (all on `main`), and the **vendored** `scripts/openclaw/fix-iptables-jetson.sh` (from closed PR #560).

> **Reality on OpenShell 0.0.44 (reproduced 2026-05-22, MB2):** the iptables/k3s gateway crash (#404/#539) does **NOT** occur — `fix-iptables-jetson.sh` is **not needed**. The actual blocker is **glibc**: 0.0.44's `openshell-gateway`/`openshell-sandbox` need glibc 2.39, JetPack 6.2 ships 2.35. The gateway self-heals (runs in an `ubuntu:24.04` compat container) but the **sandbox bind-mount breaks** → apply `scripts/openclaw/fix-sandbox-mount-jetson.sh` (step 4). Full details + the durable Ubuntu-24.04 recommendation: `docs/spike-m0-openshell-jetson-gateway-v0_1-2026-05-22.md`.

---

## 0. Prerequisites (verified on MB2, 2026-05-22)

- Docker up, user in `docker` group, `nvidia` runtime present (`docker info | grep -i runtime`).
- `grep -c nft_chain_nat /proc/modules` → `0` (the gap that breaks the gateway).
- Host `iptables` already resolves to `xtables-legacy-multi` (host fine; container is the issue).
- Passwordless sudo available (needed for `setup-jetson`).
- Recommended: a modest swap (≈4 GB) as OOM insurance during sandbox image import (MBOX-293). Low risk with cloud inference, cheap.

## 1. Pin the version

Don't float `latest` — the patched gateway is an unsupported config a future release could break.
Record the resolved tag/commit and pin it:

```bash
export NEMOCLAW_INSTALL_TAG=<tag>     # default 'latest' resolves to the newest release tag
```

## 2. Install NemoClaw (user-local; no sudo; nvm + npm)

```bash
# installer clones NemoClaw@TAG → runs scripts/install.sh → installs Node via nvm + NemoClaw via npm
curl -fsSL https://www.nvidia.com/nemoclaw.sh | NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 bash
# the installer then proceeds to onboard — see step 4 for the Jetson crash/patch loop
```

## 3. Host prep (Jetson)

```bash
sudo nemoclaw setup-jetson      # or: sudo bash <repo>/scripts/setup-jetson.sh
# loads br_netfilter, sets net.bridge.bridge-nf-call-iptables=1, persists via
# /etc/modules-load.d/nemoclaw.conf + /etc/sysctl.d/99-nemoclaw.conf
```

## 4. Onboard → sandbox-mount fix → re-onboard (the real JetPack-6.2 loop)

Inference (NVIDIA NIM cloud) is configured **at onboard time via env** — provider value is **`build`** (not `nvidia-nim`), key env **`NVIDIA_API_KEY`**, default model `nvidia/nemotron-3-super-120b-a12b`. The gateway comes up fine (in an `ubuntu:24.04` compat container); the **first sandbox start fails** on the glibc compat-mount bug, so apply the fix and re-onboard.

```bash
export PATH="$HOME/.local/bin:$PATH"; . "$HOME/.nvm/nvm.sh"; nvm use 22
export NEMOCLAW_PROVIDER=build NVIDIA_API_KEY=<nvapi-key> NEMOCLAW_POLICY_TIER=balanced NEMOCLAW_NON_INTERACTIVE=1

# 1st onboard: gateway up, sandbox image builds (~5 min), then sandbox START fails:
#   exec "/opt/openshell/bin/openshell-sandbox": is a directory
nemoclaw onboard --non-interactive --yes-i-accept-third-party-software --yes || true

# fix the host-side bind-mount source (materialize the staged sandbox binary)
sudo bash scripts/openclaw/fix-sandbox-mount-jetson.sh nemoclaw-openshell-gateway

# re-onboard (build cached → fast): sandbox starts, dashboard :18789 live
nemoclaw onboard --non-interactive --yes-i-accept-third-party-software --yes
```

> `fix-iptables-jetson.sh` is **NOT needed** on OpenShell 0.0.44 (no iptables/k3s crash). It's kept vendored only as a fallback for older OpenShell.
> Use `nemoclaw onboard` to (re)create the gateway/sandbox — **not** `openshell gateway start --recreate` directly (detaches OpenShell from NemoClaw management).

## 5. Cloud inference — NVIDIA NIM (Task 3)

Inference is already set by step 4's `NEMOCLAW_PROVIDER=build` + `NVIDIA_API_KEY`. Verify the round-trip:

```bash
# direct NIM check (proves key+model+endpoint) — returns HTTP 200 with a completion
python3 - <<'PY'
import urllib.request, json, os
body=json.dumps({"model":"nvidia/nemotron-3-super-120b-a12b",
  "messages":[{"role":"user","content":"ping"}],"max_tokens":16}).encode()
req=urllib.request.Request("https://integrate.api.nvidia.com/v1/chat/completions", data=body,
  headers={"Authorization":"Bearer "+os.environ["NVIDIA_API_KEY"],"Content-Type":"application/json"})
r=urllib.request.urlopen(req,timeout=90); print("HTTP",r.status, json.load(r)["model"])
PY
# end-to-end via the agent: open the dashboard at http://127.0.0.1:18789/ and chat,
# or `nemoclaw my-assistant dashboard-url --quiet` for an authenticated URL.
# To change model/provider later: nemoclaw inference set --model <m> --provider build --sandbox my-assistant
```

> The default NIM model `nvidia/nemotron-3-super-120b-a12b` is a **reasoning** model (emits chain-of-thought). Fine for round-trip validation; for the drafting path, handle/strip reasoning or pick a non-reasoning NIM model.

## 6. Verify (Done-when)

- NemoClaw dashboard reachable at `127.0.0.1:18789`, OpenShell gateway at `127.0.0.1:8080`.
- Gateway stays up (no k3s `RULE_INSERT` crash-loop) — the core residual-risk check.
- Cloud round-trip returns a completion.
- Record RAM/disk overhead (should be comfortable on 8GB without a local model).

## Rollback / teardown

```bash
nemoclaw <name> stop 2>/dev/null || true
<repo>/uninstall.sh        # ships on main
docker ps -a; docker images   # confirm clean
```

## Open items

- Confirm exact NIM key env var / `inference set` flags at run time (provider may want NGC key vs build.nvidia.com key).
- Read *why* PR #560 was closed before M1 commits to vendoring (rejected approach vs deprioritized).
- For M4: bake the patched gateway image + pinned versions into the golden image so the crash/patch loop is build-time, not first-boot.
