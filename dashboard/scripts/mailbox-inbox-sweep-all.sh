#!/usr/bin/env bash
# ~/mailbox/dashboard/scripts/mailbox-inbox-sweep-all.sh
#
# AgentBOX mailbox Phase 1 ops — scheduled multi-account inbound sweeper.
# Sweeps the non-default accounts (2..6) SERIALLY (never in parallel) via the
# source-mounted `migrate` container, so it always runs the FIXED dashboard
# code. Each account is bounded (newer_than:7d, cap below). Dedup is per
# (account_id, message_id), so re-runs are safe. The default account (account 1)
# ingests via n8n and is intentionally NOT swept here.
#
# READ-ONLY Gmail (list+get). Never sends, never drafts. Invoked by
# mailbox-inbox-sweep.service / .timer.

set -uo pipefail

MAILBOX_DIR="${MAILBOX_DIR:-$HOME/mailbox}"
# Tee all output to a rolling logfile (user journal is non-persistent on this
# box). Keeps the last ~2000 lines so it can't grow unbounded.
LOG_DIR="${MAILBOX_LOG_DIR:-$HOME/mailbox/logs}"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/inbox-sweep.log"
exec > >(tee -a "$LOG_FILE") 2>&1
# Trim the logfile to its last 2000 lines on each run (cheap, bounded).
if [[ -f "$LOG_FILE" ]] && [[ "$(wc -l < "$LOG_FILE")" -gt 2000 ]]; then
  tail -n 2000 "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
fi
ENV_FILE="$MAILBOX_DIR/.env"
SWEEP_MAX="${INBOX_SWEEP_MAX:-25}"
SWEEP_LOOKBACK_HOURS="${INBOX_SWEEP_LOOKBACK_HOURS:-168}" # 7d
INTERNAL_BASE_URL="${INTERNAL_BASE_URL:-http://mailbox-dashboard:3001/dashboard}"

# Accounts to sweep, in order. The default account (1) excluded on purpose.
# Replace these with the non-default mailboxes connected to this appliance.
ACCOUNTS=(
  "account2@example.com"
  "account3@example.com"
  "account4@example.com"
  "account5@example.com"
  "account6@example.com"
)

cd "$MAILBOX_DIR" || { echo "[sweep-all] cannot cd $MAILBOX_DIR"; exit 1; }

read_env() { grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2-; }
OAUTH_KEY="$(read_env MAILBOX_OAUTH_TOKEN_KEY)"
CID="$(read_env GOOGLE_OAUTH_CLIENT_ID)"
CS="$(read_env GOOGLE_OAUTH_CLIENT_SECRET)"

if [[ -z "$OAUTH_KEY" || -z "$CID" || -z "$CS" ]]; then
  echo "[sweep-all] missing OAuth env in $ENV_FILE"; exit 1
fi

echo "[sweep-all] start $(date -Is) — accounts: ${#ACCOUNTS[@]} serial, cap=$SWEEP_MAX lookback=${SWEEP_LOOKBACK_HOURS}h"

rc_total=0
for EMAIL in "${ACCOUNTS[@]}"; do
  echo "[sweep-all] --- sweeping $EMAIL ---"
  # One migrate-container run per account. Serial by construction (no &).
  out="$(docker compose --profile migrate run --rm \
      -e MAILBOX_OAUTH_TOKEN_KEY="$OAUTH_KEY" \
      -e GOOGLE_OAUTH_CLIENT_ID="$CID" \
      -e GOOGLE_OAUTH_CLIENT_SECRET="$CS" \
      -e INBOX_SWEEP_ACCOUNT_EMAIL="$EMAIL" \
      -e INBOX_SWEEP_MAX="$SWEEP_MAX" \
      -e INBOX_SWEEP_LOOKBACK_HOURS="$SWEEP_LOOKBACK_HOURS" \
      -e INTERNAL_BASE_URL="$INTERNAL_BASE_URL" \
      mailbox-migrate sh -c "npx tsx scripts/inbox-sweep-account.ts" 2>&1)"
  rc=$?
  # Surface only the JSON result line + any error lines (keep journald lean).
  echo "$out" | grep -E '"ok"|Error|error|POST failed|failed' | tail -3
  [[ $rc -ne 0 ]] && { echo "[sweep-all] $EMAIL exited rc=$rc"; rc_total=1; }
done

echo "[sweep-all] done $(date -Is) rc_total=$rc_total"
exit $rc_total
