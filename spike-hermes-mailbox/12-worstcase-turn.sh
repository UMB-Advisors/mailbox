#!/usr/bin/env bash
# Spike §4.3 + §4.2 (S2) — construct the worst-case turn and sample through it.
#
# S2 = a deliberately heavy Hermes turn (multi-tool, context-growing, fans out
# concurrent tool calls toward its worker ceiling) fired WITHIN ~2s of an n8n
# classify+draft on a fresh inbound. This is the transient spike the 8GB
# envelope must survive.
#
# Starts the memory sampler in the background, then launches both workloads in
# the same ~2s window. Bench box only.
set -euo pipefail
OUT="${OUT_DIR:-./out}"; mkdir -p "$OUT"
DUR="${S2_DURATION_SEC:-90}"
HERMES_BIN="${HERMES_BIN:-hermes}"
HERMES_MODEL="${HERMES_MODEL:-}"      # match arm A's cloud model for fairness
HERMES_PROVIDER="${HERMES_PROVIDER:-}"

# The heavy turn: forces multiple concurrent tool calls + long context so the
# auxiliary compression call also fires (§4.3).
HEAVY_PROMPT="${S2_PROMPT:-Search my last week of filed email, cross-reference the three most frequent senders, summarize every open thread that still needs a reply, and list any commitments I made. Use tools in parallel where possible.}"

echo "[$(date -u +%H:%M:%S)] S2: starting ${DUR}s memory sample in background"
( OUT_DIR="$OUT" ./10-memory-sample.sh S2 "$DUR" >/dev/null 2>&1 ) &
SAMPLER=$!
sleep 1   # let the sampler establish a floor

echo "[$(date -u +%H:%M:%S)] S2: firing n8n classify+draft + heavy Hermes turn (~2s window)"

# (1) Trigger a classify+draft. Easiest deterministic trigger = inject a fresh
#     synthetic inbound through the internal route, which fires classify→draft.
#     Set TEST_INBOUND_CURL to your own trigger if you prefer the live schedule.
if [ -n "${TEST_INBOUND_CURL:-}" ]; then
  eval "$TEST_INBOUND_CURL" >/dev/null 2>&1 &
else
  echo "  NOTE: set TEST_INBOUND_CURL to a curl that POSTs a test inbound to" >&2
  echo "        /dashboard/api/internal/inbox-messages, OR ensure a real inbound" >&2
  echo "        is mid-pipeline now. Proceeding with the Hermes turn regardless." >&2
fi

# (2) Heavy Hermes turn, concurrently.
HARGS=(-z "$HEAVY_PROMPT")
[ -n "$HERMES_MODEL" ] && HARGS+=(-m "$HERMES_MODEL")
[ -n "$HERMES_PROVIDER" ] && HARGS+=(--provider "$HERMES_PROVIDER")
"$HERMES_BIN" "${HARGS[@]}" >"$OUT/s2-hermes-turn.out" 2>&1 &
HTURN=$!

wait "$HTURN" || echo "  (hermes turn exited non-zero — check $OUT/s2-hermes-turn.out)"
echo "[$(date -u +%H:%M:%S)] S2: hermes turn finished; waiting for sampler"
wait "$SAMPLER" || true

echo "[$(date -u +%H:%M:%S)] S2 done. Verdict:"
node ./11-memory-parse.mjs "$OUT/S2-tegrastats.log"
