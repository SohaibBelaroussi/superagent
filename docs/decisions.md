# Decisions

The settled choices behind superagent. Each entry says what was decided, why, and where it came from.

- **you**: your answer in our discussion.
- **proposed**: my technical recommendation. Open to change until M0 starts. Most are backed by a spike (verified by running code).

Details and evidence: [api-plan.md](api-plan.md), [notes/mastra-1.74.md](notes/mastra-1.74.md), [vision/superagent-architecture.html](vision/superagent-architecture.html).

## Product and scope

| ID | Decision | Why | Origin |
|---|---|---|---|
| D01 | Build the API first. Clients come later: a simple web page, then the mobile app and the full web app. | Everything else depends on the API. | you, 2026-10-07 |
| D02 | Mastra's own harness only. No Claude Code, no ACP. | One runtime we control end to end. | you, 2026-10-06 |
| D03 | No paid third-party SaaS. No Mastra Enterprise code: no `*/ee` imports, no Agent Builder, RBAC, FGA or SSO. | No subscriptions. The EE license (v2.0) only allows dev and test use for free. | you + license check, 2026-10-06 |
| D04 | No chat channels (Telegram, WhatsApp, Slack) in v1. Keep the option open. | Scope. | you, 2026-10-06 |
| D05 | No use-case departments (LinkedIn, content studio) yet. Test with simple departments. | Prove the platform first. | you, 2026-10-07 |

## Infrastructure

| ID | Decision | Why | Origin |
|---|---|---|---|
| D06 | Everything ships as Docker images plus Compose. Develop and run on this Windows PC (Docker Desktop) at first, then move to your Linux server. | Package properly from day one, so the move is a redeploy. | you, 2026-10-07 |
| D07 | Remote access through Tailscale (`tailscale serve`). Maybe a Cloudflare tunnel later, not now. | Your devices are already on the tailnet. | you, 2026-10-07 |
| D08 | One Postgres 17 + pgvector database. Mastra's tables live in schema `mastra`, ours in `app`. | One store for memory, schedules, background tasks, vectors and our ledger. Spike: one shared pool, no conflicts. | proposed, verified |
| D09 | SeaweedFS for S3-compatible storage (artifacts, uploads, backups). | MinIO's community edition was archived in Feb 2026. SeaweedFS is Apache-2.0 and runs as one container. | proposed |
| D10 | Only our runner service talks to Docker. Rootless Docker on the server; Docker Desktop is accepted in dev. | Access to the Docker API is root-equivalent. | proposed |

## Models

| ID | Decision | Why | Origin |
|---|---|---|---|
| D11 | Models only through APIs: any OpenAI-compatible provider, added at runtime (base URL + key). No bundled local models. Your own LLM server is just another provider. | Your call. Mastra's model router covers this. | you, 2026-10-07 |
| D12 | One custom Mastra gateway, `sa`, resolves `sa/<provider>/<model>` from the providers table on every request. It builds models with `@ai-sdk/openai-compatible` 2.x and `includeUsage: true`. | Adding a provider, editing its URL or rotating its key takes effect with no restart. Streaming token usage works. Spike-verified. | proposed, verified |
| D13 | Model roles in settings: `default`, `fast` (titles, memory observer and reflector, judges) and `embedding`. Every internal use of a model is set explicitly. | Mastra silently defaults observational memory to a Google model. | proposed |

## Organization

| ID | Decision | Why | Origin |
|---|---|---|---|
| D14 | Agent and department definitions live in our own versioned tables. They compile into runtime Mastra `Agent`s, hot-swapped with `removeAgent` + `addAgent`. Mastra Editor isn't used. | Your call. Also hedges against features moving into EE. Spike-verified, including subagent edits reaching the lead without a rebuild. | you + spike |
| D15 | The chief reaches departments through task threads plus signals (our dispatch module). Leads reach their specialists through Mastra's built-in subagent delegation. | The chief never blocks, each task keeps its thread, and leads keep their own background budget. | vision |
| D16 | The task ledger, phases, events and the decisions outbox are ours, modelled on Mastra Factory. | Mastra has no board or task entity. | vision |

## Server and code

| ID | Decision | Why | Origin |
|---|---|---|---|
| D17 | Our own Hono app, with Mastra mounted on `/api` through `@mastra/hono`. Our control-plane routes live on `/v1`, behind the same auth. We don't use `mastra build`. | We control boot order (migrations before listen) and shutdown (SSE drain), get native HTTP status codes, and can test in-process with `app.request()`. Mastra reserves `/api` for itself. | proposed, verified |
| D18 | TypeScript strict, ESM, zod 4, Node 24 LTS (22.22+ minimum). pnpm workspaces; tsdown for builds; `tsx watch` in dev; Biome for lint and format. | Matches Mastra's toolchain. zod 4 is what core uses. | proposed |
| D19 | Drizzle ORM 0.45 for the `app` schema, with migrations applied at boot. One `pg.Pool` shared with Mastra's `PostgresStore`. | Typed SQL, generated migrations, and `schemaFilter` keeps drizzle-kit away from Mastra's tables. Spike-verified. | proposed, verified |
| D20 | Auth: our `ApiTokenAuth`, a Mastra auth provider that checks hashed tokens in `app.api_tokens`. A bootstrap admin token comes from env. Studio gets its own `SimpleAuth` token. We don't use `mapUserToResourceId`. | Revocable device tokens for future clients, without EE. Spike-verified. | proposed, verified |
| D21 | Tests: Vitest. Agent flows use scripted mock models (`MockLanguageModelV4` from `ai/test`) with in-memory LibSQL. Integration tests use Testcontainers Postgres. A live suite runs against your LLM server behind a flag. | Deterministic orchestration tests without paying for tokens. Spike-verified on this PC. | proposed, verified |
| D22 | Experimental Mastra APIs (signals, notifications, thread subscriptions) are called only through our own modules. | They're marked `@experimental` in 1.74, so a breaking change touches one file. | proposed |
| D23 | A single API process, with Mastra workers running in-process. Split workers and Valkey only if load ever needs it. | Simplest setup that is fully supported. | proposed |
