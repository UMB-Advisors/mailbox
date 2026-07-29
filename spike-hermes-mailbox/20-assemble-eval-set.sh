#!/usr/bin/env bash
# Spike §5.2 — freeze a real test-account eval set (~30-50 inbound) spanning the
# five solo categories, as JSONL for 22-run-ab.mjs.
#
#   ./20-assemble-eval-set.sh [N]            # default 40
#
# Pulls from the appliance Postgres (mailbox.inbox_messages + latest
# classification). Stratifies roughly across categories; include a few
# newsletter/spam so we can confirm neither arm over-drafts.
#
# Output: out/eval-set.jsonl  — one row per line:
#   {message_id,from_addr,to_addr,subject,body_text,category,confidence}
set -euo pipefail
N="${1:-40}"
if ! [[ "$N" =~ ^[0-9]+$ ]]; then echo "N must be a positive integer (got: $N)" >&2; exit 1; fi
OUT="${OUT_DIR:-./out}"; mkdir -p "$OUT"
DEST="$OUT/eval-set.jsonl"
PSQL=( docker compose exec -T postgres psql -U "${POSTGRES_USER:-mailbox}" -d "${POSTGRES_DB:-mailbox}" -tA )

# Stratified: take up to ceil(N/5) per category across the 5 solo buckets,
# preferring the most recent. row_to_json → JSONL. Uses inbox_messages denorm
# (classification, confidence) kept in sync by migration 021 triggers.
SQL=$(cat <<SQL
WITH ranked AS (
  SELECT im.message_id, im.from_addr, im.to_addr, im.subject,
         COALESCE(im.body, im.snippet, '') AS body_text,
         im.classification AS category,
         COALESCE(im.confidence, 0) AS confidence,
         row_number() OVER (PARTITION BY im.classification ORDER BY im.received_at DESC NULLS LAST) AS rn
  FROM mailbox.inbox_messages im
  WHERE im.classification IS NOT NULL
)
SELECT row_to_json(t) FROM (
  SELECT message_id, from_addr, to_addr, subject, body_text, category, confidence
  FROM ranked
  WHERE rn <= GREATEST(1, CEIL(${N}::numeric / 5))
  ORDER BY category, rn
  LIMIT ${N}
) t;
SQL
)

echo "[$(date -u +%H:%M:%S)] assembling up to ${N} inbound → $DEST"
"${PSQL[@]}" -c "$SQL" | sed '/^$/d' > "$DEST"
COUNT=$(wc -l < "$DEST" | tr -d ' ')
echo "[$(date -u +%H:%M:%S)] froze ${COUNT} emails."
echo "--- category distribution ---"
# shellcheck disable=SC2016
node -e 'const fs=require("fs");const c={};for(const l of fs.readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean)){try{const o=JSON.parse(l);c[o.category]=(c[o.category]||0)+1;}catch{}}console.log(c);' "$DEST"
echo "NOTE: review $DEST by hand — confirm it spans client/prospect/vendor-admin/"
echo "      newsletter-noise/personal and that PII is acceptable for blind rating."
