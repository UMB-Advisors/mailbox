#!/usr/bin/env bash
# mb2-spike-backup.sh — recoverable backup of the MailBOX appliance before the
# MBOX-291 (OpenClaw spike) app-layer teardown of MB2.
#
# WHY: MB2 (mailbox.staqs.io) is being repurposed as the OpenClaw test rig.
# Dustin's instruction (2026-05-22): MailBOX must remain restorable on this or
# another box. The primary restore artifact is a LOGICAL pg_dump (portable
# across machines) + .env (carries N8N_ENCRYPTION_KEY without which the
# encrypted Gmail OAuth creds in the n8n tables can't be decrypted).
#
# Run ON MB2:  bash ~/mb2-spike-backup.sh
# Near-zero downtime: only qdrant gets a brief stop/tar/start (RAG is non-gating).
set -euo pipefail

cd "$HOME/mailbox"
TS=$(date +%Y%m%d-%H%M%S)
DIR="$HOME/mailbox-backups/mb2-$TS"
VOL="$DIR/volumes"
mkdir -p "$VOL"
echo "[*] Backup dir: $DIR"

PG_USER=$(grep -E '^POSTGRES_USER=' .env | cut -d= -f2-)
PG_DB=$(grep -E '^POSTGRES_DB=' .env | cut -d= -f2-)
PROJ=mailbox   # docker compose project prefix (volumes are mailbox_*)

# 1) configs + secrets (files only; nothing sensitive printed to stdout)
echo "[*] Copying configs + secrets"
cp .env "$DIR/env.backup"
[ -f Caddyfile ] && cp Caddyfile "$DIR/Caddyfile" || true
cp docker-compose.yml "$DIR/docker-compose.yml"
git rev-parse HEAD > "$DIR/git-head.txt" 2>/dev/null || true
docker compose config > "$DIR/compose-resolved.yml" 2>/dev/null || true   # contains expanded secrets — file only
docker compose images > "$DIR/images.txt" 2>/dev/null || true
docker compose ps > "$DIR/ps.txt" 2>/dev/null || true
uname -a > "$DIR/host-uname.txt" 2>/dev/null || true
cat /etc/nv_tegra_release > "$DIR/l4t-release.txt" 2>/dev/null || true

# 2) Postgres logical dump — captures mailbox schema + all n8n tables (same DB).
#    Custom format (portable, compressed) + plain SQL (human-readable / cross-version).
echo "[*] pg_dump (custom format)"
docker exec mailbox-postgres-1 pg_dump -U "$PG_USER" -d "$PG_DB" -Fc -f /tmp/mb.dump
docker cp mailbox-postgres-1:/tmp/mb.dump "$DIR/postgres-${PG_DB}.dump"
docker exec mailbox-postgres-1 rm -f /tmp/mb.dump
echo "[*] pg_dump (plain SQL, no-owner)"
docker exec mailbox-postgres-1 pg_dump -U "$PG_USER" -d "$PG_DB" --no-owner --clean --if-exists \
  | gzip > "$DIR/postgres-${PG_DB}.sql.gz"
# row-count sanity snapshot for restore verification
docker exec mailbox-postgres-1 psql -U "$PG_USER" -d "$PG_DB" -tA -c \
  "SELECT 'mailbox.drafts='||count(*) FROM mailbox.drafts
   UNION ALL SELECT 'mailbox.sent_history='||count(*) FROM mailbox.sent_history
   UNION ALL SELECT 'mailbox.inbox_messages='||count(*) FROM mailbox.inbox_messages
   UNION ALL SELECT 'public.workflow_entity='||count(*) FROM public.workflow_entity
   UNION ALL SELECT 'public.credentials_entity='||count(*) FROM public.credentials_entity;" \
  > "$DIR/pg-rowcounts.txt" 2>/dev/null || echo "(rowcount probe skipped)" > "$DIR/pg-rowcounts.txt"

# 3) Qdrant — consistent volume tar via brief stop/start (RAG retrieval is non-gating).
#    trap guarantees qdrant restarts even if the tar fails mid-way.
echo "[*] Qdrant consistent snapshot (brief stop)"
docker compose stop qdrant
trap 'docker compose start qdrant >/dev/null 2>&1 || true' EXIT
docker run --rm -v ${PROJ}_qdrant_data:/data:ro -v "$VOL":/backup alpine \
  tar czf /backup/qdrant_data.tgz -C /data .
docker compose start qdrant
trap - EXIT

# 4) Other stateful volumes — hot tar (low write risk; n8n config carries a copy of the key)
echo "[*] Volume tars: n8n_data, caddy_data, caddy_config, kb_uploads"
for v in n8n_data caddy_data caddy_config mailbox_kb_uploads; do
  docker run --rm -v ${PROJ}_${v}:/data:ro -v "$VOL":/backup alpine \
    tar czf "/backup/${v}.tgz" -C /data . && echo "    + ${v}.tgz"
done

# 5) Ollama — record reproducibility instead of a 3.2GB weights tar (image is digest-pinned in .env)
echo "[*] Ollama model inventory + custom Modelfile (weights NOT tarred — re-pullable)"
docker exec mailbox-ollama-1 ollama list > "$DIR/ollama-models.txt" 2>/dev/null || true
docker exec mailbox-ollama-1 ollama show qwen3:4b-ctx4k --modelfile \
  > "$DIR/qwen3-4b-ctx4k.Modelfile" 2>/dev/null || true

# 6) restore instructions travel WITH the backup
cat > "$DIR/RESTORE.md" <<'EOF'
# Restore MailBOX from this backup

Restores onto a fresh box (or MB2 reflashed) with Docker + the repo cloned.

1. Clone the repo at the recorded commit: see `git-head.txt`.
2. Put `env.backup` back as `.env` in the repo root (carries N8N_ENCRYPTION_KEY,
   POSTGRES_PASSWORD, CLOUDFLARE_API_TOKEN, OLLAMA_CLOUD_API_KEY, basic-auth hash).
   If restoring to a DIFFERENT hostname, update `DOMAIN` and re-provision DNS.
3. Bring up datastores only:  `docker compose up -d postgres`
4. Restore Postgres (custom format is authoritative):
   `cat postgres-<DB>.dump | docker exec -i mailbox-postgres-1 pg_restore -U <USER> -d <DB> --clean --if-exists`
   (or `zcat postgres-<DB>.sql.gz | docker exec -i mailbox-postgres-1 psql -U <USER> -d <DB>`)
   PG password + USER/DB are in env.backup. Row-count baseline: `pg-rowcounts.txt`.
5. Restore volumes (n8n binaryData, caddy certs, qdrant, kb uploads):
   for v in n8n_data caddy_data caddy_config mailbox_kb_uploads qdrant_data; do
     docker volume create mailbox_$v
     docker run --rm -v mailbox_$v:/data -v "$PWD/volumes":/backup alpine \
       sh -c "cd /data && tar xzf /backup/$v.tgz"
   done
6. Re-pull / rebuild Ollama models per `ollama-models.txt` + `qwen3-4b-ctx4k.Modelfile`
   (image digest is pinned in env.backup OLLAMA_IMAGE).
7. `docker compose up -d --build`
8. Verify n8n: all four MailBOX* workflows active (n8n-verify profile) and that the
   Gmail credential decrypts (open it in the n8n editor — proves N8N_ENCRYPTION_KEY matched).
EOF

# 7) checksums
echo "[*] Computing checksums"
( cd "$DIR" && find . -type f ! -name SHA256SUMS -exec sha256sum {} + > SHA256SUMS )

echo "[*] DONE. Size:"
du -sh "$DIR"
echo "$DIR"
