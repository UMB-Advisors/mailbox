# Spike Harness — Hermes on an Existing MailBOX Appliance

Turnkey scripts for the feasibility spike in
`docs/spike-hermes-on-mailbox-feasibility-v0_1-2026-05-31.md`.

Answers two gated questions on a **bench Jetson** (never a customer box):

- **Q1 / SM-97 (hard gate):** does a host-side Hermes (client mode, weight-free) fit
  in the 8 GB envelope alongside the full live MailBOX stack with the classifier
  resident, under worst-case load? → `00`–`12`.
- **Q2 / NC-41 (value):** does drafting via Hermes (+ gbrain voice memory) beat the
  existing direct-to-cloud draft on blind send-as-is rate by ≥ 10 pp? → `20`–`23`.

**Q1 runs first and gates Q2.** If Q1 fails, the verdict is RED and Q2 is moot on T2.

---

## Reference build (mailbox2, inspected 2026-05-31)

The `hermesBOX` install on `mailbox2` (Linear UMB-380…386) is the canonical config
this spike co-locates with MailBOX. Confirmed there:

| Thing | Value |
|---|---|
| Hardware | Jetson Orin, JetPack 6.x (L4T R36.5), user `mailbox` |
| Hermes home | `~/.hermes/` (config.yaml + `.pre*` snapshots), uv venv, `~/.local/bin/hermes` |
| One-shot CLI | `hermes -z PROMPT -m MODEL --provider PROVIDER` (non-interactive) |
| Provider chain | OpenAI primary + OpenRouter fallback (UMB-382). **Not Anthropic-primary.** |
| Ollama | **embeddings-only** — only `nomic-embed-text` (274 MB) resident; inference is cloud → live proof of the §4.1 weight-free premise |
| gbrain | `~/.hermesbox/.gbrain/` — engine `pglite`, `embedding_model: ollama:nomic-embed-text` @ 768d (same embedder MailBOX RAG uses), MCP-published (`mcp_servers.gbrain` → `bun run …ts`, `publish_skills: true`) |
| Hermes memory | `memory_enabled: true`, `memory_char_limit: 2200`, `inherit_mcp_toolsets: true` |

**Bench setup ask:** reproduce this Hermes+gbrain config on the bench box that already
carries the **full MailBOX golden image**. mailbox2 has Hermes+gbrain but NOT the
MailBOX stack — so it is the *config reference*, not the SM-97 measurement.

### gbrain storage — PGlite (reference) vs shared Postgres 17 (option)

gbrain (v0.41) is **not locked to PGlite**: `gbrain init` takes `--pglite | --supabase
| --url <dsn>`, `gbrain migrate` moves a brain between engines, and the Postgres
engine unlocks the `jobs work` background worker ("Postgres only") that PGlite can't
run. So gbrain **can** ride the appliance's existing `postgres:17`.

- **For the spike: keep PGlite** (default, zero-config, matches mailbox2, isolates the
  variable). Do not rearchitect storage mid-feasibility-test.
- **Integration is a post-GREEN productization choice and a footprint lever.** One hard
  prerequisite: **pgvector** — gbrain stores 768d vectors; `postgres:17-alpine` ships
  without it (MailBOX uses Qdrant for vectors), so integration means switching to
  `pgvector/pgvector:pg17` (or building the extension in) + `CREATE EXTENSION vector`.
  Isolate in a dedicated `gbrain` schema, never `mailbox.*` (n8n already co-tenants the
  same instance, so the pattern is proven). Consolidating onto one pg process may
  reclaim RAM — relevant **if Q1/SM-97 is MARGINAL**. `21-gbrain-bootstrap.sh` documents
  the `--url` wiring.

> ⚠️ `~/.hermes/.env` on mailbox2 holds live provider keys. Do **not** cat it into a
> shell that logs. Keys leaked into a session on 2026-05-31 were rotated — see the
> spike branch commit message.

---

## Prerequisites on the bench box

- Full MailBOX golden image, 8 services healthy (`docker compose ps`).
- Classifier resident: `qwen3-4b-instruct-2507` (prod default, STAQPRO-342).
- Hermes installed host-side in **client mode** (no local model weights), gbrain wired
  per the table above.
- `MailBOX .env` sourced for the cloud-draft control arm: `OLLAMA_CLOUD_BASE_URL`,
  `OLLAMA_CLOUD_API_KEY`, and the draft model (`OLLAMA_CLOUD_MODEL`, default
  `gpt-oss:120b`).
- A **test Gmail account** (not a customer inbox) feeding the pipeline.
- `node` ≥ 18 on the host (built-in `fetch`; the `.mjs` scripts have zero npm deps).

All scripts write under `./out/` (gitignored). Run them in numeric order.

---

## Day 1 — Q1 (memory / SM-97)

```bash
./00-preflight.sh                     # §3 clean baseline + orphan check + §4.1 weight-free verify
# S0 baseline (stack idle, Hermes idle):
./10-memory-sample.sh S0 120          # sample 120s
# S1 pipeline busy (trigger a classify+draft on a test email), Hermes idle:
./10-memory-sample.sh S1 120          # while a real inbound flows through n8n
# S2 worst case — heavy Hermes turn DURING an n8n classify+draft:
./12-worstcase-turn.sh                # fires both within ~2s, samples throughout
# Verdict:
node ./11-memory-parse.mjs out/S2-tegrastats.log
```

`11-memory-parse.mjs` prints peak RAM used, free headroom at peak, and the SM-97 verdict:

| Free at S2 peak | Verdict |
|---|---|
| ≥ 500 MB | **Q1 PASS** → Day 2 |
| 200–500 MB | **Q1 MARGINAL** → record; run the classifier-drop variant (§4.5) before any T2 commit |
| < 200 MB or any OOM | **Q1 FAIL** → RED; Hermes is T3-only; STOP |

Classifier-drop variant (only if MARGINAL/FAIL): `ollama stop qwen3:4b-ctx4k` (so only
the embedder is resident), then re-run `./12-worstcase-turn.sh` and re-parse. Records the
"classification also goes cloud, no local-triage fallback" number for NC-43.

## Day 2 — Q2 (draft A/B / NC-41)  *(only if Q1 PASS or MARGINAL)*

```bash
./20-assemble-eval-set.sh 40          # freeze ~40 real test-account inbound across 5 categories → out/eval-set.jsonl
./21-gbrain-bootstrap.sh              # DR-57: ingest the test account's SENT folder into gbrain (voice model non-empty) BEFORE arm B
node ./22-run-ab.mjs out/eval-set.jsonl   # A = MailBOX prompt → cloud; B = hermes -z (same model); logs latency + bodies
node ./23-rate.mjs sheet              # emit blinded, arm-masked rating sheet (out/rating-sheet.md) + key
#   ... operator fills send-as-is / minor-edit / rewrite per draft ...
node ./23-rate.mjs score              # aggregate → A vs B send-as-is rate, latency delta, NC-41 decision
```

**Fairness controls (do not skip):**
- **Same cloud model behind both arms.** Set `HERMES_MODEL`/`HERMES_PROVIDER` so arm B's
  underlying model == arm A's (`OLLAMA_CLOUD_MODEL`). If they cannot be matched exactly,
  record it as a confound (see §7 risk table). The test isolates *Hermes' context/skill
  contribution*, not a model swap.
- **Same eval set, same RAG availability** to both arms.
- **gbrain bootstrapped before B** — a cold Hermes unfairly handicaps the treatment.

NC-41 decision (`23-rate.mjs score` applies it):

| Result | Resolution |
|---|---|
| B's send-as-is **> A by ≥ 10 pp** | Hermes **in** the draft path → GREEN (if Q1 passed) |
| B within ±10 pp of A | Hermes **not worth** the hop → AMBER (conversational surface only) |
| B **worse** than A | Hermes out of draft path → AMBER |

## Day 3 — Verdict

Fill `verdict-template.md` → GREEN / AMBER / RED, with the SM-97 headroom number, the
A/B rates + latency delta, the NC-40 native-security observations (§6), and the SKU
recommendation. Then: **wipe the bench box, leave this branch unmerged.**

---

## Blockers / open items (resolve before Day 1)

1. **Bench Jetson** — not yet identified. Options: a spare Orin, or capture the current
   golden image to a spare NVMe (§3). **Never `mailbox1`.**
2. **Companion addendum missing** — `addendum-agentbox-solo-hermes-mailbox-v0_1` (defines
   SM-97/NC-41 formally) is not in this repo. Thresholds are inlined here from the spike
   doc; record the verdict back into that addendum once it exists.
3. **No Linear ticket** for this spike yet — file under `hermesBOX` or MailBOX M5 and
   post an intent comment before execution (repo coordination protocol).
4. **gbrain sent-folder ingest CLI** (`21`) — the exact gbrain ingest call is marked TODO
   in that script; confirm against `bun run <gbrain-entrypoint>.ts --help` on the bench.

## What each file is

| File | Spike § | Purpose |
|---|---|---|
| `00-preflight.sh` | §3, §4.1 | clean baseline, orphan check, Hermes weight-free verify |
| `10-memory-sample.sh` | §4.2 | sample one state (tegrastats + docker stats + free) |
| `11-memory-parse.mjs` | §4.4 | tegrastats log → peak + free headroom → SM-97 verdict |
| `12-worstcase-turn.sh` | §4.3 | construct S2: heavy Hermes turn ∥ n8n classify+draft |
| `20-assemble-eval-set.sh` | §5.2 | freeze ~30–50 inbound across 5 categories |
| `21-gbrain-bootstrap.sh` | §5.2 | ingest SENT folder into gbrain before arm B (DR-57) |
| `22-run-ab.mjs` | §5.1/5.3 | run both arms, log latency + bodies |
| `23-rate.mjs` | §5.3/5.4 | blind rating sheet + aggregate → NC-41 decision |
| `draft-prompt.mjs` | — | mirrors `dashboard/lib/drafting/prompt.ts` (control arm prompt) |
| `verdict-template.md` | §8 | one-page deliverable |
