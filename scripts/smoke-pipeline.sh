#!/usr/bin/env bash
# smoke-pipeline.sh — MailBox One end-to-end pipeline smoke (ingest → classify → draft)
#
# MBOX-181 (M5 "OTA + QA validation"). Exercises the LIVE n8n pipeline with a
# SYNTHETIC inbound message and asserts a draft lands in mailbox.drafts —
# WITHOUT sending any real email. This is the pipeline-level companion to
# scripts/smoke-test.sh (which is INFRA-only: GPU / Ollama / Qdrant / Postgres
# and does NOT exercise the pipeline).
#
# WHAT IT DOES
#   1. Inserts a synthetic row into mailbox.inbox_messages (deterministic,
#      tagged message_id so cleanup is precise and re-runs are idempotent).
#   2. Triggers the MailBOX-Classify sub-workflow (MlbxClsfySub0001) against
#      that row's id. Classify runs Qwen3 (qwen3:4b-ctx4k), logs to
#      mailbox.classification_log, inserts the draft stub, and fires
#      MailBOX-Draft, which calls the local/cloud LLM and persists the body
#      via /api/internal/draft-finalize.
#   3. Polls mailbox.drafts for the resulting row and ASSERTS:
#        - a draft row exists for the synthetic inbox message
#        - status is 'pending'        (live CHECK-constraint value; see NOTE)
#        - classification_category is set and is a valid category
#        - draft_body is non-empty    (the LLM actually produced text)
#   4. Cleans up the synthetic rows (drafts + classification_log + inbox).
#
# ── THE SEND SEAM (intentional) ────────────────────────────────────────────
#   MailBOX-Classify and MailBOX-Draft contain NO reference to MailBOX-Send
#   (workflow id `mailbox-send`). The draft lands at status='pending' and the
#   approve→Run-Send-Sub→Gmail-Reply path is reachable ONLY by an operator
#   approval. This script NEVER approves the draft and NEVER calls the
#   mailbox-send webhook, so Gmail Reply is structurally never reached. No
#   real email can be sent by this script. (For the send-lock idempotency
#   smoke, see scripts/smoke-send-lock.sh, which is a separate concern.)
#
# NOTE on status value: MBOX-181's text says assert status='pending_approval'.
# The LIVE drafts_status_check CHECK constraint
# (dashboard/migrations/003-evolve-drafts-to-queue-shape-v1-2026-04-27.sql,
# narrowed by migration 016) is { pending | awaiting_cloud | approved |
# rejected | edited | sent } — there is NO 'pending_approval' value. A fresh
# local-route draft lands at 'pending'; a cloud-route draft transiently sits
# at 'awaiting_cloud' before flipping to 'pending'. This script accepts EITHER
# 'pending' or 'awaiting_cloud' as a healthy terminal-ish state (configurable
# via SMOKE_ACCEPT_STATUSES) and treats 'pending' as the canonical green.
#
# RUN LOCATION
#   Run from the workstation (uses ssh) OR directly on the appliance.
#   If --host matches the local hostname, runs locally with no ssh hop.
#
# USAGE
#   bash scripts/smoke-pipeline.sh [--host mailbox1|mailbox2] [--keep]
#                                  [--timeout SECONDS] [--cloud]
#
#   --host HOST        Appliance ssh alias or 'local' (default: mailbox1).
#   --keep             Do NOT clean up the synthetic rows (debugging).
#   --timeout SECONDS  Max seconds to wait for the draft to appear (default 90;
#                      matches the project's <60s cloud-path SLA + headroom).
#   --cloud            Use a synthetic message engineered to route to the cloud
#                      path (category 'escalate'); default routes local.
#   -h | --help        Show this header.
#
# EXIT CODES (usable as an OTA gate — non-zero blocks the rollout)
#   0  pipeline produced a valid draft (ingest → classify → draft all OK)
#   1  assertion failed (no draft, empty body, wrong status/category, etc.)
#   2  setup/precondition error (workflows inactive, ssh/docker failure,
#      schema missing, n8n trigger could not be invoked)
#
# IDEMPOTENT: the synthetic message_id is deterministic per --cloud flag, and
# the script removes any pre-existing synthetic rows before seeding. A trap
# guarantees cleanup even on mid-run failure (unless --keep).

set -euo pipefail

# ───────────────────────── Defaults / arg parse ─────────────────────────
HOST="mailbox1"
KEEP=false
TIMEOUT=90
CLOUD=false

usage() { sed -n '2,70p' "$0"; exit 2; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host)    HOST="$2"; shift 2 ;;
    --keep)    KEEP=true; shift ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --cloud)   CLOUD=true; shift ;;
    -h|--help) usage ;;
    *) echo "unknown arg: $1" >&2; usage ;;
  esac
done

if ! [[ "$TIMEOUT" =~ ^[0-9]+$ ]]; then
  echo "ERROR: --timeout must be an integer (seconds), got: $TIMEOUT" >&2
  exit 2
fi

# Tunable knobs (env overrides — never required).
CLASSIFY_WORKFLOW_ID="${SMOKE_CLASSIFY_WORKFLOW_ID:-MlbxClsfySub0001}"
N8N_CONTAINER="${SMOKE_N8N_CONTAINER:-mailbox-n8n-1}"
PG_CONTAINER="${SMOKE_PG_CONTAINER:-mailbox-postgres-1}"
PG_USER="${SMOKE_PG_USER:-mailbox}"
PG_DB="${SMOKE_PG_DB:-mailbox}"
ACCEPT_STATUSES="${SMOKE_ACCEPT_STATUSES:-pending awaiting_cloud}"

# ───────────────────────── local-or-ssh plumbing ─────────────────────────
SSH_PREFIX=""
if [[ "$HOST" != "local" && "$(hostname -s 2>/dev/null || true)" != "$HOST" ]]; then
  SSH_PREFIX="ssh $HOST"
fi

run_remote() {
  if [[ -z "$SSH_PREFIX" ]]; then bash -c "$1"; else $SSH_PREFIX "$1"; fi
}

# tab-stripped tuple-only psql query against the appliance Postgres.
psql_q() {
  run_remote "docker exec ${PG_CONTAINER} psql -U ${PG_USER} -d ${PG_DB} -tAc \"$1\""
}

# ───────────────────────── pretty output ─────────────────────────
pretty() {
  local color="$1"; shift
  case "$color" in
    green)  printf '\033[32m%s\033[0m\n' "$*" ;;
    red)    printf '\033[31m%s\033[0m\n' "$*" ;;
    yellow) printf '\033[33m%s\033[0m\n' "$*" ;;
    blue)   printf '\033[34m%s\033[0m\n' "$*" ;;
    *)      echo "$*" ;;
  esac
}

assert_nonempty() {
  local what="$1" val="$2"
  if [[ -n "$val" && "$val" != "NULL" ]]; then
    pretty green "  ✓ $what is set: ${val:0:60}"
  else
    pretty red "  ✗ $what is empty/NULL"
    return 1
  fi
}

# ───────────────────────── synthetic fixture ─────────────────────────
# Deterministic per route so cleanup is precise and re-runs are idempotent.
if $CLOUD; then
  MSG_ID="smoke-pipeline-cloud-fixture"
  SUBJECT="URGENT escalation: damaged pallet, need replacement before Friday"
  FROM_ADDR="smoke-cloud@example.invalid"
  BODY="Half the cases in the latest shipment arrived crushed and 30 units are missing. We need a replacement pallet before Friday or we will have to cancel the standing order. Please advise on next steps and timeline."
else
  MSG_ID="smoke-pipeline-local-fixture"
  SUBJECT="Reorder: 50 cases for next restock"
  FROM_ADDR="smoke-local@example.invalid"
  BODY="Hi — we are running low and would like to reorder 50 cases of the usual SKU for delivery the week of the 15th. Same ship-to as last time. Can you confirm pricing and lead time? Thanks."
fi
TO_ADDR="operator@example.invalid"

# SQL-escape single quotes for inline literals.
sql_lit() { printf "%s" "${1//\'/\'\'}"; }

pretty blue "═══ MailBox One — pipeline smoke (ingest → classify → draft) ═══"
pretty blue "Host: $HOST  ($([ -z "$SSH_PREFIX" ] && echo 'local' || echo 'via ssh'))"
pretty blue "Route: $($CLOUD && echo 'CLOUD (escalate)' || echo 'LOCAL (reorder)')   message_id=$MSG_ID"
pretty yellow "SEND SEAM: this script never approves the draft and never calls the"
pretty yellow "           mailbox-send webhook — Gmail Reply is never reached."

# ───────────────────────── preconditions ─────────────────────────
pretty blue ""
pretty blue "── Preconditions ──"

# 0. Postgres reachable + schema present.
have_drafts=$(psql_q "SELECT to_regclass('mailbox.drafts') IS NOT NULL;") || {
  pretty red "FATAL: cannot reach Postgres in ${PG_CONTAINER} on ${HOST}."; exit 2; }
if [[ "$have_drafts" != "t" ]]; then
  pretty red "FATAL: mailbox.drafts table not found — has the migrate profile run?"; exit 2
fi
pretty green "  ✓ Postgres reachable, mailbox schema present"

# 1. Classify + Draft sub-workflows must exist and be active (n8n 2.x: all
#    four MailBOX* must be active or executeWorkflow throws "not active").
#    This mirrors the mailbox-n8n-verify gate; we check the two we depend on.
for wf in MailBOX-Classify MailBOX-Draft; do
  active=$(psql_q "SELECT active FROM workflow_entity WHERE name='$(sql_lit "$wf")';")
  if [[ "$active" != "t" ]]; then
    pretty red "FATAL: n8n workflow '$wf' is not active (active='$active')."
    pretty red "       On n8n 2.x all four MailBOX* workflows must be active or"
    pretty red "       executeWorkflow throws. Run the n8n-verify gate:"
    pretty red "         docker compose --profile n8n-verify run --rm mailbox-n8n-verify"
    exit 2
  fi
  pretty green "  ✓ n8n workflow '$wf' is active"
done

# ───────────────────────── cleanup helper + trap ─────────────────────────
cleanup_synthetic() {
  # Remove draft(s) + classification_log + inbox row for the synthetic id.
  # Ordered child→parent; all keyed on the deterministic message_id so we
  # never touch real data. Errors are swallowed (best-effort teardown).
  psql_q "
    WITH ib AS (SELECT id FROM mailbox.inbox_messages WHERE message_id='$(sql_lit "$MSG_ID")')
    DELETE FROM mailbox.drafts WHERE inbox_message_id IN (SELECT id FROM ib);
  " >/dev/null 2>&1 || true
  psql_q "
    WITH ib AS (SELECT id FROM mailbox.inbox_messages WHERE message_id='$(sql_lit "$MSG_ID")')
    DELETE FROM mailbox.classification_log WHERE inbox_message_id IN (SELECT id FROM ib);
  " >/dev/null 2>&1 || true
  psql_q "DELETE FROM mailbox.inbox_messages WHERE message_id='$(sql_lit "$MSG_ID")';" \
    >/dev/null 2>&1 || true
}

# shellcheck disable=SC2329  # invoked indirectly via the EXIT trap below
teardown() {
  local rc=$?
  if $KEEP; then
    pretty yellow "── --keep set: leaving synthetic rows (message_id=$MSG_ID) in place ──"
  else
    pretty blue "── Cleanup ──"
    cleanup_synthetic
    pretty green "  ✓ synthetic rows removed (message_id=$MSG_ID)"
  fi
  exit "$rc"
}
trap teardown EXIT

# Idempotency: clear any leftover synthetic rows from a prior aborted run
# BEFORE seeding, so the message_id insert below is clean.
cleanup_synthetic

# ───────────────────────── 1. Seed synthetic inbox row ─────────────────────────
pretty blue ""
pretty blue "── 1. Seed synthetic inbound (ingest) ──"
INBOX_ID=$(psql_q "
  INSERT INTO mailbox.inbox_messages
    (message_id, from_addr, to_addr, subject, body, received_at)
  VALUES
    ('$(sql_lit "$MSG_ID")', '$(sql_lit "$FROM_ADDR")', '$(sql_lit "$TO_ADDR")',
     '$(sql_lit "$SUBJECT")', '$(sql_lit "$BODY")', NOW())
  RETURNING id;
")
if [[ -z "$INBOX_ID" ]]; then
  pretty red "FATAL: failed to insert synthetic inbox_messages row."; exit 2
fi
pretty green "  ✓ inbox_messages id=$INBOX_ID seeded (message_id=$MSG_ID)"

# ───────────────────────── 2. Trigger MailBOX-Classify ─────────────────────────
# Default trigger: the n8n CLI executes the classify sub-workflow against the
# synthetic inbox id. The classify trigger node (executeWorkflowTrigger,
# inputSource=passthrough) reads $json.id; we feed it via a one-item input
# file. This drives the REAL n8n classify→draft plumbing (Qwen3 inference,
# classification-normalize, live-gate, Insert Draft Stub, Trigger Draft Sub),
# not a synthetic HTTP shortcut.
#
# Override the whole trigger with SMOKE_CLASSIFY_TRIGGER if your appliance's
# n8n build needs a different invocation (the script substitutes %ID% with the
# inbox id and %WF% with the classify workflow id).
pretty blue ""
pretty blue "── 2. Trigger MailBOX-Classify (id=$INBOX_ID) ──"

DEFAULT_TRIGGER='printf "[{\"json\":{\"id\":%ID%}}]" > /tmp/smoke-classify-input.json && docker cp /tmp/smoke-classify-input.json '"${N8N_CONTAINER}"':/tmp/smoke-classify-input.json && docker exec '"${N8N_CONTAINER}"' n8n execute --id=%WF% --rawOutput --file=/tmp/smoke-classify-input.json'
TRIGGER_CMD="${SMOKE_CLASSIFY_TRIGGER:-$DEFAULT_TRIGGER}"
TRIGGER_CMD="${TRIGGER_CMD//%ID%/$INBOX_ID}"
TRIGGER_CMD="${TRIGGER_CMD//%WF%/$CLASSIFY_WORKFLOW_ID}"

if ! run_remote "$TRIGGER_CMD" >/dev/null 2>&1; then
  pretty red "  ✗ classify trigger returned non-zero on this n8n build."
  pretty red "    The default trigger uses 'n8n execute --file' to feed {id} to the"
  pretty red "    classify passthrough trigger; some n8n builds reject --file there."
  pretty red ""
  pretty red "    NOTE: a synthetic row inserted directly into inbox_messages will"
  pretty red "    NOT be re-classified by the 5-min schedule trigger — the parent only"
  pretty red "    classifies rows it just inserted from Gmail (gated by 'Only If Newly"
  pretty red "    Inserted'). So the draft will NOT appear on its own; the trigger must"
  pretty red "    succeed. Set SMOKE_CLASSIFY_TRIGGER for your n8n build (see header) —"
  pretty red "    e.g. a REST 'run' invocation — then re-run."
  pretty red "    Trigger command was:"
  pretty red "      $TRIGGER_CMD"
  exit 2
fi
pretty green "  ✓ classify trigger invoked"

# ───────────────────────── 3. Poll + assert the draft ─────────────────────────
pretty blue ""
pretty blue "── 3. Wait for draft (timeout ${TIMEOUT}s) ──"
DRAFT_ID=""
WAITED=0
INTERVAL=3
while [[ $WAITED -lt $TIMEOUT ]]; do
  DRAFT_ID=$(psql_q "
    SELECT d.id FROM mailbox.drafts d
    JOIN mailbox.inbox_messages m ON m.id = d.inbox_message_id
    WHERE m.message_id='$(sql_lit "$MSG_ID")'
    ORDER BY d.id DESC LIMIT 1;
  " || true)
  if [[ -n "$DRAFT_ID" ]]; then break; fi
  sleep "$INTERVAL"
  WAITED=$(( WAITED + INTERVAL ))
  printf '\r  …waiting %ss/%ss' "$WAITED" "$TIMEOUT"
done
echo ""

if [[ -z "$DRAFT_ID" ]]; then
  pretty red "  ✗ no draft appeared within ${TIMEOUT}s for message_id=$MSG_ID"
  pretty red "    Diagnostics:"
  pretty red "      classification_log rows: $(psql_q "SELECT COUNT(*) FROM mailbox.classification_log cl JOIN mailbox.inbox_messages m ON m.id=cl.inbox_message_id WHERE m.message_id='$(sql_lit "$MSG_ID")';" || echo '?')"
  pretty red "      n8n logs:  docker logs ${N8N_CONTAINER} --tail 50"
  exit 1
fi
pretty green "  ✓ draft id=$DRAFT_ID created"

# Pull the draft fields for assertion in one round-trip (pipe-delimited).
ROW=$(psql_q "
  SELECT status || '|' ||
         COALESCE(classification_category,'NULL') || '|' ||
         length(COALESCE(draft_body,'')) || '|' ||
         COALESCE(draft_source,'NULL') || '|' ||
         COALESCE(model,'NULL')
  FROM mailbox.drafts WHERE id=$DRAFT_ID;
")
STATUS="${ROW%%|*}";              REST="${ROW#*|}"
CATEGORY="${REST%%|*}";           REST="${REST#*|}"
BODY_LEN="${REST%%|*}";           REST="${REST#*|}"
DRAFT_SOURCE="${REST%%|*}";       REST="${REST#*|}"
MODEL="${REST%%|*}"

pretty blue ""
pretty blue "── Assertions ──"
fail=0

# status ∈ ACCEPT_STATUSES
status_ok=false
for s in $ACCEPT_STATUSES; do [[ "$STATUS" == "$s" ]] && status_ok=true; done
if $status_ok; then
  pretty green "  ✓ status='$STATUS' (accepted: $ACCEPT_STATUSES)"
else
  pretty red "  ✗ status='$STATUS' not in accepted set: $ACCEPT_STATUSES"
  fail=1
fi

# classification_category set + valid
VALID_CATS="inquiry reorder scheduling follow_up internal spam_marketing escalate unknown"
if [[ -n "$CATEGORY" && "$CATEGORY" != "NULL" ]]; then
  cat_ok=false
  for c in $VALID_CATS; do [[ "$CATEGORY" == "$c" ]] && cat_ok=true; done
  if $cat_ok; then
    pretty green "  ✓ classification_category='$CATEGORY'"
  else
    pretty red "  ✗ classification_category='$CATEGORY' not a known category"
    fail=1
  fi
else
  pretty red "  ✗ classification_category is empty/NULL"
  fail=1
fi

# draft_body non-empty (the LLM produced text). awaiting_cloud is allowed a
# placeholder body while the cloud call is in flight; only enforce non-empty
# for non-awaiting states.
if [[ "$STATUS" == "awaiting_cloud" ]]; then
  pretty yellow "  ~ draft_body length=$BODY_LEN (status awaiting_cloud — body fills on finalize)"
else
  if [[ "${BODY_LEN:-0}" -gt 0 ]]; then
    pretty green "  ✓ draft_body non-empty (length=$BODY_LEN chars)"
  else
    pretty red "  ✗ draft_body is empty (length=0) — LLM produced no text"
    fail=1
  fi
fi

assert_nonempty "draft_source" "$DRAFT_SOURCE" || fail=1
assert_nonempty "model" "$MODEL" || fail=1

pretty blue ""
if [[ $fail -ne 0 ]]; then
  pretty red "═══ PIPELINE SMOKE FAILED ═══"
  exit 1
fi
pretty green "═══ PIPELINE SMOKE PASSED — ingest → classify → draft OK, no email sent ═══"
exit 0
