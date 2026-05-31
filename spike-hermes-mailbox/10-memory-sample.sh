#!/usr/bin/env bash
# Spike §4.2 — sample peak unified memory for one state (S0 | S1 | S2).
#   ./10-memory-sample.sh <STATE> <DURATION_SEC>
# Captures tegrastats (unified-memory truth), a docker stats snapshot, and free,
# cross-checked per §4.2. Run the matching workload during the window:
#   S0  stack idle, Hermes idle
#   S1  n8n mid classify+draft on a test email, Hermes idle
#   S2  use 12-worstcase-turn.sh instead (it drives the workload + samples)
set -euo pipefail
STATE="${1:?usage: 10-memory-sample.sh <STATE> <DURATION_SEC>}"
DUR="${2:?usage: 10-memory-sample.sh <STATE> <DURATION_SEC>}"
OUT="${OUT_DIR:-./out}"; mkdir -p "$OUT"
TLOG="$OUT/${STATE}-tegrastats.log"

echo "[$(date -u +%H:%M:%S)] sampling $STATE for ${DUR}s → $TLOG"
if command -v tegrastats >/dev/null; then
  timeout "$DUR" tegrastats --interval 500 | tee "$TLOG"
else
  # Fallback for non-Jetson bench: poll /proc/meminfo into a tegrastats-shaped line.
  END=$(( $(date +%s) + DUR ))
  while [ "$(date +%s)" -lt "$END" ]; do
    awk '/MemTotal/{t=$2} /MemAvailable/{a=$2}
         END{printf "RAM %d/%dMB (fallback)\n",(t-a)/1024,t/1024}' /proc/meminfo
    sleep 0.5
  done | tee "$TLOG"
fi

echo "[$(date -u +%H:%M:%S)] docker stats snapshot"
docker stats --no-stream --format '  {{.Name}}\t{{.MemUsage}}\t{{.MemPerc}}' \
  | tee "$OUT/${STATE}-docker-stats.txt" || true
free -m | tee "$OUT/${STATE}-free.txt"
echo "[$(date -u +%H:%M:%S)] $STATE sample done → parse with: node 11-memory-parse.mjs $TLOG"
