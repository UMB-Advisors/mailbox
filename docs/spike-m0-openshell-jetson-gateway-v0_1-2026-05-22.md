# M0 Spike — OpenShell-on-Jetson + Gateway Verification

**Issue:** [MBOX-291](https://linear.app/staqs/issue/MBOX-291) (epic [MBOX-290](https://linear.app/staqs/issue/MBOX-290), gate [MBOX-292](https://linear.app/staqs/issue/MBOX-292))
**Version:** v0.2 — 2026-05-22 (added empirical reproduction on MB2)
**Rig:** MB2 (`mailbox.staqs.io`, `192.168.50.11`), repurposed from the live MailBOX appliance
**Status:** Task 1 complete. Tasks 2–4 reproduced on MB2 — **gateway up & stable; sandbox blocked by a glibc mismatch (new finding).** See "Empirical reproduction" below.

> **Headline update (2026-05-22 reproduction):** The iptables/k3s gateway crash (#404/#539) **did NOT reproduce** on current OpenShell 0.0.44 — the gateway came up healthy on `:8080`. Instead, a **different Jetson blocker** surfaced: OpenShell 0.0.44's dynamically-linked `openshell-gateway`/`openshell-sandbox` binaries require **glibc 2.39**, but JetPack 6.2 ships **glibc 2.35**. The gateway works around this (runs in an `ubuntu:24.04` compat container) but the **sandbox fails to start** (`exec openshell-sandbox: is a directory`), so the dashboard (`:18789`) never comes up. **This empirically confirms the "pin the version, don't float `latest`" recommendation.**

---

## TL;DR

- **The upstream gateway bug is NOT fixed (as of 2026-05-23).** NemoClaw #404 and #539 were both closed 2026-04-13 as *roadmap consolidation* ("Jetson/Orin support is on our roadmap; closing to consolidate") — **not** as fixed. The one PR that actually implemented the fix, **#560 (iptables-legacy gateway patch), is closed and was never merged.** No merged Jetson/iptables/tegra PR exists in NemoClaw (latest tag `v0.0.49`) or OpenShell (latest `v0.0.47`, repo pushed 2026-05-23).
- **Consequence:** the manual **`iptables-legacy` cluster-image patch, applied pre-onboarding, remains mandatory.** It is the community known-good path, not an upstream-supported configuration.
- **This does NOT trip the kill criteria.** ClawBox (€549, Orin Nano Super 8GB) ships a commercially working OpenClaw-on-Orin box, and JetsonHacks (2026-03-25) + the Cytron Definitive Guide document the patched path working. The gateway comes up **with** the patch.
- **Leaning recommendation:** **full OpenShell (preferred)**, with the iptables-legacy patch baked into our M4 golden image and OpenShell/NemoClaw **version-pinned**, accepting upstream-unsupported status until NVIDIA lands official Jetson support. Final go/no-go is MBOX-292's call after Tasks 2–4 reproduce it on MB2.

---

## Task 1 — Upstream status check (complete)

### Is the gateway issue (#404/#539) fixed?

**No.** Evidence:

| Artifact | State | What it tells us |
|---|---|---|
| [NemoClaw #404](https://github.com/NVIDIA/NemoClaw/issues/404) — "GPU detection fails, k3s panics on iptables" | **Closed 2026-04-13** (`state_reason=completed`, but maintainer comment = consolidate-to-roadmap) | Tracking issue closed as "on our roadmap," not fixed. Documents GPU `[N/A]` unified-memory detection + the nf_tables/legacy mismatch. |
| [NemoClaw #539](https://github.com/NVIDIA/NemoClaw/issues/539) — "OpenShell gateway crashes due to missing nf_tables NAT kernel modules" | **Closed 2026-04-13** | Same root cause as #404; closed to consolidate. Env: kernel 5.15.185-tegra, NemoClaw 0.1.0, OpenShell CLI 0.0.12. |
| [NemoClaw PR #560](https://github.com/NVIDIA/NemoClaw/pull/560) — "detect Jetson nf_tables gap and patch gateway image with iptables-legacy" | **Closed, NOT merged** | The actual fix — `isJetson()` / `hasNfTablesNatSupport()` in `platform.js`, two-pass gateway start, `fix-iptables-jetson.sh` rebuilding the image with `iptables-legacy`, `nemoclaw setup-jetson` CLI — was abandoned/closed without merging. **This is the decisive fact.** |
| NemoClaw PRs matching jetson/gateway | None merged that address the nf_tables crash | PR #4008 ("use NVIDIA runtime for Jetson sandbox GPU") is open and is about GPU runtime, not the iptables gateway crash. |
| OpenShell repo (`NVIDIA/OpenShell`) | latest tag `v0.0.47`, pushed 2026-05-23 | No merged Jetson/iptables-legacy gateway fix. Matching gateway PRs are Podman detection / macOS host-gateway / auth / docs — none address the Tegra nf_tables gap. |

> **Follow-up before M1 implements the patch:** read *why* PR #560 was closed (rejected approach vs. deprioritized). Its approach is sound and reproducible regardless; this only affects whether we mirror its `setup-jetson` UX or roll our own.

### Root cause (confirmed)

The OpenShell gateway container ships iptables v1.8.10 in **nf_tables** mode. The Tegra 5.15 kernel (`5.15.185-tegra`) lacks `nft_chain_filter` and the nf_tables NAT modules (`/lib/modules/5.15.185-tegra` has no `nft*`). With host networking, the container's `iptables-nft` hits the host kernel, which only has the legacy NAT tables → k3s network-policy controller panics immediately:

```
iptables v1.8.10 (nf_tables): RULE_INSERT failed (No such file or directory)
```

### The fix (mandatory manual patch)

Patch the OpenShell **cluster image** to use `iptables-legacy` **before onboarding**:

```sh
update-alternatives --set iptables  /usr/sbin/iptables-legacy
update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy
```

…baked into the cluster-image entrypoint (run before `exec k3s`). The community install scripts build a patched local OpenShell cluster image, then onboard. Host-side persistence helpers:

```sh
sudo modprobe br_netfilter
sudo sysctl -w net.bridge.bridge-nf-call-iptables=1
```

### Latest versions on Orin

- **NemoClaw:** latest tag `v0.0.49` (issue env showed NemoClaw 0.1.0 / OpenShell CLI 0.0.12 in March; both have moved up).
- **OpenShell:** latest tag `v0.0.47` (+ a `vm-runtime` tag); repo actively pushed (2026-05-23).
- **MBOX-291 baseline cites OpenShell 0.0.13 known-good** — we should pin to a *tested* version on our golden image rather than chase `latest`, given the patch is an unsupported config that a future release could break.

### Official Jetson NemoClaw release?

**No official Jetson release.** Jetson/Orin is "on the roadmap" per the maintainer. NemoClaw was announced at GTC 2026 (2026-03-16) as an **alpha-stage** stack (OpenClaw + Nemotron access + the OpenShell runtime: kernel-level sandboxing, out-of-process policy enforcement, privacy-aware model routing). Jetson support today is community-driven (JetsonHacks "three commands," Cytron guide, NVIDIA forum 364315, johnnynunez HackMD).

### What does ClawBox ship?

[ClawBox](https://openclawhardware.dev/faq) (openclawhardware.dev, €549) — the competitive benchmark and existence proof:

- NVIDIA Jetson Orin Nano Super 8GB, 67 TOPS, 512GB NVMe, carbon-fiber case, PSU, ~20W (≤25W heavy), OpenClaw pre-installed, 90-day email support + Discord + free SW updates.
- Ships **local** models (Llama 3.1 8B ~15 tok/s, CodeLlama 7B, Hermes 3 8B, LLaVA 7B). **Note:** this is the *local-inference* product — **our box is cloud-inference**, so their model list is not our config; ClawBox matters only as proof the Orin-Nano-Super-8GB target is commercially viable and as the price/positioning benchmark.
- "5-minute setup" (plug power+ethernet, scan QR). That convenience is exactly our GTM thesis (convenience + cost) per MBOX-290.

---

## Resource expectation (Task 4 pre-read)

With **cloud inference and no local LLM**, the 8GB unified-RAM memory risk that dominated the MailBOX build is gone. NemoClaw/OpenShell + k3s + the sandbox runtime should sit comfortably on 8GB. MBOX-293 calls for a modest swap (≈4GB) as cheap insurance against OOM during sandbox image imports at onboarding. Actual RAM/disk numbers to be recorded during the MB2 reproduce.

---

## Recommendation (provisional — confirm at MBOX-292 gate)

**Full OpenShell (preferred)** with:
1. `iptables-legacy` patch baked into the cluster image (M4 golden image), applied pre-onboarding.
2. OpenShell + NemoClaw **pinned** to the version we reproduce + verify on MB2 (do not float `latest` — the patch is an unsupported config).
3. Track upstream Jetson support; drop the manual patch once NVIDIA lands an official fix.

**Fallbacks** (only if MB2 reproduce shows the gateway is unstable *even with* the patch): T2-lite Docker isolation, then T3 pivot (AGX Orin 64GB). Low likelihood given ClawBox + community success.

---

## Empirical reproduction (2026-05-22, MB2)

**Versions installed:** NemoClaw `0.1.0` (git `29ee14d`, `latest`), OpenShell CLI **`0.0.44`**, Node `22.22.3` (nvm), Docker w/ nvidia runtime, default cloud model `nvidia/nemotron-3-super-120b-a12b`.

**What worked:**
- Installer (`scripts/install.sh`) ran clean — nvm Node, NemoClaw CLI built from source, OpenShell 0.0.44 to `~/.local/bin`, `setup-jetson.sh` applied host `br_netfilter`.
- Host prereqs (done manually via passwordless sudo): `nvidia-ctk cdi generate` → `nvidia.com/gpu` CDI spec; +4 GB swap.
- Provider value for cloud NVIDIA NIM is **`build`** (NOT `nvidia-nim`) → `integrate.api.nvidia.com/v1`, key env **`NVIDIA_API_KEY`**, `skipVerify:true`. `NEMOCLAW_PROVIDER=build` cleared onboarding.
- **OpenShell gateway: UP & healthy on `:8080`** (`openshell_server: Server listening 0.0.0.0:8080`, NIM credential-refresh worker running). **No `RULE_INSERT`/nf_tables/k3s crash.** ⇒ The #404/#539 gateway bug does not manifest on 0.0.44.
- Gateway inference configured for NIM. Sandbox **image** built (~294 s).

**What blocked (new finding — glibc, not iptables):**
- Host glibc **2.35** (JetPack 6.2 / Ubuntu 22.04). `openshell-gateway` + `openshell-sandbox` are **dynamically linked, need glibc 2.39**; only `openshell` is static.
- Gateway auto-mitigates: *"host glibc 2.35 older than openshell-gateway requirement 2.39 → running openshell-gateway inside a Docker compatibility container"* (image `ubuntu:24.04`). Gateway healthy.
- **Sandbox start fails:** `create sandbox failed: … runc create failed: exec "/opt/openshell/bin/openshell-sandbox": is a directory: permission denied`. That path is **absent from the sandbox image** → the gateway bind-mounts the host `openshell-sandbox` binary in at runtime, but the **compat-container gateway's filesystem indirection makes the mount source resolve wrong**, so Docker creates an empty dir at the target → exec fails.
- Net: gateway `:8080` ✓, but **no sandbox ⇒ dashboard `:18789` never comes up ⇒ no end-to-end NIM round-trip yet.**
- Resource note: onboard preflight flagged 7.4 GiB < 8 GiB recommended; sandbox build is slow (~5 min) but completed. Swap added as insurance.

**Revised risk read for the gate (MBOX-292):**
- The originally-feared iptables/k3s gateway bug is **not the blocker** on current OpenShell.
- The real blocker is **version coupling: OpenShell ≥ (the release that bumped to glibc 2.39) is incompatible with JetPack 6.2's glibc 2.35 at the sandbox layer.** Options: (a) **pin OpenShell/NemoClaw to a glibc-2.35-era release** (the community known-good window, ~OpenShell 0.0.13, Mar 2026) and re-test; (b) move the appliance base to a JetPack/Ubuntu-24.04 (glibc 2.39) image when available for Orin Nano; (c) fix the sandbox-binary mount under compat mode (upstream-ish).
- **Decisive next experiment:** pin an older OpenShell/NemoClaw and re-onboard — if the sandbox starts (no compat container needed), the full path is green and we just version-pin for the golden image.

## Next steps (Tasks 2–5, on MB2)

1. **Recoverable backup of MB2** — full Docker volume snapshots (postgres, n8n incl. encrypted Gmail OAuth creds, qdrant), `.env`, Caddyfile, compose; pulled to workstation; **restore verified**. (Per Dustin: MailBOX must be restorable on this or another box.)
2. **App-layer teardown** — remove the MailBOX Docker stack + any k3s/cruft; keep JetPack R36.5 (full clean flash is M1/MBOX-293).
3. **Reproduce OpenShell + NemoClaw install** with the iptables-legacy patch applied pre-onboarding (community known-good path).
4. **Cloud inference** — `openshell inference set --provider nvidia-nim …` (or Anthropic/OpenAI); confirm a round-trip. No local model.
5. **Verify gateway stability** — NemoClaw dashboard (`127.0.0.1:18789`) + OpenShell gateway (`127.0.0.1:8080`) up; record RAM/disk; capture exact patched-image build steps for the M4 golden image.

---

## Sources

- [NemoClaw #404](https://github.com/NVIDIA/NemoClaw/issues/404) · [NemoClaw #539](https://github.com/NVIDIA/NemoClaw/issues/539) · [NemoClaw PR #560](https://github.com/NVIDIA/NemoClaw/pull/560)
- [NVIDIA OpenShell repo](https://github.com/NVIDIA/OpenShell)
- [JetsonHacks — NemoClaw on Jetson Orin (2026-03-25)](https://jetsonhacks.com/2026/03/25/nemoclaw-on-jetson-orin/)
- [Cytron — Definitive Guide to NemoClaw & OpenShell on Orin Nano](https://my.cytron.io/tutorial/the-definitive-guide-to-nemoclaw--openshell-integration-on-orin-nano)
- [NVIDIA Developer Forums 364315](https://forums.developer.nvidia.com/t/nemoclaw-openshell-jetson-agx-orin-orin-super-nano-and-orin-nx/364315) · [johnnynunez HackMD](https://hackmd.io/@johnnynunez/BytcW-aqWg) · [changtimwu known-issues gist](https://gist.github.com/changtimwu/4948f56c7f46985056731f18dc5ad781)
- [NemoClaw troubleshooting docs](https://docs.nvidia.com/nemoclaw/latest/reference/troubleshooting) · [ClawBox FAQ](https://openclawhardware.dev/faq)
- [NVIDIA GTC 2026 — NemoClaw announcement](https://blogs.nvidia.com/blog/gtc-2026-news/)
