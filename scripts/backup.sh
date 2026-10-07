#!/usr/bin/env bash
# Backs up superagent (decision D41) into $BACKUP_DIR/<UTC time>/:
#   postgres.dump     the database (pg_dump custom format; traces' rows left out)
#   manifest.txt      every table's row count, from the same snapshot as the dump
#   workspaces.tar.gz the task files (the runner's workspaces volume)
# and mirrors the documents bucket into $BACKUP_DIR/s3/ (files deleted since the last run are moved to
# $BACKUP_DIR/s3-deleted/<UTC time>/). The last $BACKUP_KEEP backups are kept.
#
# Run it where the stack runs, from the repository folder (compose.yaml and .env). Keep a copy of .env
# somewhere else: without SUPERAGENT_ENCRYPTION_KEY a restored database's keys and secrets can't be
# opened. Browser identities' volumes (signed-in cookies) are not backed up: sign in again after a loss.
#
#   BACKUP_DIR      where backups go (default ./backups)
#   BACKUP_KEEP     how many to keep (default 14)
#   COMPOSE_FILES   compose files, e.g. "-f compose.yaml -f compose.prod.yaml" (default: compose.yaml)
#   WORKSPACES_VOLUME  the runner's workspaces volume (default superagent-workspaces)
set -euo pipefail
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.."

export BACKUP_DIR=${BACKUP_DIR:-./backups}
keep=${BACKUP_KEEP:-14}
workspaces=${WORKSPACES_VOLUME:-superagent-workspaces}
# shellcheck disable=SC2206
compose=(docker compose ${COMPOSE_FILES:-})
stamp=$(date -u +%Y%m%dT%H%M%SZ)
dest="$BACKUP_DIR/$stamp"
log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
env_value() { sed -n "s/^$1=//p" .env 2>/dev/null | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"; }

mkdir -p "$dest"
trap 'log "Backup failed; $dest is incomplete"; exit 1' ERR

# 1. Postgres. A session holds one snapshot while it counts every table and pg_dump dumps it, so the
#    manifest describes exactly what the dump holds, even while the stack is working.
log "Dumping Postgres"
coproc PSQL { "${compose[@]}" exec -T postgres psql -U superagent -d superagent -qAtX -v ON_ERROR_STOP=1; }
to_psql=${PSQL[1]}
from_psql=${PSQL[0]}
echo "begin isolation level repeatable read read only;" >&"$to_psql"
echo "select pg_export_snapshot();" >&"$to_psql"
read -r -t 60 snapshot <&"$from_psql"
{ cat scripts/lib/manifest.sql; echo "select '--end--';"; } >&"$to_psql"
: >"$dest/manifest.txt"
line=
while read -r -t 300 line <&"$from_psql"; do
  [ "$line" = "--end--" ] && break
  printf '%s\n' "$line" >>"$dest/manifest.txt"
done
[ "$line" = "--end--" ] || { log "Counting rows failed"; exit 1; }
"${compose[@]}" exec -T postgres pg_dump -U superagent -d superagent --snapshot="$snapshot" \
  -Fc -Z zstd:3 --exclude-table-data='mastra.mastra_ai_spans' >"$dest/postgres.dump"
echo "commit;" >&"$to_psql"
eval "exec ${to_psql}>&-"
wait "$PSQL_PID" || true
log "Postgres: $(wc -l <"$dest/manifest.txt" | tr -d ' ') tables, $(du -h "$dest/postgres.dump" | cut -f1)"

# 2. Task files.
if docker volume inspect "$workspaces" >/dev/null 2>&1; then
  log "Archiving task files"
  docker run --rm --network none -v "$workspaces:/w:ro" alpine:3.22 tar czf - -C /w . >"$dest/workspaces.tar.gz"
else
  log "No task files yet ($workspaces does not exist)"
fi

# 3. Documents: a mirror of the bucket (rclone, through compose for its network and keys).
if [ -n "$(env_value S3_ACCESS_KEY)" ]; then
  log "Mirroring the documents bucket"
  mkdir -p "$BACKUP_DIR/s3"
  "${compose[@]}" --profile backup run --rm -T rclone \
    sync "live:$(env_value S3_BUCKET | grep . || echo knowledge)" /backup/s3/knowledge \
    --backup-dir "/backup/s3-deleted/$stamp" --checksum --stats-log-level NOTICE
else
  log "Document storage is off (no S3_ACCESS_KEY): nothing to mirror"
fi

# 4. The last $keep backups stay.
for dir in "$BACKUP_DIR" "$BACKUP_DIR/s3-deleted"; do
  [ -d "$dir" ] || continue
  find "$dir" -mindepth 1 -maxdepth 1 -type d -name '[0-9]*T*Z' | sort | head -n -"$keep" | while read -r old; do
    rm -rf "$old"
  done
done
log "Backup done: $dest"
