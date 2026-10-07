# Running superagent on your server

How the stack runs on a Linux server (decision D42). It runs prebuilt images under rootless Docker and is reached over your tailnet with `tailscale serve`.

The steps assume:
- Ubuntu 24.04. Any Linux with systemd and cgroup v2 works.
- A user that owns the deployment.
- Tailscale on the server.

Commands marked `sudo` need root. Everything else runs as that user.

## 1. Rootless Docker

1. Install Docker from its own apt repository ([docs.docker.com/engine/install/ubuntu](https://docs.docker.com/engine/install/ubuntu/)), with the rootless extras and the compose plugin:

   ```bash
   sudo apt-get install -y uidmap dbus-user-session slirp4netns \
     docker-ce docker-ce-cli containerd.io docker-ce-rootless-extras docker-compose-plugin
   ```

2. Turn off the system-wide (rootful) daemon. The rootless setup refuses to run while its socket is writable:

   ```bash
   sudo systemctl disable --now docker.service docker.socket
   ```

3. As the deployment user, set up rootless Docker and let it run without a login session:

   ```bash
   dockerd-rootless-setuptool.sh install
   sudo loginctl enable-linger "$USER"
   echo 'export DOCKER_HOST=unix://$XDG_RUNTIME_DIR/docker.sock' >> ~/.profile
   ```

4. **Let your containers have limits.** Without cgroup delegation, rootless Docker accepts memory, CPU and process limits and silently ignores them. The runner then refuses to start any container, and the attention inbox says so.

   ```bash
   sudo mkdir -p /etc/systemd/system/user@.service.d
   printf '[Service]\nDelegate=cpu cpuset io memory pids\n' | sudo tee /etc/systemd/system/user@.service.d/delegate.conf
   sudo systemctl daemon-reload
   ```

   Log out and back in (or reboot), then check that this prints `true true true`:

   ```bash
   docker info --format '{{.MemoryLimit}} {{.CpuCfsQuota}} {{.PidsLimit}}'
   ```

5. **Chromium's sandbox** needs unprivileged user namespaces, which Ubuntu 24.04 restricts:

   ```bash
   echo 'kernel.apparmor_restrict_unprivileged_userns=0' | sudo tee /etc/sysctl.d/60-superagent.conf
   sudo sysctl --system
   ```

6. **Rotate the logs** of the containers the runner creates (compose rotates its own services' logs). Put this in `~/.config/docker/daemon.json`, then run `systemctl --user restart docker`:

   ```json
   { "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "3" } }
   ```

## 2. The code and the images

The server builds nothing. Build a release on your PC:

```bash
pnpm release 0.9.0 --save
scp release/superagent-0.9.0.tar.gz release/superagent-0.9.0.tar.gz.sha256 server:
```

This writes `release/superagent-0.9.0.tar.gz` and its sha256.

On the server, check out the same commit and load the images:

```bash
git clone https://github.com/SohaibBelaroussi/superagent.git ~/superagent
cd ~/superagent && git checkout <the release's commit>
(cd ~ && sha256sum -c superagent-0.9.0.tar.gz.sha256)
docker load -i ~/superagent-0.9.0.tar.gz
```

Compose pulls Postgres, SeaweedFS, SearXNG, Crawl4AI and rclone itself.

## 3. Configuration

Copy `.env.example` to `.env`.

**Generate new secrets** with the commands in `.env.example`:
- `POSTGRES_PASSWORD`
- `SUPERAGENT_ADMIN_TOKEN`
- `SUPERAGENT_ENCRYPTION_KEY`
- `S3_ACCESS_KEY`, `S3_SECRET_KEY`
- `RUNNER_TOKEN`
- `CRAWL4AI_API_TOKEN`
- `SEARXNG_SECRET`
- `STUDIO_TOKEN` (optional)

**Add these for the server:**

```ini
SUPERAGENT_VERSION=0.9.0
# Rootless Docker's socket: echo $XDG_RUNTIME_DIR/docker.sock
DOCKER_SOCKET=/run/user/1000/docker.sock
# Its group as containers see it (usually 0):
#   docker run --rm -v $XDG_RUNTIME_DIR/docker.sock:/s alpine stat -c %g /s
DOCKER_SOCKET_GID=0
# Plain `docker compose ...` then uses the production overrides and the app profile.
COMPOSE_FILE=compose.yaml:compose.prod.yaml
COMPOSE_PROFILES=app
```

Keep a copy of `.env` somewhere other than the server, such as a password manager. Without its `SUPERAGENT_ENCRYPTION_KEY`, no backup's provider keys or secrets can be opened.

## 4. Start

```bash
docker compose up -d --wait
curl -s http://127.0.0.1:4112/ready
```

Only the API is published, on `127.0.0.1:4112`. Postgres, storage and the web tools have no ports outside Docker.

## 5. On your tailnet

1. Enable HTTPS certificates for the tailnet once, in the admin console (DNS, HTTPS certificates). The CLI prints the link if they are off.
2. Run:

   ```bash
   sudo tailscale set --operator="$USER"   # once: manage serve without sudo
   tailscale serve --bg --https=443 http://127.0.0.1:4112
   tailscale serve status
   ```

The API is then at `https://<server>.<tailnet>.ts.net`, with streaming and WebSockets passed through. `--bg` keeps it across reboots, and `tailscale serve reset` removes it.

## 6. After the first start

- Run `GET /v1/attention`: it should list no health problems.
- Add your provider and its prices (`PUT /v1/providers/{id}/prices`), so task cards show costs.
- Set up daily backups and an off-site copy, as described in [backups.md](backups.md).
- For upgrades, see [upgrade.md](upgrade.md).
