# The image stdio MCP servers run in (decision D36): Node, Python 3 and uv. The runner starts one
# container per plugin from it, as uid 1000 with a read-only root and no capabilities, on an internal
# network whose only way out is the egress proxy; the plugin's packages are installed into its volume.
# Build it with the stack (`docker compose --profile app build mcp`): the runner never pulls images.
FROM ghcr.io/astral-sh/uv:0.12.23 AS uv

FROM node:24.21.0-bookworm-slim
COPY --from=uv /uv /usr/local/bin/uv
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
 && rm -rf /var/lib/apt/lists/*
USER 1000:1000
ENV HOME=/tmp
