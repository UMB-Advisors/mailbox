#!/usr/bin/env bash
# Spike §3 + §4.1 — clean baseline + Hermes weight-free verification.
#
# The DR-25 lesson: the "hardware too small" finding was a measurement artifact
# (an orphan container ate 3.86 GiB). Establish a clean baseline and confirm
# Hermes is NOT holding a local model before any S0/S1/S2 measurement.
#
# Bench box only. Never mailbox1.
set -euo pipefail
OUT="${OUT_DIR:-./out}"; mkdir -p "$OUT"
log() { echo "[$(date -u +%H:%M:%S)] $*"; }

log "host: $(hostname)  arch: $(uname -m)"
case "$(hostname)" in
  mailbox1|mailbox2|*heronlabs*|*staqs*) echo "REFUSING: this looks like a live customer/appliance box. Bench only." >&2; exit 2;;
esac

log "=== orphan containers (running on host − declared in compose) ==="
docker ps -a --format '  {{.Names}}\t{{.Image}}\t{{.Status}}' | tee "$OUT/docker-ps-a.txt"
log "=== compose service health (expect 8 healthy) ==="
docker compose ps 2>/dev/null | tee "$OUT/compose-ps.txt" || log "(run from the dir with docker-compose.yml)"

log "=== clean baseline RAM ==="
free -m | tee "$OUT/baseline-free.txt"
grep -E 'MemTotal|MemAvailable|SwapTotal|SwapFree' /proc/meminfo | tee "$OUT/baseline-meminfo.txt"

log "=== tegrastats sanity (Jetson unified-memory truth) ==="
if command -v tegrastats >/dev/null; then
  timeout 3 tegrastats --interval 1000 | head -2 | tee "$OUT/tegrastats-sanity.txt" || true
else
  echo "WARN: tegrastats not found — not a Jetson, or PATH issue. SM-97 needs it." | tee "$OUT/tegrastats-sanity.txt"
fi

log "=== §4.1 Hermes weight-free verification ==="
echo "-- hermes process footprint --"
ps -eo pid,rss,comm,args | grep -iE 'hermes' | grep -v grep | tee "$OUT/hermes-ps.txt" || log "hermes not running yet (ok if idle)"
echo "-- Ollama must hold ONLY classifier + embeddings (no new model) --"
# Reference (mailbox2 client mode): only nomic-embed-text resident.
( docker exec mailbox-ollama ollama ps 2>/dev/null || ollama ps 2>/dev/null ) | tee "$OUT/ollama-ps.txt" || true
echo "-- installed Ollama models --"
( docker exec mailbox-ollama ollama list 2>/dev/null || ollama list 2>/dev/null ) | tee "$OUT/ollama-list.txt" || true

log "GATE: if 'ollama ps' shows any model beyond qwen3:4b-ctx4k (classifier) +"
log "      nomic-embed-text (embeddings), Hermes pulled a local model — STOP and"
log "      reconfigure to client mode. A resident 2nd model is the envelope-breaker."
log "preflight complete → $OUT/"
