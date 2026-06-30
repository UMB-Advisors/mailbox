#!/usr/bin/env bash
# ~/mailbox/dashboard/scripts/mailbox-classify-and-heal.sh
#
# AgentBOX mailbox Phase 1 ops — authoritative classification + self-heal.
#
# The running mailbox-dashboard is a BAKED image whose in-process classify
# sweeper still mis-tags classification_log.account_id to the default account
# (1). Rather than rebuild the Next.js image on this 8 GB box, this scheduled
# job makes the FIXED code authoritative:
#
#   1. classify-backfill.ts via the source-mounted `migrate` container (FIXED
#      account_id tagging), 7d lookback — classifies any inbox rows that have
#      no classification_log entry yet, tagging them with the correct account.
#      It RESPECTS the MBOX-166 memory preflight (we do NOT set
#      MAILBOX_PREFLIGHT_SKIP); if qwen3 is mid-load and memory is tight it
#      refuses and we simply retry next tick — no thrash.
#   2. Idempotent correction UPDATE — re-tags any classification_log row whose
#      account_id disagrees with its inbox row (heals rows the baked in-process
#      sweeper mis-tagged in the interval). Cheap; runs every tick regardless of
#      whether the backfill itself ran.
#
# READ-ONLY w.r.t. mail. Never sends, never drafts. Invoked by
# mailbox-classify.service / .timer.

set -uo pipefail

MAILBOX_DIR="${MAILBOX_DIR:-$HOME/mailbox}"
# Tee to a rolling logfile (user journal non-persistent on this box).
LOG_DIR="${MAILBOX_LOG_DIR:-$HOME/mailbox/logs}"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/classify-heal.log"
exec > >(tee -a "$LOG_FILE") 2>&1
if [[ -f "$LOG_FILE" ]] && [[ "$(wc -l < "$LOG_FILE")" -gt 2000 ]]; then
  tail -n 2000 "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
fi
BACKFILL_LOOKBACK_HOURS="${BACKFILL_LOOKBACK_HOURS:-168}" # 7d
BACKFILL_LIMIT="${BACKFILL_LIMIT:-60}"
DASHBOARD_BASE_URL="${DASHBOARD_BASE_URL:-http://mailbox-dashboard:3001/dashboard}"
PG_CONTAINER="${PG_CONTAINER:-mailbox-postgres-1}"

# Inference targets: prefer the M1 Pro LAN Ollama (offload off the 8GB Jetson),
# fall back to the on-box docker Ollama if the Mac is unreachable (asleep).
OLLAMA_PRIMARY="${OLLAMA_BASE_URL:-http://10.0.0.106:11434}"
OLLAMA_FALLBACK="${OLLAMA_FALLBACK_URL:-http://ollama:11434}"

cd "$MAILBOX_DIR" || { echo "[classify-heal] cannot cd $MAILBOX_DIR"; exit 1; }

# Health-check the primary (M1) from a throwaway migrate container — that is the
# exact network context the backfill runs in, so this proves reachability for
# the real call, not just the host. 6s budget. If it fails, use the local
# fallback for THIS run (graceful degradation; the dashboard container's own
# OLLAMA_BASE_URL is separate and reverts via .env).
if docker compose --profile migrate run --rm -e OLLAMA_PRIMARY="$OLLAMA_PRIMARY" mailbox-migrate \
     node -e "fetch(process.env.OLLAMA_PRIMARY+'/api/tags',{signal:AbortSignal.timeout(6000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
     >/dev/null 2>&1; then
  OLLAMA_BASE_URL="$OLLAMA_PRIMARY"
  OLLAMA_TARGET="M1(primary)"
else
  OLLAMA_BASE_URL="$OLLAMA_FALLBACK"
  OLLAMA_TARGET="local(fallback — M1 unreachable)"
fi

echo "[classify-heal] start $(date -Is) — lookback=${BACKFILL_LOOKBACK_HOURS}h limit=$BACKFILL_LIMIT ollama=$OLLAMA_BASE_URL [$OLLAMA_TARGET]"

# 1) Classify new rows with FIXED code. Preflight may refuse (memory) — that is
#    fine, we retry next tick. Never force MAILBOX_PREFLIGHT_SKIP.
out="$(docker compose --profile migrate run --rm \
    -e BACKFILL_LOOKBACK_HOURS="$BACKFILL_LOOKBACK_HOURS" \
    -e BACKFILL_LIMIT="$BACKFILL_LIMIT" \
    -e DASHBOARD_BASE_URL="$DASHBOARD_BASE_URL" \
    -e OLLAMA_BASE_URL="$OLLAMA_BASE_URL" \
    mailbox-migrate sh -c "npx tsx scripts/classify-backfill.ts" 2>&1)"
echo "$out" | grep -E "unclassified|done|preflight|\[fail\]|nothing to do" | tail -8

# 2) Self-heal account_id drift (idempotent). Heals any rows the baked
#    in-process sweeper tagged to the default account since the last tick.
heal="$(docker exec "$PG_CONTAINER" psql -U mailbox -d mailbox -tAc \
  "WITH upd AS (
     UPDATE mailbox.classification_log cl
        SET account_id = m.account_id
       FROM mailbox.inbox_messages m
      WHERE m.id = cl.inbox_message_id
        AND cl.account_id IS DISTINCT FROM m.account_id
   RETURNING 1)
   SELECT count(*) FROM upd;" 2>&1)"
echo "[classify-heal] account_id mismatches corrected this tick: $heal"

# Post-condition assertion: there must be ZERO remaining mismatches.
remain="$(docker exec "$PG_CONTAINER" psql -U mailbox -d mailbox -tAc \
  "SELECT count(*) FROM mailbox.classification_log cl
     JOIN mailbox.inbox_messages m ON m.id = cl.inbox_message_id
    WHERE cl.account_id IS DISTINCT FROM m.account_id;" 2>&1)"
echo "[classify-heal] remaining mismatches: $remain"

echo "[classify-heal] done $(date -Is)"
exit 0
