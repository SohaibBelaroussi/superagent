# The "dev" sandbox profile: Node, Python and git for coder agents (decision D10).
# Sandboxes run it as node (uid 1000) with a read-only root, no network and the task's folder at
# /workspace; HOME and caches live on /tmp, a tmpfs. The runner never pulls images: this one is built
# with the stack (`docker compose --profile app build sandbox-dev`).
ARG NODE_VERSION=24.21.0
FROM node:${NODE_VERSION}-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv git ca-certificates procps \
 && rm -rf /var/lib/apt/lists/*

ENV HOME=/tmp \
    LANG=C.UTF-8 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    NPM_CONFIG_CACHE=/tmp/.npm \
    NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /workspace
USER node
CMD ["sleep", "infinity"]
