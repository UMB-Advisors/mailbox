# MBOX-417 — Hermes-on-MailBOX Feasibility Spike — Readiness Report

**Date:** 2026-05-31
**Branch:** `spike/hermes-mailbox` (draft PR #230)
**Spike plan:** `docs/spike-hermes-on-mailbox-feasibility-v0_1-2026-05-31.md`
**Harness:** `spike-hermes-mailbox/` (this dir)
**Scope of this report:** software-harness readiness only. The actual GREEN/AMBER/RED spike verdict requires the physical bench Jetson + a human rater and is explicitly **OUT OF SCOPE here.**

---

## 1. Readiness verdict (software harness)

**READY-WITH-CAVEATS.**

The harness is software-sound: all scripts parse, the data-flow paths were dry-run end-to-end, the one runtime-blocking bug (gbrain SQL selecting non-existent columns) is fixed and verified against the real schema, and the security/correctness/fidelity issues Linus flagged are patched. It can be carried to the bench and executed.

**It cannot, on its own, produce a verdict.** The headline Q1 (SM-97 memory fit) and Q2 (NC-41 draft value) outputs require:
- a **physical bench Jetson** running the production golden image with `tegrastats` (no bench = no Q1 number), and
- a **single human rater** (Dustin) doing the blind A/B (no rating = no Q2 number).

Neither is producible in this software harness. Treat any number this harness emits without those two inputs as a dry-run artifact, not a result.

---

## 2. Liotta — methodology verdict (is the spike well-designed?)

**Well-scoped, correctly gated, but two design flaws make the headline numbers untrustworthy as written. Treat the A/B as DIRECTIONAL only.**

Strengths: Q1-before-Q2 gating is correct; the bench-only / weight-free guardrails are sound; per-item 50/50 blind slot randomization is good.

Open methodology blockers (NOT fixed — these are design changes, recorded as residual risk):

| # | Issue | Effect |
|---|---|---|
| L1 | **NC-41 control arm is memory-stripped.** Arm A (`assemblePrompt`) injects NO RAG / exemplars / KB / thread; arm B (Hermes) gets gbrain voice memory. Production MailBOX *does* inject exemplars (STAQPRO-234 = "past replies you sent" = the same voice mechanism gbrain provides). | A ≥10pp B-over-A delta is the *expected artifact* of the asymmetry — can manufacture a false GREEN. Fix: arm A should call the live `/api/internal/draft-prompt`, or run 3 arms (A0 bare / A1 full-prod / B). The decision that matters is **B vs A1**, not B vs A0. |
| L2 | **S2 worst-case omits the local-draft generation spike.** The true 8GB peak is `qwen3:4b-ctx4k` mid-generation (the DR-25 138-restart / STAQPRO-342 OOM class), not a cloud turn. S2 never pins the injected inbound to a LOCAL category, so the heavy local consumer may never be resident at peak. | S2 can report comfortable headroom while production OOMs. Fix: inject a LOCAL-category inbound, realistic-length body, force-load qwen3, overlap with Hermes, sample at 100ms, sweep ≥20 traces. |
| L3 | **~40-email single-rater A/B is underpowered** for a hard ≥10pp bar (95% CI on a proportion at n≈35 is ~±16pp; the bar sits inside the noise band). No significance test, no inter-rater check, rater is the system author (expectancy bias). | The GREEN/AMBER boundary is essentially rater-variance. Fix: paired McNemar at n≈80–100, or reframe as directional; add a 2nd rater on ≥15 overlap (Cohen's kappa). |
| L4 | **≥500/200MB free bands are asserted, not derived.** `tegrastats` at 500ms under-samples sub-500ms allocator/KV-cache spikes; grepping for "OOMKilled" misses the DR-25 failure mode (CUDA alloc failures show as container restarts, not kernel OOM). | Sampler can pass a box that briefly hit zero. Fix: derive the reserve from the largest expected alloc; sample at 100ms; treat S2 container-restart count as an explicit FAIL signal; read MemAvailable, not used/total. |
| L5 | **Arm B prompt is not parity with arm A** (leaner ad-hoc prompt + `--yolo` agentic latitude). | A B win bundles 3 confounded variables (memory + leaner prompt + tooling). Fix: give arm B arm A's system-prompt scaffolding; make agentic tool-use a named separate arm. |

**Net:** fix L1 (control-arm parity) and L2 (S2 worst-case definition) before trusting any verdict.

---

## 3. Linus — code verdict + fixed vs. residual

**Verdict at review time: NEEDS WORK (3 real bugs + 1 security issue). All now FIXED in-tree (HARDEN pass) and verified.**

### Fixed (8 changes across 6 files)

| File | Fix |
|---|---|
| `21-gbrain-bootstrap.sh` | **[BLOCKER]** SELECT now uses real `sent_history` columns: `draft_id AS id, to_addr AS recipient, draft_sent AS body, ...` (was `message_id/recipient/body` — none exist). Also path (B) now pipes JSON via stdin, not inline `"$line"`. |
| `draft-prompt.mjs` | **[BLOCKER]** Restored control-arm fidelity to `prompt.ts`: added missing 3rd BAD/GOOD lead-time example + full closing sentence; added `kbBlock`/`calendarBlock` (+ `CALENDAR_LINES_CAP=25`) in canonical order. |
| `12-worstcase-turn.sh` | **[HIGH]** `eval "$TEST_INBOUND_CURL"` → `bash -c`; resolved `SCRIPT_DIR` for sibling-script calls (was `./` — broke silently when run from repo root). |
| `00-preflight.sh` | **[HIGH]** Hostname guard extended `mailbox1\|mailbox2\|*heronlabs*\|*staqs*` (mailbox2 is now a live customer box). |
| `20-assemble-eval-set.sh` | **[MED]** Integer validation on `N` before SQL interpolation. |
| `22-run-ab.mjs` | **[HIGH]** `new URL('/api/chat', CLOUD_BASE)` → `CLOUD_BASE.replace(/\/$/,'') + '/api/chat'` (URL ctor silently drops a `/v1` path → 404s every arm-A request). |
| `23-rate.mjs` | **[MED]** Guard: `sheet` mode exits if `rating-key.json` exists (regenerating rotated the blind key, invalidating filled ratings). |

### Residual (NOT fixed — out of scope / methodology)
The L1–L5 design issues above. Plus nits: `draft-prompt.mjs` mirror remains hand-maintained (no CI diff-gate — would touch repo CI outside the spike dir); `TEST_INBOUND_CURL` unset by default still lets S2 run with no draft load (documented behavior); `20-assemble-eval-set.sh` recency stratification risks campaign skew and its category vocabulary doesn't match the live enum.

---

## 4. Claims verification table

| # | Claim | Status | Note |
|---|---|---|---|
| 1 | gbrain on mailbox2 supports a real Postgres engine (not just PGlite) | **CONFIRMED** | `engine.ts:641 kind:'postgres'\|'pglite'`, selectable via `init --url <dsn>`. `migrate --to` only lists supabase/pglite (nit). |
| 2 | gbrain embedder = `nomic-embed-text` @768d, matches MailBOX RAG | **CONFIRMED** | hermesBOX `~/.hermesbox/.gbrain/config.json` = `ollama:nomic-embed-text`@768d; MailBOX = `nomic-embed-text:v1.5`@768d → interoperable. Don't confuse with the OTHER `~/.gbrain` brain (nvidia 1024d). |
| 3 | Hermes one-shot CLI is `hermes -z PROMPT` with `-m`/`--provider`/`--yolo` | **CONFIRMED** | Verified against live `hermes --help` on mailbox2. All harness invocations match. |
| 4 | `postgres:17-alpine` ships WITHOUT pgvector; repo never depends on it | **CONFIRMED** | Qdrant-only; every `pgvector` hit is a rejected-alternative rationale. Integration needs `pgvector/pgvector:pg17` or a build — a base-image change to the operational DB, not a toggle. |
| 5 | `inbox_messages` columns in `20-assemble-eval-set.sh` exist | **CONFIRMED** | All 9 columns present in `schema.sql:142-160`. SQL plans cleanly. |
| 6 | `sent_history` columns in `21-gbrain-bootstrap.sh` exist | **REFUTED → FIXED** | Original SELECT named `message_id`/`recipient`/`body` — none exist (real: `draft_id`, `to_addr`, `draft_sent`/`draft_original`; `body_text` is the *inbound*, not the sent reply). Would error at runtime; `set -euo pipefail` doesn't catch the mid-pipe failure → silently empty corpus → arm B handicapped. **Patched + EXPLAIN-verified.** |

**Net: 5/6 confirmed; the 1 refuted claim was the runtime blocker and is fixed.** Verification touched only read-only paths + read-only ssh to mailbox2; no `.env` values printed.

---

## 5. Dry-run results (what executed green)

All executed (not merely read), on `node v22.22.2` / bash:

- **Syntax:** `node --check` on all 4 `.mjs` + `bash -n` on all 5 `.sh` — clean.
- **`draft-prompt.mjs`:** drove `assemblePrompt()` with a synthetic Heron gummy-inquiry inbound → faithful 2-message prompt (system + user), `max_tokens=600`, `temperature=0.7`, byte-faithful to `prompt.ts` (post-fix, with kb/calendar restored).
- **`11-memory-parse.mjs`:** PASS / MARGINAL / FAIL-by-headroom / FAIL-by-OOM-marker bands all correct; exact 500/200 boundaries correct; empty-log → error exit 1; fallback line format parses.
- **`22 → 23` data flow:** synthetic `results.jsonl` → `sheet` (masked sheet + key + empty CSV) → key-derived `ratings.csv` → `score`: per-arm send-as-is rates, latency means (null-filtered), and all three decision branches (GREEN / AMBER-not-worth / AMBER-OUT) incl. the exact 10pp boundary — all correct.
- **`22-run-ab.mjs` static trace:** armA `fetch` → correct Ollama `/api/chat` shape (Bearer auth, 2-msg body, `num_predict:600`, 90s abort, `<think>` strip); armB `execFile` → correct arg array (`-z`, prompt, `--yolo`, optional `-m`/`--provider`), no shell-splitting, resolve-on-error (can't crash the loop).
- **SQL:** booted throwaway `postgres:17-alpine` + `schema.sql` + `search_path=mailbox`; EXPLAINed both scripts. Script 20 plans cleanly; script 21 (post-fix) plans cleanly.

**Could NOT run (out of scope, no bench):** `00-preflight.sh`, `10-memory-sample.sh`, `12-worstcase-turn.sh` live paths (need `tegrastats` / full docker stack / hermes), and any real cloud or hermes invocation.

---

## 6. Remaining blockers before Eric's bench day

| # | Blocker | Owner / action |
|---|---|---|
| B1 | **Bench Jetson required.** Spike runs ONLY on a bench box with the production golden image + `tegrastats` — never mailbox1, never mailbox2 (now a live customer box). Q1 is unanswerable without it. | Provision/identify the bench Orin Nano. |
| B2 | **Companion addendum does NOT exist yet.** The spike doc names `docs/addendum-agentbox-solo-hermes-mailbox-v0_1-2026-05-31.md` (defines SM-97/NC-41/NC-40) and `docs/addendum-t2-build-validation-v0_1-2026-04-25.md` — **neither file is present in `mailbox/docs/`.** The §7 deliverable ("verdict appended to the AgentBOX addendum") has no target to append to. | Write/locate the AgentBOX addendum before the verdict can be filed against SM-97/NC-41. |
| B3 | **gbrain ingest verb is an unconfirmed TODO gate.** `21-gbrain-bootstrap.sh` exports the corpus correctly (post-fix) but the actual ingest verb is unknown — CLI exposes `init/migrate/serve/jobs`; ingest is "likely `remember`/`write`/`ingest` or via the MCP memory tool." Both candidate paths (A direct CLI, B via Hermes) are commented out pending bench confirmation. Without this, arm B has no voice memory and the whole NC-41 value claim collapses. | On bench: `bun run ~/gbrain-src/src/cli.ts --help`, confirm the verb, uncomment path (A) or (B), re-run. |
| B4 | **(Methodology, advisory)** L1/L2 above — if Eric wants a *trustable* (not directional) verdict, the arm-A control-parity fix and the S2-loads-local-qwen3 fix should land before the bench day, not after. | Decide: ship directional, or redesign arms A1/A0 + S2 first. |

---

## 7. Eric's bench-day runbook

> Run on the **bench Jetson** only. `cd ~/mailbox` first (docker-compose commands need the compose file); the scripts resolve sibling paths via `$SCRIPT_DIR`, but `docker compose` calls need the repo root as CWD. All artifacts land in `spike-hermes-mailbox/out/`.

```bash
# 0. Safety gate + baseline (refuses to run on mailbox1/mailbox2/*heronlabs*/*staqs*)
cd ~/mailbox
./spike-hermes-mailbox/00-preflight.sh

# === Q1 — SM-97 memory feasibility (the HARD GATE) ===
# S0 idle / S1 steady-state baselines, then S2 worst-case.
# NOTE (L2): for a trustable S2, set TEST_INBOUND_CURL to inject a LOCAL-category
# inbound (reorder/inquiry) with a realistic-length body so qwen3:4b-ctx4k is
# actually mid-generation at peak. Leaving it unset runs S2 with NO local draft load.
export TEST_INBOUND_CURL='curl -sf -X POST http://localhost:5678/webhook/... -d @inbound.json'
./spike-hermes-mailbox/12-worstcase-turn.sh          # fires S2, samples tegrastats, parses bands
node ./spike-hermes-mailbox/11-memory-parse.mjs ./spike-hermes-mailbox/out/S2-tegrastats.log
#   → PASS (≥500MB free) / MARGINAL (≥200) / FAIL.  If FAIL: STOP — Hermes does not fit. Verdict = RED.
#   If MARGINAL: re-run S2 with classifier dropped (cloud classify) to quantify the no-local-triage option.

# === gbrain voice bootstrap (DR-57) — required before the B arm ===
# Confirm the ingest verb FIRST (B3), then uncomment path (A) or (B) in the script:
bun run ~/gbrain-src/src/cli.ts --help
./spike-hermes-mailbox/21-gbrain-bootstrap.sh        # exports sent corpus → gbrain (your-voice memory)

# === Q2 — NC-41 draft-value A/B (only if Q1 passed) ===
# Source MailBOX .env for the cloud creds first:
export OLLAMA_CLOUD_BASE_URL=https://ollama.com OLLAMA_CLOUD_API_KEY=<from .env>
export HERMES_MODEL=<...> HERMES_PROVIDER=<...>
./spike-hermes-mailbox/20-assemble-eval-set.sh 40    # stratified eval set from inbox_messages (review the distribution print)
node ./spike-hermes-mailbox/22-run-ab.mjs            # arm A (MailBOX prompt→cloud) vs arm B (Hermes+gbrain) → out/results.jsonl
node ./spike-hermes-mailbox/23-rate.mjs sheet        # blind rating sheet + key (key is write-once)
#   → Dustin fills out/ratings.csv (send-as-is / minor / rewrite), arms masked
node ./spike-hermes-mailbox/23-rate.mjs score        # un-mask, compute Δ send-as-is + latency
#   → B > A by ≥10pp → GREEN (Hermes IN draft path) | within ±10pp → AMBER (not worth) | B worse → AMBER (out)
#   CAVEAT (L3): single-rater n≈40 — treat as DIRECTIONAL, not significant.

# === File the verdict ===
# Append the one-page verdict (verdict-template.md) to the AgentBOX addendum (B2 — write it if absent).
```

---

*Software harness is bench-ready with the documented caveats. The verdict itself is a bench-day + human-rating output, not a software artifact.*
