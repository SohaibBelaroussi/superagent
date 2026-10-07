# The browser profile: Chromium for one task (decision D34). The runner starts it per task as uid 1000
# with a read-only root, no capabilities, the seccomp profile next to this file, on an internal network
# whose only way out is the egress proxy. DevTools listens on loopback only; the runner reaches it with
# `docker exec socat`, so nothing in the container listens on a network.
# Build it with the stack (`docker compose --profile app build browser`): the runner never pulls images.
FROM debian:trixie-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium socat ca-certificates fonts-liberation fonts-noto-color-emoji fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 1000 --create-home --home-dir /home/browser browser \
 && mkdir /profile \
 && chown 1000:1000 /profile

COPY entrypoint.sh /usr/local/bin/browser-entrypoint
RUN chmod 0755 /usr/local/bin/browser-entrypoint

USER 1000:1000
ENV HOME=/tmp XDG_CONFIG_HOME=/tmp/.config XDG_CACHE_HOME=/tmp/.cache
# SIGINT lets Chromium save cookies and remove its profile lock; SIGTERM (Docker's default) loses both.
STOPSIGNAL SIGINT
ENTRYPOINT ["/usr/local/bin/browser-entrypoint"]
