# Upgrading the server

An upgrade loads a new release's images and starts them. The API applies new database migrations as it starts. Migrations only go forward, so the backup taken first is the way back.

## Steps

1. **On your PC**, build the release and copy it over:

   ```bash
   pnpm release 0.9.1 --save
   scp release/superagent-0.9.1.tar.gz release/superagent-0.9.1.tar.gz.sha256 server:
   ```

2. **On the server**, in `~/superagent`:

   ```bash
   scripts/backup.sh                                   # right before: the way back
   (cd ~ && sha256sum -c superagent-0.9.1.tar.gz.sha256)
   docker load -i ~/superagent-0.9.1.tar.gz
   git fetch && git checkout <the release's commit>
   sed -i 's/^SUPERAGENT_VERSION=.*/SUPERAGENT_VERSION=0.9.1/' .env
   docker compose up -d --wait
   ```

3. **Check:**
   - `curl -s http://127.0.0.1:4112/ready`
   - `GET /v1/attention` lists no health problems.
   - A task runs and reports.
   - If a restart cut runs short, their tasks are flagged in the attention inbox. Schedules catch up on fires they missed.

4. **Clean up** old images once the new version works:

   ```bash
   docker image ls 'superagent-*'
   docker image rm superagent-api:0.9.0 superagent-runner:0.9.0 superagent-egress:0.9.0
   ```

## Rolling back

First see whether the new release added migrations: compare `apps/api/drizzle/` between the two commits.

**No new migration.** Point back to the old version:

```bash
git checkout <the old commit>
sed -i 's/^SUPERAGENT_VERSION=.*/SUPERAGENT_VERSION=0.9.0/' .env
docker compose up -d --wait
```

**New migrations.** The old API doesn't run on the new schema:
1. Stop the stack.
2. Restore the backup from step 2. See [Restoring](backups.md#restoring).
3. Start the old version, as above.

Anything done between that backup and the rollback is lost.
