#!/usr/bin/env bash
# Backs up superagent (decision D41) into $BACKUP_DIR/<UTC time>/:
#   postgres.dump      the database (pg_dump custom format; traces' rows left out)
#   manifest.txt       every table's row count, from the same snapshot as the dump
#   workspaces.tar.gz  the task files (the runner's workspaces volume)
#   mcp/<volume>.tar.gz  plugins' MCP volumes (installed packages, servers' data), with .labels
# and mirrors the documents bucket into $BACKUP_DIR/s3/knowledge (files deleted since the previous run
# move to $BACKUP_DIR/s3-deleted/<UTC time>/). A backup is written as <time>.partial and renamed once
# complete; the last $BACKUP_KEEP complete backups are kept. Backups are readable by you only.
#
# Run it where the stack runs, from the repository folder (compose.yaml and .env). Keep a copy of .env
# somewhere else: without SUPERAGENT_ENCRYPTION_KEY a restored database's keys and secrets can't be
# opened. Browser identities' volumes (signed-in cookies) are not backed up: sign in again after a loss.
#
# Settings, from the environment or else from .env:
#   BACKUP_DIR          where backups go (default ./backups)
#   BACKUP_KEEP         how many to keep, at least 1 (default 14)
#   COMPOSE_FILES       compose files, e.g. "-f compose.yaml -f compose.prod.yaml" (default: compose's own,
#                       COMPOSE_FILE in .env included)
#   WORKSPACES_VOLUME   the runner's workspaces volume (default superagent-workspaces)
#   RUNNER_NAME_PREFIX  the runner's container prefix, whose MCP volumes are backed up (default sa-task)
set -euo pipefail
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.."
umask 077

log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
env_value() { sed -n "s/^$1=//p" .env 2>/dev/null | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"; }
setting() { local value="${!1:-}"; [ -n "$value" ] || value=$(env_value "$1"); printf '%s' "${value:-$2}"; }

BACKUP_DIR=$(setting BACKUP_DIR ./backups)
export BACKUP_DIR
keep=$(setting BACKUP_KEEP 14)
workspaces=$(setting WORKSPACES_VOLUME superagent-workspaces)
prefix=$(setting RUNNER_NAME_PREFIX sa-task)
if ! [[ "$keep" =~ ^[1-9][0-9]*$ ]]; then
  log "BACKUP_KEEP must be a whole number from 1 up (it is '$keep')"
  exit 1
fi
# shellcheck disable=SC2206
compose=(docker compose ${COMPOSE_FILES:-})

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
# One backup at a time (a timer and a manual run): a lock folder holding the owner's pid.
lock="$BACKUP_DIR/.lock"
if ! mkdir "$lock" 2>/dev/null; then
  owner=$(cat "$lock/pid" 2>/dev/null || true)
  if [ -n "$owner" ] && kill -0 "$owner" 2>/dev/null; then
    log "Another backup is running (pid $owner)"
    exit 1
  fi
  # No pid yet in a fresh lock: another backup is just starting.
  if [ -z "$owner" ] && [ -n "$(find "$lock" -maxdepth 0 -mmin -1)" ]; then
    log "Another backup is starting"
    exit 1
  fi
  log "Taking over a stale lock (pid ${owner:-unknown} is gone)"
fi
echo $$ >"$lock/pid"
# With the lock held, any other partial backup is one a crash left behind.
find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name '*.partial' -exec rm -rf {} +

stamp=$(date -u +%Y%m%dT%H%M%SZ)
dest="$BACKUP_DIR/$stamp.partial"
mkdir -p "$dest"
finish() {
  status=$?
  # Only ever the partial folder: once renamed, a backup is complete and stays.
  if [ "$status" -ne 0 ] && [ -d "$BACKUP_DIR/$stamp.partial" ]; then
    log "Backup failed: nothing of it is kept"
    rm -rf "$BACKUP_DIR/$stamp.partial"
  fi
  rm -rf "$lock"
  exit "$status"
}
trap finish EXIT

# 1. Postgres. A session holds one snapshot while it counts every table and pg_dump dumps it, so the
#    manifest describes exactly what the dump holds, even while the stack is working.
log "Dumping Postgres"
coproc PSQL { "${compose[@]}" exec -T postgres psql -U superagent -d superagent -qAtX -v ON_ERROR_STOP=1; }
psql_pid=$PSQL_PID
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
wait "$psql_pid" 2>/dev/null || true
log "Postgres: $(wc -l <"$dest/manifest.txt" | tr -d ' ') tables, $(du -h "$dest/postgres.dump" | cut -f1)"

# 2. Task files, and plugins' MCP volumes (each as a tarball, read-only, with no network).
archive() { docker run --rm --network none -v "$1:/v:ro" alpine:3.22 tar czf - -C /v .; }
if docker volume inspect "$workspaces" >/dev/null 2>&1; then
  log "Archiving task files"
  archive "$workspaces" >"$dest/workspaces.tar.gz"
else
  log "No task files yet ($workspaces does not exist)"
fi
mcp_volumes=$(docker volume ls -q --filter "label=superagent.runner=$prefix-mcp" --filter label=superagent.mcp.package)
if [ -n "$mcp_volumes" ]; then
  mkdir -p "$dest/mcp"
  for volume in $mcp_volumes; do
    archive "$volume" >"$dest/mcp/$volume.tar.gz"
    # Its labels as `docker volume create` options: the runner finds its volumes by label.
    docker volume inspect -f '{{range $k, $v := .Labels}}--label={{$k}}={{$v}} {{end}}' "$volume" \
      >"$dest/mcp/$volume.labels"
  done
  log "Plugins' MCP volumes: $(printf '%s\n' "$mcp_volumes" | wc -l | tr -d ' ')"
fi

# 3. Documents: a mirror of the bucket (rclone, through compose for its network and keys).
mkdir -p "$BACKUP_DIR/s3/knowledge"
if [ -n "$(env_value S3_ACCESS_KEY)" ]; then
  log "Mirroring the documents bucket"
  "${compose[@]}" --profile backup run --rm -T rclone \
    sync "live:$(env_value S3_BUCKET | grep . || echo knowledge)" /backup/s3/knowledge \
    --backup-dir "/backup/s3-deleted/$stamp" --checksum --stats-log-level NOTICE
else
  log "Document storage is off (no S3_ACCESS_KEY): nothing to mirror"
fi

# 4. Complete: it counts from now on, and the last $keep stay.
mv "$dest" "$BACKUP_DIR/$stamp"
for dir in "$BACKUP_DIR" "$BACKUP_DIR/s3-deleted"; do
  [ -d "$dir" ] || continue
  find "$dir" -mindepth 1 -maxdepth 1 -type d -name '[0-9]*T*Z' | sort | head -n -"$keep" | while read -r old; do
    rm -rf "$old"
  done
done
log "Backup done: $BACKUP_DIR/$stamp"
