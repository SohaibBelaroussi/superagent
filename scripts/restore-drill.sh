#!/usr/bin/env bash
# Restore drill (decision D41): restores a backup into throwaway containers on a network with no way
# out, and checks it. Nothing of the running stack is touched, and nothing is left behind: containers
# go with their volumes, then the network.
#   1. Postgres: the dump restores, and every table's row count matches the backup's manifest.
#   2. The API starts on the restored database and answers /ready, and the encryption key (the
#      environment's, else .env's) opens the restored provider keys and secrets.
#   3. Documents: every document's file is in the mirror (or among the files deleted since), and the
#      mirror copies into a fresh SeaweedFS with no difference.
#   4. Task files and plugins' MCP volumes: every archive reads back whole.
#
#   scripts/restore-drill.sh [backup folder]   (default: the newest complete backup in $BACKUP_DIR)
#   BACKUP_DIR  where backups are (default ./backups; from the environment or .env)
#   API_IMAGE   the API image to start (default superagent-api:$SUPERAGENT_VERSION, else :local)
set -euo pipefail
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.."

log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
env_value() { sed -n "s/^$1=//p" .env 2>/dev/null | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"; }
setting() { local value="${!1:-}"; [ -n "$value" ] || value=$(env_value "$1"); printf '%s' "${value:-$2}"; }

BACKUP_DIR=$(setting BACKUP_DIR ./backups)
backup=${1:-$(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name '[0-9]*T*Z' 2>/dev/null | sort | tail -n 1)}
if [ -z "$backup" ] || [ ! -f "$backup/postgres.dump" ] || [ ! -f "$backup/manifest.txt" ]; then
  log "No complete backup to drill (run scripts/backup.sh)"
  exit 1
fi
# The documents mirror and the files deleted since sit next to the backup's folder.
root=$(dirname "$backup")
version=$(setting SUPERAGENT_VERSION '')
api_image=${API_IMAGE:-superagent-api:${version:-local}}
if ! docker image inspect "$api_image" >/dev/null 2>&1; then
  log "No $api_image image to start on the restore: set API_IMAGE, or SUPERAGENT_VERSION in .env"
  exit 1
fi
id="sa-drill-$$-$RANDOM"
net="$id-net"
work=$(mktemp -d)
cleanup() {
  docker rm -fv "$id-pg" "$id-api" "$id-s3" >/dev/null 2>&1 || true
  docker network rm "$net" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
docker network create --internal "$net" >/dev/null
log "Drilling $backup"

# 1. Postgres.
docker run -d --name "$id-pg" --network "$net" -e POSTGRES_USER=superagent -e POSTGRES_PASSWORD=drill \
  -e POSTGRES_DB=superagent pgvector/pgvector:pg17 >/dev/null
# Over TCP: the image's first, setup-only server listens on its socket only.
for _ in $(seq 1 60); do
  docker exec "$id-pg" pg_isready -h 127.0.0.1 -U superagent -d superagent -q && break
  sleep 1
done
docker exec "$id-pg" pg_isready -h 127.0.0.1 -U superagent -d superagent -q
docker cp "$backup/postgres.dump" "$id-pg:/tmp/postgres.dump"
docker exec "$id-pg" pg_restore -U superagent -d superagent --no-owner --no-privileges \
  --single-transaction --exit-on-error /tmp/postgres.dump
psql() { docker exec -i "$id-pg" psql -U superagent -d superagent -qAtX -v ON_ERROR_STOP=1 "$@"; }
psql <scripts/lib/manifest.sql >"$work/restored.txt"
if ! diff "$backup/manifest.txt" "$work/restored.txt" >"$work/diff.txt"; then
  log "Row counts differ from the backup's manifest:"
  cat "$work/diff.txt" >&2
  exit 1
fi
tables=$(wc -l <"$work/restored.txt" | tr -d ' ')
rows=$(awk -F'|' '{ sum += $2 } END { print sum + 0 }' "$work/restored.txt")
log "Postgres restored: $tables tables, $rows rows, as in the manifest"

# 2. The API on the restored database. Secrets go by name (-e NAME), never on the command line.
# The key from the environment, else .env: drill with the key you keep elsewhere to check it too.
SUPERAGENT_ADMIN_TOKEN=$(setting SUPERAGENT_ADMIN_TOKEN '')
SUPERAGENT_ENCRYPTION_KEY=$(setting SUPERAGENT_ENCRYPTION_KEY '')
export SUPERAGENT_ADMIN_TOKEN SUPERAGENT_ENCRYPTION_KEY
docker run -d --name "$id-api" --network "$net" -e NODE_ENV=production -e HOST=0.0.0.0 -e PORT=4111 \
  -e "DATABASE_URL=postgres://superagent:drill@$id-pg:5432/superagent" \
  -e SUPERAGENT_ADMIN_TOKEN -e SUPERAGENT_ENCRYPTION_KEY -e LOG_LEVEL=warn "$api_image" >/dev/null
check=
for _ in $(seq 1 90); do
  check=$(docker exec "$id-api" node -e \
    "fetch('http://127.0.0.1:4111/ready').then(r=>r.json()).then(j=>{if(j.status!=='ready')process.exit(1);console.log(j.checks?.encryptionKey??'unknown')}).catch(()=>process.exit(1))" \
    2>/dev/null) && break
  check=
  [ "$(docker inspect -f '{{.State.Running}}' "$id-api")" = true ] || break
  sleep 2
done
if [ -z "$check" ]; then
  log "The API did not get ready on the restored database:"
  docker logs --tail 50 "$id-api" >&2 || true
  exit 1
fi
case "$check" in
  ok) log "The API is ready on the restored database, and the key opens its secrets" ;;
  empty) log "The API is ready on the restored database (it holds no sealed keys or secrets)" ;;
  *)
    log "SUPERAGENT_ENCRYPTION_KEY doesn't open the restored secrets ($check): use the backup's .env"
    exit 1
    ;;
esac

# 3. Documents: every document's file is in the backup, and the mirror restores into a fresh SeaweedFS.
mirror="$root/s3/knowledge"
mkdir -p "$work/none"
[ -d "$mirror" ] || mirror="$work/none"
psql -c 'select object_key from app.knowledge_documents' >"$work/documents.txt"
documents=0
deleted_since=0
missing=()
while IFS= read -r object; do
  [ -n "$object" ] || continue
  documents=$((documents + 1))
  if [ -f "$mirror/$object" ]; then
    continue
  elif compgen -G "$root/s3-deleted/*/$object" >/dev/null; then
    deleted_since=$((deleted_since + 1))
  else
    missing+=("$object")
  fi
done <"$work/documents.txt"
if [ "${#missing[@]}" -gt 0 ]; then
  log "${#missing[@]} of $documents documents' files are in no mirror, e.g. ${missing[0]}"
  exit 1
fi
if [ "$deleted_since" -gt 0 ]; then
  log "$deleted_since documents' files were deleted after this backup: they are in $root/s3-deleted"
fi
key=drill$RANDOM$RANDOM
secret=drillsecret$RANDOM$RANDOM$RANDOM
docker run -d --name "$id-s3" --network "$net" -e "AWS_ACCESS_KEY_ID=$key" -e "AWS_SECRET_ACCESS_KEY=$secret" \
  chrislusf/seaweedfs:4.48 mini -dir=/data "-ip=$id-s3" -bucket=knowledge -master.telemetry=false \
  -admin.ui=false >/dev/null
for _ in $(seq 1 60); do
  docker exec "$id-s3" wget -q -O /dev/null http://127.0.0.1:8333/healthz 2>/dev/null && break
  sleep 1
done
# The mirror goes in as a tar stream: no host paths to translate.
files=$(tar cf - -C "$mirror" . | docker run -i --rm --network "$net" \
  -e RCLONE_CONFIG=/dev/null -e RCLONE_CONFIG_DRILL_TYPE=s3 -e RCLONE_CONFIG_DRILL_PROVIDER=SeaweedFS \
  -e "RCLONE_CONFIG_DRILL_ENDPOINT=http://$id-s3:8333" -e "RCLONE_CONFIG_DRILL_ACCESS_KEY_ID=$key" \
  -e "RCLONE_CONFIG_DRILL_SECRET_ACCESS_KEY=$secret" --entrypoint sh rclone/rclone:1.75.1 -c \
  'mkdir -p /tmp/r && tar xf - -C /tmp/r && rclone copy /tmp/r drill:knowledge --log-level ERROR &&
   rclone check /tmp/r drill:knowledge --one-way --log-level ERROR && find /tmp/r -type f | wc -l')
log "Documents: $documents in the database, all in the backup; $(echo "$files" | tr -d ' ') files restored and identical"

# 4. Task files and plugins' MCP volumes: each archive reads back whole.
for archive in "$backup/workspaces.tar.gz" "$backup"/mcp/*.tar.gz; do
  [ -f "$archive" ] || continue
  entries=$(tar tzf "$archive" | wc -l | tr -d ' ')
  log "$(basename "$archive"): $entries entries, intact"
done
log "Restore drill passed"
