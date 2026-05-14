# `optimization/dspy/` — DSPy GEPA prompt optimizer

STAQPRO-343. Offline prompt-optimization toolchain for the MailBox One
drafting pipeline. Lives in this repo because it's tightly coupled to the
trace-set abstraction (`dashboard/lib/eval/trace-set.ts`) and to the live
prompt files (`dashboard/lib/{classification,drafting}/prompt.ts`).

**This is operator-run tooling, not appliance runtime.** Nothing here ships
to mailbox1 / mailbox2; the only artifacts that propagate to the appliance
are the compiled prompt templates an operator chooses to copy out of
`outputs/` into the persona / n8n config (a manual step outside this PR's
scope).

## What's in here

- `pyproject.toml`, `uv.lock` — Python toolchain pinned to DSPy 2.x.
- `signatures.py` — DSPy signatures for `ClassifyAndFile` + `DraftReply`,
  mirroring `dashboard/lib/{classification,drafting}/prompt.ts`.
- `metric.py` — Ollama Cloud `gpt-oss:120b` LLM-as-judge metric (primary)
  + nomic-embed cosine sanity floor (secondary). Returns 0/1 win per
  `(candidate, reference)` pair. Same endpoint + auth as the live
  alt-cloud drafter (DR-23 supersede) — different family than the Qwen3
  baseline drafter to avoid same-model-as-judge bias.
- `trace_set.py` — Pydantic mirror of the canonical TS trace-set schema
  with SHA-256 verification. Source of truth: `dashboard/lib/eval/trace-set.ts`.
- `optimize.py` — CLI entry point. Loads traces, splits train/val, runs
  GEPA, emits `program.json` + portable prompt YAML + report.md.
- `tests/` — pytest coverage for the trace loader, signatures, and metric
  parsing (judge is mocked; no live cloud calls in CI).
- `outputs/` — gitignored. GEPA runs write here.
- `prompts/` — committed. Templates portable to n8n / persona system land
  here after operator review of an `outputs/` run.

## Privacy stance

- Trace JSONL files live in `traces/` (also gitignored) — they contain
  PII-scrubbed customer email bodies but still embed real sender names and
  email addresses per the STAQPRO-193 locked decision. Treat as
  customer-private; never commit, never publish.
- The Ollama Cloud `gpt-oss:120b` judge call sends individual
  `(candidate, reference, inbound)` triples to `https://ollama.com/api/chat`.
  This is inside the existing cloud trust boundary — the live drafter
  already escalates to the same endpoint on the cloud route per DR-23 —
  but you should still gate runs behind operator approval.
- The portable prompt YAML in `prompts/` (or in `outputs/<run>/prompt-*.yaml`)
  is **instructions only**, no few-shot demos. The optimizer deliberately
  strips compiled demonstrations because those may quote real customer
  email fragments verbatim. Operator must eyeball any YAML before copying
  out of `outputs/` into the committed `prompts/` directory.

## Operator runbook

### One-time setup

```bash
cd optimization/dspy
uv sync                                # materializes .venv from uv.lock
export OLLAMA_CLOUD_API_KEY=...        # required for judge + reflection LM
# Same key as the live appliance's `.env` OLLAMA_CLOUD_API_KEY (the
# alt-cloud drafter path per DR-23). Pull from 1Password if you don't have
# it locally; never commit.
```

### Fetch a real trace set from an appliance

Real customer email content materializes only on the appliances. To run
GEPA against real data, build a trace set on the box and scp it back to
the workstation. Delete the local copy when you're done.

```bash
# On the workstation — open a Postgres tunnel for the build script.
# (Equivalent to `ssh -L 5432:localhost:5432 mailbox1` then running the
# build-trace-set.ts CLI inside the dashboard container; see
# dashboard/scripts/build-trace-set.ts for the canonical procedure.)
ssh mailbox1 'docker exec -e POSTGRES_URL=$(grep ^POSTGRES_URL /home/bob/mailbox/.env | cut -d= -f2-) \
  mailbox-dashboard npx tsx scripts/build-trace-set.ts \
  --out /tmp/trace-set/v1.0 \
  --set-version v1.0 \
  --appliance mailbox1 \
  --limit 100'

# Pull it back.
mkdir -p optimization/dspy/traces/v1.0
scp -r mailbox1:/tmp/trace-set/v1.0/* optimization/dspy/traces/v1.0/

# Clean up the on-appliance copy.
ssh mailbox1 'rm -rf /tmp/trace-set'
```

### Run optimization

```bash
cd optimization/dspy
uv run python -m optimize \
  --trace-set ./traces/v1.0 \
  --target-base-url http://localhost:11434 \
  --target-model qwen3:4b-ctx4k \
  --out outputs/run-$(date +%Y%m%dT%H%M%S) \
  --auto light
```

Bottom-line numbers (PRE / POST / LIFT) print at the end. The full report
+ compiled program + portable prompt YAML land in `outputs/<run>/`.

For the target model, point at any OpenAI-compatible endpoint:

- Local Qwen3 on the workstation if you've pulled the model there.
- The appliance Ollama via SSH tunnel: `ssh -L 11434:localhost:11434 mailbox1`.
- Ollama Cloud for `gpt-oss:120b` (second-pass; out of scope for v0.1).

### Clean up after a run

```bash
# Trace JSONL is gitignored but lives on disk — wipe when done.
rm -rf optimization/dspy/traces/
```

## Testing

```bash
cd optimization/dspy
uv run pytest
```

Tests cover:

- Trace loader: parsing the example manifest, schema validation, SHA-256
  verification.
- Signatures: enum parity with `dashboard/lib/classification/prompt.ts`.
- Metric: judge response parsing (mocked Ollama Cloud `/api/chat`), wire
  shape (URL, Bearer auth, model), cosine math, empty candidate handling.

No live cloud calls are made in CI — the judge's `httpx.Client` is
swapped for a `MagicMock` after construction and nomic-embed is bypassed
via `disable_cosine=True`.

## Scope notes (STAQPRO-343 v0.1)

- **Signatures shipped:** `ClassifyAndFile`, `DraftReply`. The stretch
  signatures (`summarize-thread`, `escalate-to-human`) are deferred — the
  trace-set v1.0 spec emits `draft-reply` rows only.
- **Target models:** Qwen3-4B (current production drafter) is the v0.1
  first-pass target. Second-pass against the STAQPRO-342 bake-off winner
  is out of scope for this PR — that issue hasn't completed.
- **Trace-fetch path:** option (b) per the foreman audit — ship the
  harness, document the operator runbook above for fetching a real trace
  set. No real traces materialize in this PR; first real GEPA run is an
  operator follow-up.
