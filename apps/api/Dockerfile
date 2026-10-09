# syntax=docker/dockerfile:1.7
# Build context: repository root (see compose.yaml).
ARG NODE_VERSION=24.21.0

FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

# --- build: install the workspace, bundle the API, build the web app, assemble production node_modules ---
FROM base AS build
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
# The lockfile checks the patches against their hashes, used or not.
COPY patches patches
COPY apps/api/package.json apps/api/
COPY apps/runner/package.json apps/runner/
COPY apps/egress/package.json apps/egress/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/client/package.json packages/client/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @superagent/api... --filter @superagent/web...
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @superagent/api build
# The web app (decision D44): static files the API serves from WEB_DIR. Its data layer is packages/client.
COPY packages/client packages/client
COPY apps/web apps/web
RUN pnpm --filter @superagent/web build
# --legacy: deploy without injectWorkspacePackages; workspace code is already bundled into dist/. The
# phone app's patches (patches/) don't apply to the server's dependencies.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @superagent/api deploy --prod --legacy --config.allow-unused-patches=true /out

# --- runtime: bundle + migrations + production dependencies + the web app, running as the node user ---
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    MASTRA_TELEMETRY_DISABLED=true \
    HOST=0.0.0.0 \
    PORT=4111 \
    WEB_DIR=/app/web
WORKDIR /app
COPY --from=build --chown=node:node /out ./
# Root-owned and read-only for the node user: the API only ever reads the build.
COPY --from=build /repo/apps/web/dist ./web
USER node
EXPOSE 4111
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||4111)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
# Exec form: node is PID 1's child under `init: true` and receives SIGTERM directly.
CMD ["node", "--enable-source-maps", "dist/main.mjs"]
