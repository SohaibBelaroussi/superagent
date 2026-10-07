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
| D15 | The chief reaches departments through task threads plus signals (our dispatch module). Leads reach their specialists through Mastra's built-in subagent delegation. | The chief never blocks, each task keeps its thread, and leads keep their own background budget. | built in M3 |
| D16 | The task ledger, phases, events and the decisions outbox are ours, modelled on Mastra Factory. | Mastra has no board or task entity. | built in M3 (decisions outbox in M5) |
| D24 | A lead's team is its department's active specialists, resolved per request. Specialists receive only the lead's delegation prompt, not the lead's system prompt or history. One active lead per department (enforced by a partial unique index). | No team lists to maintain: adding, editing or archiving a specialist changes the team on the next run. Specialists get a clean, self-contained task. | built in M2 |
| D25 | Tools are a code-defined catalog (`core`, `web` packs); definitions grant tools by key. The web pack uses the self-hosted SearXNG and Crawl4AI services, and refuses internal and private addresses. | New capabilities ship as code or, from M8, as plugins. Web content is untrusted, so a prompt-injected agent must not reach Postgres, the API, cloud metadata or the tailnet. | built in M2 |
| D26 | The ledger: tasks, an append-only event log (its sequence is the SSE event id) and artifacts. A phase machine says who may move a task where: the owner sends work, accepts, reopens and cancels; the lead reports progress and outcomes but never closes a task (done goes to review unless the department auto-closes); the server dispatches and flags stalled runs. | Every change is one locked read-modify-write plus its event, so the board, the history and the live stream always agree. Review keeps the owner in charge of what counts as done. | built in M3 |
| D27 | Each task has its own memory thread (`task:<id>`, resource `dept:<slug>`). New work starts a fresh lead run on that thread, or waits for the lead's current turn to end; a steered message joins the running turn, and one that Mastra strands is reclaimed and re-sent. The chief hears reports as notification signals on its own thread (`chief:main`). While the lead has a task, a supervisor watches the thread: once it goes idle with nothing left to send and no report, the task is flagged as waiting. So is every task interrupted by a restart. | Fresh runs avoid a 1.74 race where a wake sent just as a run ends is never processed. Deciding on the idle thread, not on one run's end, covers follow-up runs and late messages, so nothing sits "in progress" silently: every stop either reports or reaches the owner through the chief. | built in M3 |
| D28 | Live updates: `GET /v1/events` (SSE) with Last-Event-ID replay from the event log, fed by an in-process event bus (D23). A client that missed more than 5000 events gets a `reset` event and reloads the board. An advisory lock keeps event commit order equal to seq order. | One stream for every client. Reconnects catch up exactly, and nothing is skipped when two tasks change at the same moment. | built in M3 |
| D29 | Knowledge: uploaded files go to SeaweedFS (S3 API, on its own network with the API); their text is read in a worker thread (memory limit, timeout, page cap, text budget), split into overlapping passages and indexed with Postgres full-text search (`simple` configuration). Queries are tokenised by Postgres too, any word may match, common words dropped. Agents search their department's documents plus the shared ones with `knowledge_search`. Embedding-based search joins once an `embedding` model role exists. | Works today without an embedding model (the owner's provider has none yet) and keeps everything in Postgres. A hostile file can only exhaust the worker. Department scoping keeps results relevant. | built in M4 |
| D30 | Memory: the owner profile and department notes live in our tables, written only through `MemoryService` (validated, merged, serialized). The chief updates the profile with `update_owner_profile`, leads append to their department's notes with `save_department_note`, and the owner edits both over `/v1`. Input processors put the profile in every agent's context (read-only for departments) and the notes in the lead's. Each profile has its own Memory: observational memory compresses long threads with the `fast` model (the `default` one while the fast one can't be used) and lets calls without a thread through. | The owner tells the chief once and every department knows; a rule learned in one task applies to the next. One write path avoids Mastra working memory's unvalidated writes, unlocked merges and full replaces. Compression keeps long task threads within the model's window. | built in M4 |

## Server and code

| ID | Decision | Why | Origin |
|---|---|---|---|
| D17 | Our own Hono app, with Mastra mounted on `/api` through `@mastra/hono`. Our control-plane routes live on `/v1`, behind the same auth. We don't use `mastra build`. | We control boot order (migrations before listen) and shutdown (SSE drain), get native HTTP status codes, and can test in-process with `app.request()`. Mastra reserves `/api` for itself. | proposed, verified |
| D18 | TypeScript strict, ESM, zod 4, Node 24 LTS (22.22+ minimum). pnpm workspaces; tsdown for builds; `tsx watch` in dev; Biome for lint and format. | Matches Mastra's toolchain. zod 4 is what core uses. | proposed |
| D19 | Drizzle ORM 0.45 for the `app` schema, with migrations applied at boot. One `pg.Pool` shared with Mastra's `PostgresStore`. | Typed SQL, generated migrations, and `schemaFilter` keeps drizzle-kit away from Mastra's tables. Spike-verified. | proposed, verified |
| D20 | Auth: our `ApiTokenAuth`, a Mastra auth provider that checks hashed tokens in `app.api_tokens`. A bootstrap admin token comes from env. Only the admin token can create, list or revoke tokens; a device token can only revoke itself. Studio gets its own `SimpleAuth` token. We don't use `mapUserToResourceId`. | Revocable device tokens for future clients, without EE. A stolen device token can't mint replacements, so revoking it locks the thief out. Spike-verified. | proposed, verified |
| D21 | Tests: Vitest. Agent flows use scripted mock models (`MockLanguageModelV4` from `ai/test`) with in-memory LibSQL. Integration tests use Testcontainers Postgres. A live suite runs against your LLM server behind a flag. | Deterministic orchestration tests without paying for tokens. Spike-verified on this PC. | proposed, verified |
| D22 | Experimental Mastra APIs (signals, notifications, thread subscriptions) are called only through our own modules. | They're marked `@experimental` in 1.74, so a breaking change touches one file. | proposed |
| D23 | A single API process, with Mastra workers running in-process. Split workers and Valkey only if load ever needs it. | Simplest setup that is fully supported. | proposed |
