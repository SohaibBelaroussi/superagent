#!/usr/bin/env bash
# Restore drill (decision D41): restores a backup into throwaway containers, on a network with no way
# out, and checks it. Nothing of the running stack is touched, and nothing is left behind.
#   1. Postgres: the dump restores, and every table's row count matches the backup's manifest.
#   2. The API starts on the restored database and answers /ready (with this .env's encryption key, so
#      the backup is usable with the key you kept). Skipped when $API_IMAGE isn't there.
#   3. Documents: the bucket's mirror is copied into a fresh SeaweedFS and compared file by file.
#
#   scripts/restore-drill.sh [backup folder]   (default: the newest in $BACKUP_DIR)
#   BACKUP_DIR  where backups are (default ./backups)
#   API_IMAGE   the API image to start (default superagent-api:local)
set -euo pipefail
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.."

BACKUP_DIR=${BACKUP_DIR:-./backups}
backup=${1:-$(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name '[0-9]*T*Z' 2>/dev/null | sort | tail -n 1)}
[ -n "$backup" ] && [ -f "$backup/postgres.dump" ] || { echo "No backup to drill (run scripts/backup.sh)" >&2; exit 1; }
api_image=${API_IMAGE:-superagent-api:local}
id="sa-drill-$$-$RANDOM"
net="$id-net"
work=$(mktemp -d)
log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
env_value() { sed -n "s/^$1=//p" .env 2>/dev/null | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"; }
cleanup() {
  docker rm -f "$id-pg" "$id-api" "$id-s3" >/dev/null 2>&1 || true
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
docker exec -i "$id-pg" psql -U superagent -d superagent -qAtX -v ON_ERROR_STOP=1 \
  <scripts/lib/manifest.sql >"$work/restored.txt"
if ! diff "$backup/manifest.txt" "$work/restored.txt" >"$work/diff.txt"; then
  log "Row counts differ from the backup's manifest:"
  cat "$work/diff.txt" >&2
  exit 1
fi
tables=$(wc -l <"$work/restored.txt" | tr -d ' ')
rows=$(awk -F'|' '{ sum += $2 } END { print sum + 0 }' "$work/restored.txt")
log "Postgres restored: $tables tables, $rows rows, as in the manifest"

# 2. The API on the restored database. Secrets go by name (-e NAME), never on the command line.
if docker image inspect "$api_image" >/dev/null 2>&1; then
  SUPERAGENT_ADMIN_TOKEN=$(env_value SUPERAGENT_ADMIN_TOKEN)
  SUPERAGENT_ENCRYPTION_KEY=$(env_value SUPERAGENT_ENCRYPTION_KEY)
  export SUPERAGENT_ADMIN_TOKEN SUPERAGENT_ENCRYPTION_KEY
  docker run -d --name "$id-api" --network "$net" -e NODE_ENV=production -e HOST=0.0.0.0 -e PORT=4111 \
    -e "DATABASE_URL=postgres://superagent:drill@$id-pg:5432/superagent" \
    -e SUPERAGENT_ADMIN_TOKEN -e SUPERAGENT_ENCRYPTION_KEY -e LOG_LEVEL=warn "$api_image" >/dev/null
  ready=no
  for _ in $(seq 1 90); do
    if docker exec "$id-api" node -e \
      "fetch('http://127.0.0.1:4111/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
      >/dev/null 2>&1; then
      ready=yes
      break
    fi
    [ "$(docker inspect -f '{{.State.Running}}' "$id-api")" = true ] || break
    sleep 2
  done
  if [ "$ready" != yes ]; then
    log "The API did not get ready on the restored database:"
    docker logs --tail 50 "$id-api" >&2 || true
    exit 1
  fi
  # It read the providers' keys: with another encryption key it would say so.
  if docker logs "$id-api" 2>&1 | grep -q 'secrets could not be decrypted'; then
    log "The API can't open the restored secrets: this .env's SUPERAGENT_ENCRYPTION_KEY is not the backup's"
    exit 1
  fi
  log "The API is ready on the restored database"
else
  log "No $api_image image: the API check is skipped"
fi

# 3. Documents.
if [ -d "$BACKUP_DIR/s3/knowledge" ]; then
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
  tar cf - -C "$BACKUP_DIR/s3" knowledge | docker run -i --rm --network "$net" \
    -e RCLONE_CONFIG=/dev/null -e RCLONE_CONFIG_DRILL_TYPE=s3 -e RCLONE_CONFIG_DRILL_PROVIDER=SeaweedFS \
    -e "RCLONE_CONFIG_DRILL_ENDPOINT=http://$id-s3:8333" -e "RCLONE_CONFIG_DRILL_ACCESS_KEY_ID=$key" \
    -e "RCLONE_CONFIG_DRILL_SECRET_ACCESS_KEY=$secret" --entrypoint sh rclone/rclone:1.75.1 -c \
    'mkdir -p /tmp/r && tar xf - -C /tmp/r && rclone copy /tmp/r/knowledge drill:knowledge &&
     rclone check /tmp/r/knowledge drill:knowledge --one-way && echo "files: $(find /tmp/r/knowledge -type f | wc -l)"' >&2
  log "Documents restored and identical"
else
  log "No documents mirror in $BACKUP_DIR/s3: skipped"
fi
log "Restore drill passed"
