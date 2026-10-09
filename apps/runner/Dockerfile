# syntax=docker/dockerfile:1.7
# Build context: repository root (see compose.yaml).
ARG NODE_VERSION=24.21.0

FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

# --- build: install the runner's dependencies, bundle it, assemble production node_modules ---
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
    pnpm install --frozen-lockfile --filter @superagent/runner...
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/runner apps/runner
RUN pnpm --filter @superagent/runner build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @superagent/runner deploy --prod --legacy /out

# --- runtime: the bundle and its production dependencies, as the node user ---
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    RUNNER_HOST=0.0.0.0 \
    RUNNER_PORT=8080
WORKDIR /app
COPY --from=build --chown=node:node /out ./
# The seccomp profile browsers run under (loaded by BrowserContainers, RUNNER_BROWSER_SECCOMP=auto).
COPY --chown=node:node infra/browser/seccomp.json ./seccomp/chromium.json
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.RUNNER_PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "--enable-source-maps", "dist/main.mjs"]
