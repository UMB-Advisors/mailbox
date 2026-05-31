#!/usr/bin/env bash
# Spike §5.2 / DR-57 — bootstrap gbrain with the test account's SENT folder so
# the your-voice model is non-empty BEFORE the arm-B run. A cold Hermes unfairly
# handicaps the treatment; the whole NC-41 value claim rests on the voice model
# existing. This also dogfoods the DR-57 bootstrap mechanics.
#
#   ./21-gbrain-bootstrap.sh
#
# Reference (mailbox2): gbrain v0.41.x, entrypoint ~/gbrain-src/src/cli.ts run
# via bun; engine pglite by default; embeddings ollama:nomic-embed-text@768d;
# MCP-published to Hermes (mcp_servers.gbrain, publish_skills: true).
set -euo pipefail
OUT="${OUT_DIR:-./out}"; mkdir -p "$OUT"
GBRAIN_CLI="${GBRAIN_CLI:-$HOME/gbrain-src/src/cli.ts}"
BUN="${BUN:-$HOME/.bun/bin/bun}"
SRC="$OUT/sent-corpus.jsonl"

# 1) Export the test account's sent history (the voice corpus) from the appliance
#    Postgres. MailBOX archives sent replies to mailbox.sent_history.
echo "[$(date -u +%H:%M:%S)] exporting sent corpus → $SRC"
docker compose exec -T postgres psql -U "${POSTGRES_USER:-mailbox}" -d "${POSTGRES_DB:-mailbox}" -tA -c "
  SELECT row_to_json(t) FROM (
    SELECT message_id, recipient, subject, body, sent_at, classification_category AS category
    FROM mailbox.sent_history
    ORDER BY sent_at DESC
    LIMIT ${SENT_LIMIT:-300}
  ) t;" | sed '/^$/d' > "$SRC"
echo "  exported $(wc -l < "$SRC" | tr -d ' ') sent messages"

# 2) Ingest into gbrain.
# TODO(confirm-on-bench): the exact gbrain ingest verb. The CLI exposes
# init/migrate/serve/jobs; ingest is likely `remember`/`write`/`ingest` or via
# the MCP memory tool. Confirm with:  "$BUN" run "$GBRAIN_CLI" --help
#
# Two supported paths — pick whichever the installed gbrain build offers:
#
# (A) Direct gbrain CLI (preferred once the verb is confirmed):
#       while read -r line; do
#         "$BUN" run "$GBRAIN_CLI" remember --source sent --json "$line"
#       done < "$SRC"
#
# (B) Via Hermes (gbrain is MCP-published, memory_enabled=true) — let Hermes
#     write each sent reply to memory. Slower but uses the live wiring:
#       while read -r line; do
#         hermes -z "Remember this email I sent (for voice/style memory), do not reply: $line" --yolo >/dev/null
#       done < "$SRC"
echo "[$(date -u +%H:%M:%S)] gbrain ingest is a TODO gate — see paths (A)/(B) in this script."
echo "  Confirm the ingest verb:  $BUN run $GBRAIN_CLI --help"
echo "  Then uncomment path (A) or (B) and re-run."

cat <<'NOTE'

--- gbrain storage: PGlite (reference) vs shared Postgres 17 (option) ---
For THIS spike, keep the default PGlite engine (zero-config, isolates the
variable, matches mailbox2). gbrain ALSO supports a Postgres-server engine:

    gbrain init --url 'postgresql://mailbox:<pw>@postgres:5432/mailbox?options=-csearch_path%3Dgbrain'
    # then in pg:  CREATE SCHEMA gbrain;  CREATE EXTENSION vector;   (requires pgvector)
    gbrain migrate --to <engine>           # move an existing PGlite brain onto it

Integrating into the appliance Postgres means: (1) add pgvector to the pg image
(postgres:17-alpine ships WITHOUT it; MailBOX uses Qdrant for vectors) — switch
to pgvector/pgvector:pg17 or build the extension in; (2) isolate in a dedicated
`gbrain` schema, never mailbox.*. Treat as a post-GREEN productization choice
and a FOOTPRINT LEVER if Q1/SM-97 comes back MARGINAL (one pg process vs a
separate bun+PGlite heap may reclaim headroom). Measure both if it matters.
NOTE
