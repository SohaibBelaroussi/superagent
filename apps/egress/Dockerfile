# syntax=docker/dockerfile:1.7
# Build context: repository root (see compose.yaml).
ARG NODE_VERSION=24.21.0

FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

# --- build: bundle the proxy (it has no runtime dependencies) ---
FROM base AS build
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
# The lockfile checks the patches against their hashes, used or not.
COPY patches patches
COPY apps/api/package.json apps/api/
COPY apps/runner/package.json apps/runner/
COPY apps/egress/package.json apps/egress/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @superagent/egress...
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/egress apps/egress
RUN pnpm --filter @superagent/egress build

# --- runtime: the bundle alone, as the node user ---
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    EGRESS_HOST=0.0.0.0 \
    EGRESS_PORT=3128
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/egress/dist ./dist
USER node
EXPOSE 3128
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "require('net').connect(+(process.env.EGRESS_PORT||3128),'127.0.0.1').on('connect',function(){this.end();process.exit(0)}).on('error',()=>process.exit(1))"]
CMD ["node", "--enable-source-maps", "dist/main.mjs"]
