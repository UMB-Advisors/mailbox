# Runbook — OpenShell + NemoClaw on Jetson Orin (cloud inference)

**For:** MBOX-291 (M0 spike) → feeds the M4 golden image (Task 5).
**Target:** Jetson Orin Nano Super 8GB, JetPack 6.2.x / L4T R36.5, kernel 5.15-tegra, Docker + nvidia runtime.
**Inference:** CLOUD only (NVIDIA NIM) — no local LLM.
**Reviewed against:** NemoClaw installer `nvidia.com/nemoclaw.sh`, `scripts/install.sh`, `scripts/setup-jetson.sh` (all on `main`), and the **vendored** `scripts/openclaw/fix-iptables-jetson.sh` (from closed PR #560).

> **Why the manual patch:** the gateway-image iptables-legacy fix (PR #560) was **closed unmerged**. `setup-jetson.sh` (on main) handles host `br_netfilter`/sysctl, but **not** the gateway container's `iptables-nft → legacy` swap. On Jetson, k3s runs *inside* the gateway container, so a host-level fix can't help it — the image must be rebuilt. See `docs/spike-m0-openshell-jetson-gateway-v0_1-2026-05-22.md`.

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

## 4. Onboard → gateway crash → patch → re-onboard (the Jetson loop)

`nemoclaw onboard` starts the OpenShell gateway (k3s in a container). On Jetson the **first** start crashes
on `RULE_INSERT failed` because the gateway image uses `iptables-nft`. Patch the now-cached image, then re-onboard.

```bash
# first onboard attempt (non-interactive); gateway will crash on Jetson
NEMOCLAW_POLICY_TIER=balanced \
  nemoclaw onboard --non-interactive --yes-i-accept-third-party-software || true

# patch the crashed gateway image in place (re-tags same name → next start uses it)
sudo bash scripts/openclaw/fix-iptables-jetson.sh nemoclaw

# re-onboard — recreates the gateway from the patched local image
NEMOCLAW_POLICY_TIER=balanced \
  nemoclaw onboard --non-interactive --yes-i-accept-third-party-software
```

> Use `nemoclaw onboard` to (re)create the gateway/sandbox — **not** `openshell gateway start --recreate` directly (per upstream warning; doing so detaches OpenShell from NemoClaw management).

## 5. Cloud inference — NVIDIA NIM (Task 3)

```bash
# provider + key (NIM key from build.nvidia.com / NGC) — exact flag/env confirmed at run time
openshell inference set --provider nvidia-nim --api-key "$NVIDIA_NIM_API_KEY" --model <nim-model>
# round-trip test
bash scripts/test-inference.sh         # (ships on main) or a direct gateway prompt
```

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
