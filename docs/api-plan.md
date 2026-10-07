# Superagent API: development plan

**Status:** approved 2026-10-07. Targets `@mastra/core` 1.74.0.

**Progress:**
- M0 (foundation): merged in PR #1.
- M1 (providers and models): PR #2. Verified live against the owner's provider (chat, streaming usage, tool calls).
- M2 (agents, departments, tool catalog): done on branch `m2-agents`, PR #3. Verified live: a real model leading a research department delegated to a specialist that searched the web.
- Next: M3 (ledger, board and dispatch).

**Related docs:**
- [decisions.md](decisions.md): what is settled and why.
- [notes/mastra-1.74.md](notes/mastra-1.74.md): verified Mastra facts.
- [spikes/](spikes/): reference code from research.

## 1. Goal and scope

Build one always-on server that runs the organization (chief of staff, departments, specialists) and exposes it through an HTTP API. It ships as Docker images. Clients come after this plan.

**In scope:**
- **Control plane, `/v1`:** tokens, settings, model providers, agent and department definitions, tasks and the board with a live event stream, the attention inbox (approvals), memory and knowledge, task workspaces, browser sessions, and capabilities (MCP servers, skills, plugins, secrets).
- **Runtime, `/api`:** Mastra's built-in routes for chatting with agents, streaming, threads, memory, schedules and background tasks.
- **Execution:** sandbox containers per task, browser containers per task, and self-hosted search and fetch.
- **Packaging:** Compose for this PC and for the server; production images.

**Out of scope here:**
- clients (the web page comes right after)
- chat channels
- use-case departments
- multiple users
- hosting local models

## 2. Stack

| Area | Choice |
|---|---|
| Runtime | Node 24 LTS (22.22 minimum), TypeScript strict, ESM |
| Repo | pnpm 10 workspaces with `injectWorkspacePackages: true` |
| HTTP | Hono + `@hono/node-server`. Mastra mounted on `/api` by `@mastra/hono`; our routers on `/v1` |
| Agents | `@mastra/core` 1.74, `@mastra/memory` 1.35, `@mastra/pg` 1.29. Exact versions pinned and upgraded on purpose |
| Models | Custom gateway `sa` that builds models with `@ai-sdk/openai-compatible` 2.x (`includeUsage: true`) |
| Validation | zod 4. `packages/shared` holds the `/v1` schemas, which clients reuse later |
| API docs | OpenAPI for `/v1` from the zod schemas: `hono-openapi` or `@hono/zod-openapi`, whichever handles zod 4 cleanly (picked in M0). Reference UI at `/v1/docs` in dev |
| Database | Postgres 17 + pgvector (`pgvector/pgvector:pg17`). Mastra in schema `mastra`, ours in `app` with Drizzle 0.45 and migrations at boot |
| Object storage | SeaweedFS S3 (from M4) |
| Build and dev | tsdown for builds, `tsx watch` in dev, Biome for lint and format |
| Tests | Vitest 5. Scripted mock models with in-memory LibSQL for agent flows, Testcontainers Postgres for integration, live suite behind `LIVE_LLM=1` |
| Studio | `mastra studio` in dev, pointed at `:4111`, with its own token |

## 3. Repository layout

```
superagent/
├─ apps/
│  ├─ api/                      # the server
│  │  ├─ src/
│  │  │  ├─ main.ts             # boot + shutdown
│  │  │  ├─ app.ts              # Hono app factory (tests import this)
│  │  │  ├─ config.ts           # env schema, fail fast
│  │  │  ├─ db/                 # pool, drizzle schema (app.*), migrate
│  │  │  ├─ mastra/             # Mastra factory, gateway, memory profiles, chief
│  │  │  ├─ auth/               # ApiTokenAuth, token service
│  │  │  ├─ modules/
│  │  │  │  ├─ providers/       # providers, model discovery, gateway cache
│  │  │  │  ├─ agents/          # definitions, versions, compiler, registry
│  │  │  │  ├─ departments/
│  │  │  │  ├─ ledger/          # tasks, phases, events, artifacts
│  │  │  │  ├─ dispatch/        # chief <-> lead messaging (wraps experimental signals)
│  │  │  │  ├─ attention/       # approvals, decisions outbox, health checks
│  │  │  │  ├─ schedules/
│  │  │  │  ├─ memory/          # profiles, owner profile, knowledge
│  │  │  │  ├─ tools/           # built-in tool catalog
│  │  │  │  ├─ workspace/       # per-task folders, file routes
│  │  │  │  ├─ execution/       # runner client, sandbox + browser adapters
│  │  │  │  └─ capabilities/    # MCP servers, skills, plugins, secrets
│  │  │  └─ routes/             # /v1 routers, SSE
│  │  ├─ drizzle/               # generated migrations
│  │  ├─ test/                  # unit, int, e2e, live
│  │  └─ Dockerfile
│  └─ runner/                   # the only Docker client (M6)
├─ packages/shared/             # zod schemas + types for /v1
├─ compose.yaml                # postgres + `app` profile; later seaweedfs, searxng, crawl4ai, runner
├─ infra/                      # service configs as they arrive (e.g. searxng settings)
├─ docs/                        # this plan, decisions, notes, http walkthroughs, vision
├─ .env.example
└─ package.json · pnpm-workspace.yaml · tsconfig.base.json · biome.json
```

## 4. How the server fits together

### Boot sequence
1. Load and validate config. Exit with a clear message if anything is missing.
2. Open one `pg.Pool` and run Drizzle migrations. The first migration creates schemas `app` and `mastra` and the `vector` extension in `public`.
3. Create `PostgresStore({ pool, schemaName: 'mastra' })` and call `init()`.
4. Load providers and settings into memory caches, and register the `sa` gateway.
5. Register memory profiles (`chief`, `lead`, `specialist`) using the configured embedding and fast models.
6. Register the built-in tool catalog (`mastra.addTool`).
7. Compile every active agent definition and register it. Order doesn't matter, because subagents are looked up lazily. Then register the chief.
8. Make sure every department's inbox thread exists. Schedules fail on missing threads.
9. Build the Hono app:
   - `/health` and `/ready` (public)
   - Mastra on `/api`
   - our routers on `/v1` behind `createAuthMiddleware`
10. Start listening. Then `startWorkers()`, `restartAllActiveWorkflowRuns()`, and a catch-up for schedules that were due while the server was down.

**Shutdown (SIGTERM):**
1. Stop accepting new connections.
2. Close the SSE streams.
3. `mastra.shutdown({ drainTimeout })`.
4. `pool.end()`.

### Route map

| Prefix | Owner | Auth |
|---|---|---|
| `/health`, `/ready` | us | public (no details exposed) |
| `/api/*` | Mastra built-ins: agents, threads, memory, schedules, background tasks, observability | API token |
| `/v1/*` | our control plane | API token (`?apiKey=` accepted for EventSource) |
| `/v1/openapi.json`, `/v1/docs` | us | token; docs UI in dev only |

### Identity and naming
- **Owner:** one user, `owner`.
- **Resources:**
  - chief: `owner`
  - department: `dept:<slug>`
  - specialist: `dept:<slug>-<key>` (Mastra derives this on delegation)
- **Threads:**
  - your chat with the chief: `chief:main`
  - department inbox: `dept:<slug>:inbox`
  - one per task: `task:<id>`
- **Rows:** uuidv7 ids. Tasks also get a short number for display (`#42`).

### Runtime agent registry (spike-verified)
- **Compile.** Each active definition version becomes one `Agent`:
  - static id, name and description
  - model as `sa/<provider>/<model>`
  - a tools record built from the definition's allow-list, with stable keys
  - memory taken from the registry by profile
  - for leads, an `agents` function that looks the specialists up lazily
- **Edit.** Compile the new instance fully, then call `removeAgent(id)` and `addAgent(next, id)` back to back. `addAgent` alone silently ignores an existing id, so the registry wrapper asserts the swap happened.
- **Stable names.** Ids, tool keys and subagent keys stay stable across versions. Agent keys match `[A-Za-z0-9_-]{1,58}`.
- **Caching.** Mastra caches none of the dynamic functions; they also run with an empty context when Studio lists agents. We cache by definition version.
- **Instructions.** Each agent's instructions are a role preamble we own (how to use the ledger tools, how to report), followed by the instructions from the definition, followed by the department context.

### Model gateway
- **Providers table.** Base URL, an encrypted key, optional headers, and a "strict JSON" flag. Held in a cache, refreshed on every write.
- **Resolution.** `sa` resolves `sa/<provider>/<model>` on every request. Adding a provider, editing its URL or rotating its key needs no restart.
- **Model discovery.** We call `GET {baseURL}/models` and store the results.
- **Roles in settings:**
  - `default` (agents fall back to it)
  - `fast` (titles, observational memory, judges)
  - `embedding`

  Mastra's Google default for observational memory is always overridden.
- **Embeddings** use `ModelRouterEmbeddingModel({ providerId, modelId, url, apiKey })`. Changing the embedding model is a restart plus a re-index (dimension ≤ 2000).

### Dispatch: chief and departments
- **`create_task`** (a chief tool, also `POST /v1/tasks`):
  1. Insert the task, using the tool call id as idempotency key.
  2. Create thread `task:<id>` under `dept:<slug>`, with metadata.
  3. Call `lead.sendMessage(brief, { resourceId, threadId, ifIdle: { behavior: 'wake' }, ifActive: { behavior: 'persist' } })`.
  4. Return the task number right away.
- **Ledger tools** work out the current task from the thread id, so they also work for runs started by a schedule.
- **`report_to_chief`** (a lead tool):
  1. Write a ledger event and move the phase.
  2. Call `chief.sendNotificationSignal({ source: 'dept:<slug>', kind, summary, priority, payload: { taskId } }, { resourceId: 'owner', threadId: 'chief:main' })`.

  Urgent reports wake the chief. Others wait until it's idle.
- **Isolation.** Every signal call goes through `modules/dispatch`, because those APIs are `@experimental` in 1.74.

### Ledger and live updates
- **Phases.** Phase machine in code, configurable per department:
  - `inbox` → `queued` → `working` → `waiting` → `review` → `done`
  - also `failed` and `cancelled`
  - a transition policy, e.g. only you close a task unless the department auto-closes
- **Events.** Every change appends a row to `task_events` (`seq` bigserial). After commit we publish a change hint on Mastra pub/sub.
- **Event stream.** `GET /v1/events` (SSE) sends hints and heartbeats. Clients reconnect with `Last-Event-ID` and get the gap replayed from `task_events`.
- **Bridges into the ledger:**
  - background-task stream
  - schedule hooks
  - suspended runs (approvals)
  - a deterministic health check ("working, no events for N minutes, no active run")

### Auth
- **`ApiTokenAuth`:**
  - Looks up the sha256 hash of the token in `app.api_tokens`.
  - Checks revocation, keeps a short cache, and updates `last_used_at`.
  - Returns user `{ id: 'owner' }`.
- **Bootstrap.** The `SUPERAGENT_ADMIN_TOKEN` env token always works, and is used to create the first device tokens.
- **Studio** uses its own `SimpleAuth` token.
- **No EE.** Images run with `NODE_ENV=production`, and `pnpm check` fails on any `*/ee` import.

### Conventions
- **Errors:** `application/problem+json` (status, title, detail, code).
- **Lists:** `?limit=&cursor=`, newest first.
- **IDs:** opaque strings.
- **Timestamps:** ISO-8601 UTC. The schedule timezone defaults to the `timezone` setting.

## 5. Data model (`app` schema)

| Table | Key columns | Milestone |
|---|---|---|
| `api_tokens` | id, name, token_hash (unique), prefix, created_at, last_used_at, revoked_at | M0 |
| `settings` | key (pk), value jsonb. Holds model roles, timezone, concurrency | M1 |
| `providers` | id, slug (unique), name, base_url, api_key_enc, headers_enc, strict_json, enabled, timestamps | M1 |
| `provider_models` | provider_id, model_id, kind (chat or embedding), label, supports_tools, context_window, discovered_at, enabled | M1 |
| `departments` | id, slug, name, description, lead_agent_id, board jsonb (phases, policy), approval_policy jsonb, auto_close, timestamps, archived_at | M2 |
| `agent_definitions` | id, key (unique, stable), name, role (lead or specialist), department_id, active_version_id, timestamps, archived_at | M2 |
| `agent_versions` | id, agent_id, version, description, instructions, model_ref, tools jsonb (key, approval, background), subagents jsonb, memory_profile, workspace jsonb, browser jsonb, skills jsonb, mcp jsonb, created_at | M2 |
| `tasks` | id, number, department_id, parent_task_id, title, brief, phase, priority, due_at, source (owner, chief, schedule, signal), seat_agent_id, thread_id, resource_id, checklist jsonb, progress, revision, idempotency_key (unique), usage jsonb, timestamps, closed_at | M3 |
| `task_events` | seq (bigserial pk), task_id, type, actor, data jsonb, created_at | M3 |
| `artifacts` | id, task_id, kind, title, uri, mime, size, created_at | M3 |
| `knowledge_docs` | id, title, s3_key, mime, size, chunks, status, created_at | M4 |
| `decisions` | id, task_id, kind, payload, state (pending, proposed, approved, declined, done, failed), idempotency_key, attempts, last_error, timestamps | M5 |
| `sandboxes` | id, task_id, container_id, image, state, last_used_at | M6 |
| `browser_identities` | id, name, volume, locked_by_task, timestamps | M7 |
| `secrets`, `mcp_servers`, `skills`, `plugins`, `plugin_versions` | see M8 | M8 |

Mastra keeps its own threads, messages, schedules, background tasks, notifications and traces in schema `mastra`.

## 6. Milestones

Every milestone is done when:
- `pnpm check` passes (typecheck, lint, the EE-import ban, unit and integration tests);
- its end-to-end scenario passes against the packaged stack (`docker compose --profile app up --build`);
- `docs/http/mN-*.http` lets you try it by hand;
- the notes and decisions docs are updated.

Sizes are relative: S, M, L.

### M0. Foundation (M)
**Build:**
- **Repo and tooling:**
  - pnpm workspace, `apps/api`, `packages/shared`
  - tsconfig, Biome, Vitest projects (unit, int), `pnpm check` with the EE-import ban
  - `CLAUDE.md`
  - exclude `docs/spikes/` from lint, typecheck and tests
- **Infra:** `compose.yaml` at the repo root with Postgres (named volume, healthcheck). `.env.example`.
- **Server core:**
  - config schema
  - pool and Drizzle migrations (schemas, extension, `api_tokens`)
  - Mastra factory with `PostgresStore`
  - the Hono app with `/health`, `/ready`, Mastra on `/api` and `/v1` behind auth
  - JSON logging; graceful shutdown
- **Auth:** `ApiTokenAuth`, bootstrap token, `GET /v1/me`, `GET|POST /v1/tokens`, `DELETE /v1/tokens/:id`.
- **API docs:** `/v1` OpenAPI and docs UI.
- **Test harness:**
  - scripted mock model helper
  - in-memory LibSQL fixture
  - Testcontainers Postgres fixture
  - `app.request()` route tests
- **Packaging:** API Dockerfile (multi-stage, `pnpm deploy`), plus the compose `app` profile.
- **Studio:** `pnpm studio` script.

**Small checks:**
- the zod-4 OpenAPI library
- colons in thread ids
- `createAuthMiddleware` on `/v1/*` under the default protected patterns

**Done when:**
- `/health` returns 200 and `/ready` reports the database.
- A test hits every `/v1` route without a token and gets 401; with a token they succeed.
- A revoked token gets 401.
- A test agent driven by the mock model answers through `/api/agents/:id/generate`.
- Data survives `docker compose down && up`.
- The container stops cleanly on SIGTERM within the grace period.

### M1. Providers and models (S)
**Build:**
- **Providers CRUD**, with keys encrypted by AES-256-GCM using `SUPERAGENT_ENCRYPTION_KEY`. Responses never return a key.
- **Model discovery:** `POST /v1/providers/:id/refresh-models`, `GET /v1/providers/:id/models`.
- **Provider test:** `POST /v1/providers/:id/test` runs four checks: plain chat, streaming with usage, a tool call, and an embedding when the model is one.
- **Gateway:** `sa`.
- **Settings:** `GET|PATCH /v1/settings` for model roles, timezone and concurrency.
- **Live suite:** `test/live/`, run against your server from `.env`.

**Checks:**
- Can containers reach your LLM server over Tailscale (by IP or MagicDNS)?
- Your server's compatibility: tool calls, usage in streams, strict JSON, reasoning fields.

**Done when:**
- Your server is added as a provider and its models are listed.
- The test endpoint passes.
- A scratch agent on `sa/<you>/<model>` streams through `/api` with token usage reported.
- A rotated key takes effect without a restart.
- No key appears in logs or responses.

### M2. Agents, departments, tool catalog (L)
**Build:**
- **Agent definitions and versions:**
  - `GET|POST /v1/agents`, `GET|PATCH|DELETE /v1/agents/:id`
  - `PATCH` creates a new version
  - `GET /v1/agents/:id/versions`, `POST /v1/agents/:id/versions/:v/activate`
- **Compiler and registry** with hot swap.
- **Departments:** `GET|POST /v1/departments`, `GET|PATCH|DELETE /v1/departments/:id`, covering lead, members, board and policies.
- **Chief:** defined in code. Its model comes from the `default` role, and its instructions list the departments from cache.
- **Tool catalog v1:**
  - `GET /v1/catalog/tools`
  - a `core` pack (time and date in your timezone)
  - a `web` pack: SearXNG search and Crawl4AI fetch, with both containers added to compose
- **Test departments:** an "Echo" department (mock-friendly) and a "Research" department.

**Done when:**
- The Research department (lead plus one specialist) is created entirely through the API.
- Chatting with the lead through `/api` produces a delegation (`agent-<key>` call) to the specialist, which uses the `web` pack.
- An edit to the specialist applies on the next run without a restart.
- An archived agent disappears from `/api/agents`.
- Rollback to an earlier version works.

### M3. Ledger, board and dispatch (L)
**Build:**
- **Data:** tasks, events and artifacts tables; the phase machine and policies.
- **Task routes:**
  - `GET|POST /v1/tasks`, `GET|PATCH /v1/tasks/:id`
  - `POST /v1/tasks/:id/messages` (steer or queue)
  - `POST /v1/tasks/:id/cancel`
  - `GET /v1/tasks/:id/events`, `GET /v1/tasks/:id/artifacts`
- **Board:** `GET /v1/board?department=` (cards grouped by phase).
- **Event stream:** `GET /v1/events` (SSE, with replay).
- **Chief tools:** `create_task`, `board_overview`, `inspect_task`, `message_task`, `cancel_task`.
- **Lead tools:** `update_task`, `set_checklist`, `add_artifact`, `report_to_chief`.
- **Plumbing:** the dispatch module; the background-task bridge.

**Spike first:** a lead woken by a signal that keeps working while a specialist runs as a background task (`untilIdle` behaviour on woken runs).

**Done when** both the mock-model end-to-end test and the live test pass this flow:
1. You ask the chief to research something.
2. A task appears in `queued`.
3. The lead wakes on `task:<id>`.
4. Phase, checklist and progress events stream over SSE.
5. The lead reports.
6. The chief's thread receives the notification, and the card sits in `review`.

Two resilience checks:
- Restarting mid-task keeps the task's state.
- An SSE client that reconnects with `Last-Event-ID` gets every missed event.

### M4. Memory and knowledge (M)
**Build:**
- **Memory profiles** (chief, lead, specialist) using the resource and thread conventions above.
- **Owner profile:** working memory with a schema on `owner`, plus `GET|PATCH /v1/profile`. An input processor gives every department agent a read-only copy.
- **Observational memory** on the `fast` model; **semantic recall** on the `embedding` model (pgvector).
- **Department memory view:** `GET /v1/departments/:id/memory`.
- **Knowledge:**
  - SeaweedFS added to compose
  - `POST|GET /v1/knowledge`, `DELETE /v1/knowledge/:id`: upload → S3 → chunk and embed
  - a `knowledge_search` tool

**Done when:**
- A preference set through `/v1/profile` shows up in a department's output.
- A rule a department learned in task A applies in task B.
- An uploaded document is found by a specialist through `knowledge_search`.
- Long threads compress without errors.

### M5. Schedules and attention (M)
**Build:**
- **Schedule tools** for the chief and leads (create, list, pause, resume, delete), defaulting to your timezone.
- **Schedules fire into department inboxes**; the lead turns each firing into tasks.
- **Catch-up at boot**, plus `GET /v1/schedules` (joined with departments).
- **Approvals:** per-tool `requireApproval` set in definitions.
- **Attention routes:** `GET /v1/attention`, `POST /v1/attention/:id/approve|decline`.
- **Decisions outbox** with idempotency, and health-check findings feeding attention.

**Done when:**
- "Every weekday at 9:00, summarize X" creates a schedule, and a manual run creates a task.
- A gated tool suspends the run, the card moves to `waiting`, `/v1/attention` lists it, and approving it resumes the run.
- That approval still works after a restart.
- A stalled task shows up in attention.

### M6. Runner, workspace, sandboxes (L)
**Build:**
- **`apps/runner`**, the only Docker client. Narrow internal API: create, exec, stop, destroy, list.
- **Runner policy:**
  - image allowlist
  - hardening defaults: no capabilities, no-new-privileges, resource limits, non-root, tmpfs
  - per-task workspace subpath mounts
  - an internal-only network
  - a reaper
- **Sandbox adapter in the API:** a custom `WorkspaceSandbox` that calls the runner.
- **Workspace files:** `GET /v1/tasks/:id/files`, `GET /v1/tasks/:id/files/{path}`.
- **Sandboxes:** `GET /v1/sandboxes`, `DELETE /v1/sandboxes/:id`.
- **Base images:** a dev image (node, python, git).

**Done when:**
- A "coder" specialist writes and runs code in a container that can see only `tasks/<id>` and can't reach Postgres.
- Idle sandboxes are reaped.
- A task resumes in its existing sandbox after an API restart.

### M7. Browser (L)
**Build:**
- **Browser containers via the runner:** Chromium + socat, or Steel (picked by spike).
- **Thread manager** for AgentBrowser: one browser per task.
- **Browser identities:** a profile volume and a lock per identity; `GET|POST|DELETE /v1/browser-identities`.
- **Live view and takeover:** an authenticated proxy at `/v1/tasks/:id/browser/stream`. Mastra's own stream route is blocked unless authenticated.
- **`web` pack upgrade:** use the browser for JavaScript-heavy pages.

**Done when:**
- A multi-step browse on a JavaScript site succeeds.
- The live view requires a token.
- A logged-in identity persists across tasks, and a second task on the same identity waits for the lock.

### M8. Capabilities: secrets, MCP, skills, plugins (L)
**Build:**
- **Secrets vault** (encrypted).
- **HTTP MCP servers:** CRUD, attach to agents with a tool allowlist and approvals.
- **stdio MCP servers:** run through the MCP gateway container, which the runner manages.
- **Skills:** import Agent Skills folders and attach them to agents.
- **Plugin installer (Agent Plugins 1.0, with `.codex-plugin` / `.claude-plugin` fallback):**
  1. Fetch and pin.
  2. Validate.
  3. Preview.
  4. Collect secrets.
  5. Map components.
  6. Enable.
- **Catalog:** `GET /v1/capabilities` lists everything an agent can be given.

**Done when:**
- HyperFrames (skills only) installs and is attached to a department.
- An MCP-server plugin runs in its own container and an agent calls its tool.
- Uninstalling cleans everything up.

### M9. Observability, cost, server packaging (M)
**Build:**
- **Tracing:** `@mastra/observability`, tagged `task:<id>` and `dept:<slug>`.
- **Cost:** rollups on tasks, `GET /v1/usage?group=department`.
- **Backups:** `pg_dump` plus S3 sync, with a restore drill.
- **Server deploy:**
  - production compose for your Linux server (rootless Docker, limits, `tailscale serve`)
  - an upgrade runbook

**Done when:**
- Every card shows tokens and cost.
- A backup restores.
- The stack runs on your server from images.

**After M9:** a simple web page, then the mobile app and the full web app. Test use cases can start any time after M3.

## 7. Testing strategy

| Layer | Tooling | Covers |
|---|---|---|
| Unit | Vitest | compiler, phase machine, gateway, crypto, token auth |
| Agent flows | scripted `MockLanguageModelV4` + in-memory LibSQL | chief creates a task, lead delegates, reports, approvals, schedules |
| Routes | `app.request()` | status codes, validation, auth on every route |
| Integration | Testcontainers `pgvector/pgvector:pg17` | migrations, `PostgresStore`, ledger SQL, SSE replay |
| End to end | script against `docker compose --profile app` | each milestone's scenario |
| Live | your LLM server, `LIVE_LLM=1` | real tool calling, streaming usage, embeddings |

## 8. Environments

- **Dev on this PC:**
  - The API runs on the host (`pnpm dev`). Bind mounts on Windows are slow.
  - Compose runs Postgres and the helper containers.
  - `pnpm studio` is optional.
- **Packaged on this PC:** `docker compose --profile app up --build` runs everything in containers in production mode. Used at the end of every milestone.
- **Server (later):** the same images with production overrides, rootless Docker, and `tailscale serve` for HTTPS on the tailnet.
- **Network:**
  - The API binds to `127.0.0.1` in dev.
  - When clients arrive, expose it with `tailscale serve --bg 4111`.
  - Containers reach your LLM server by its Tailscale IP. MagicDNS names may not resolve inside Docker Desktop containers; M1 checks this.

**`.env` keys** (see `.env.example`):
- `POSTGRES_PASSWORD`, `POSTGRES_PORT`, `DATABASE_URL`
- `HOST`, `PORT` (dev server 4111), `API_PORT` (packaged container 4112)
- `SUPERAGENT_ADMIN_TOKEN`
- `SUPERAGENT_ENCRYPTION_KEY` (from M1)
- `STUDIO_TOKEN`
- `CORS_ORIGINS`
- `LOG_LEVEL`
- `DEFAULT_TIMEZONE`
- `MASTRA_TELEMETRY_DISABLED=true`
- `LIVE_LLM_BASE_URL`, `LIVE_LLM_API_KEY`, `LIVE_LLM_MODEL`, `LIVE_LLM_FAST_MODEL`, `LIVE_LLM_EMBEDDING_MODEL`

## 9. Risks to watch while building

| Risk | Handling |
|---|---|
| Signals, notifications and thread subscriptions are `@experimental` | Only called inside `modules/dispatch`; covered by tests that catch upgrades |
| Pre-1.0 and beta packages (workers, DockerSandbox, agent-browser, MCP gateway) | Exact pins; upgrade one at a time with the test suite |
| `addAgent` silently ignores duplicates | The registry wrapper asserts the swap |
| Dynamic agent functions run on every call | Cache by definition version |
| Hidden default models (observational memory uses Google) | Model roles are required settings; the boot check fails if any is unset |
| Embedding changes invalidate vectors | Changing the embedding role is a restart plus a re-index, with a warning in the API |
| Your server's quirks (tool parser, strict JSON) | M1 test endpoint, plus a per-provider strict-JSON flag |
| Docker Desktop has no rootless mode | Accepted for dev. Rootless Docker on the server in M9 |
| Scheduler skips fires missed during downtime | Catch-up at boot (M5) |
