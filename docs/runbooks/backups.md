# Backups

`scripts/backup.sh` (decision D41) writes `$BACKUP_DIR/<UTC time>/`:

| File | What |
|---|---|
| `postgres.dump` | The database: providers, organization, tasks, memory, secrets (sealed), plugins, usage. Traces' rows are left out: they are pruned anyway and hold whole prompts. |
| `manifest.txt` | Every table's row count, taken in the dump's own snapshot. |
| `workspaces.tar.gz` | The task files. |
| `mcp/<volume>.tar.gz`, `.labels` | Plugins' MCP volumes: their servers' installed packages and data. |

It also mirrors the documents bucket into `$BACKUP_DIR/s3/knowledge`. Files deleted since the previous run move to `$BACKUP_DIR/s3-deleted/<time>/`.

How it behaves:
- Each backup is written as `<time>.partial` and renamed when complete. A failed run leaves nothing.
- One backup runs at a time.
- The last `BACKUP_KEEP` are kept (default 14, at least 1).
- `$BACKUP_DIR` is readable by you only.
- `BACKUP_DIR` and `BACKUP_KEEP` come from the environment, or else from `.env`.

**Not in a backup:**
- `.env`. Keep it elsewhere: its `SUPERAGENT_ENCRYPTION_KEY` opens the dump's keys and secrets.
- Browser identities' profiles (signed-in cookies). Sign in again after a loss.
- Traces.

Backups on the server's own disk don't survive that disk. Copy `$BACKUP_DIR` off the server: rsync to another machine, or restic or rclone to cloud storage.

## Daily

Use a systemd user timer. With rootless Docker, the backup runs as you.

`~/.config/systemd/user/superagent-backup.service`:

```ini
[Unit]
Description=superagent backup

[Service]
Type=oneshot
WorkingDirectory=%h/superagent
Environment=DOCKER_HOST=unix://%t/docker.sock
ExecStart=%h/superagent/scripts/backup.sh
```

`~/.config/systemd/user/superagent-backup.timer`:

```ini
[Unit]
Description=Daily superagent backup

[Timer]
OnCalendar=*-*-* 03:30:00
Persistent=true

[Install]
WantedBy=timers.target
```

Put `BACKUP_DIR` (for example `/home/you/backups/superagent`) in `.env`, so the timer, the drill and the restore commands below all use the same folder. Then turn the timer on:

```bash
systemctl --user daemon-reload
systemctl --user enable --now superagent-backup.timer
journalctl --user -u superagent-backup
```

With rootful Docker instead, set `BACKUP_USER=<uid>:<gid>` in `.env`. Otherwise the documents mirror is owned by root.

## The drill

```bash
scripts/restore-drill.sh            # the newest complete backup
scripts/restore-drill.sh "$BACKUP_DIR/20261008T033000Z"
```

It restores into throwaway containers on a network with no way out, and checks four things:
- Every table's row count matches the manifest.
- The API starts on the restored database, and your `.env` key opens its provider keys and secrets. To check the copy of the key you keep elsewhere, give it from the environment, typed so it stays out of your shell history: `read -rs SUPERAGENT_ENCRYPTION_KEY && export SUPERAGENT_ENCRYPTION_KEY && scripts/restore-drill.sh`. The image is `superagent-api:$SUPERAGENT_VERSION`; set `API_IMAGE` to use another.
- Every document's file is in the backup, and the documents copy into a fresh SeaweedFS without a difference.
- The task files and MCP volume archives read back whole.

It leaves nothing behind: no containers, volumes or network. CI runs it on every change. Run it yourself now and then, and after changing the server.

## Restoring

Restore from the repository folder on the server. Use the `.env` from the backup's time: the dump's secrets need its `SUPERAGENT_ENCRYPTION_KEY`, and its `BACKUP_DIR` tells the commands below where the backup is.

```bash
set -a; . ./.env; set +a          # BACKUP_DIR, for the paths below
b="${BACKUP_DIR:-./backups}/<time>"
```

1. **Stop what writes.** Stop the API and the runner, then remove every container the runner created (sandboxes, browsers, MCP servers). They come back as they're needed.

   ```bash
   docker compose stop api runner
   docker ps -aq --filter label=superagent.runner | xargs -r docker rm -f
   ```

2. **The database.**

   ```bash
   docker compose exec -T postgres dropdb -U superagent superagent
   docker compose exec -T postgres createdb -U superagent superagent
   docker compose exec -T postgres pg_restore -U superagent -d superagent --no-owner --no-privileges \
     --single-transaction --exit-on-error < "$b/postgres.dump"
   ```

3. **The documents.** The mirror holds the newest files. For a backup older than the last run, also copy back the files deleted after it, from each `s3-deleted/<time>` later than the backup's:

   ```bash
   docker compose --profile backup run --rm rclone sync /backup/s3/knowledge live:knowledge
   docker compose --profile backup run --rm rclone copy /backup/s3-deleted/<later time> live:knowledge
   ```

4. **The task files.**

   ```bash
   docker run --rm -i -v superagent-workspaces:/w alpine:3.22 \
     sh -c 'find /w -mindepth 1 -delete && tar xzpf - -C /w' < "$b/workspaces.tar.gz"
   ```

5. **Plugins' MCP volumes,** with their labels: the runner finds them by label.

   ```bash
   for archive in "$b"/mcp/*.tar.gz; do
     volume=$(basename "$archive" .tar.gz)
     docker volume rm "$volume" >/dev/null 2>&1 || true
     docker volume create $(cat "$b/mcp/$volume.labels") "$volume" >/dev/null
     docker run --rm -i -v "$volume:/v" alpine:3.22 tar xzpf - -C /v < "$archive"
   done
   ```

6. **Start again:**

   ```bash
   docker compose up -d --wait
   ```
