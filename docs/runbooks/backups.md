# Backups

`scripts/backup.sh` (decision D41) writes `$BACKUP_DIR/<UTC time>/`:

| File | What |
|---|---|
| `postgres.dump` | The database: providers, organization, tasks, memory, secrets (sealed), plugins, usage. Traces' rows are left out: they are pruned anyway and hold whole prompts. |
| `manifest.txt` | Every table's row count, taken in the dump's own snapshot. |
| `workspaces.tar.gz` | The task files. |

It also mirrors the documents bucket into `$BACKUP_DIR/s3/knowledge`. Files deleted since the previous run move to `$BACKUP_DIR/s3-deleted/<time>/`. The last `BACKUP_KEEP` backups are kept (default 14).

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
Environment=BACKUP_DIR=%h/backups/superagent
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

Turn it on, and see how runs went:

```bash
systemctl --user daemon-reload
systemctl --user enable --now superagent-backup.timer
journalctl --user -u superagent-backup
```

With rootful Docker instead, set `BACKUP_USER=<uid>:<gid>` in `.env`. Otherwise the documents mirror is owned by root.

## The drill

```bash
scripts/restore-drill.sh            # the newest backup
scripts/restore-drill.sh backups/20261008T033000Z
```

It restores into throwaway containers on a network with no way out, and checks three things:
- Every table's row count matches the manifest.
- The API starts on the restored database with your current `.env` key.
- The documents copy into a fresh SeaweedFS without a difference.

It leaves nothing behind. CI runs it on every change. Run it yourself now and then, and after changing the server.

## Restoring

Restore from the repository folder on the server. Use the `.env` from the backup's time, because the dump's secrets need its `SUPERAGENT_ENCRYPTION_KEY`.

1. Stop what writes, and empty the database:

   ```bash
   docker compose stop api runner
   docker compose exec -T postgres dropdb -U superagent superagent
   docker compose exec -T postgres createdb -U superagent superagent
   ```

2. Restore the database:

   ```bash
   docker compose exec -T postgres pg_restore -U superagent -d superagent --no-owner --no-privileges \
     --single-transaction --exit-on-error < backups/<time>/postgres.dump
   ```

3. Restore the documents:

   ```bash
   docker compose --profile backup run --rm rclone sync /backup/s3/knowledge live:knowledge
   ```

4. Restore the task files:

   ```bash
   docker run --rm -i -v superagent-workspaces:/w alpine:3.22 \
     sh -c 'find /w -mindepth 1 -delete && tar xzf - -C /w' < backups/<time>/workspaces.tar.gz
   ```

5. Start again:

   ```bash
   docker compose up -d --wait
   ```
