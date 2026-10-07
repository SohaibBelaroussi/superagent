# Mastra 1.74: verified facts for superagent

A condensed reference from the research passes on 2026-10-06/07, so implementation doesn't have to re-read package source.

**Labels:**
- **[spike]**: verified by running code (scripts in [../spikes/](../spikes/)).
- **[src]**: read in package source.
- **[doc]**: documentation only.
- **[unverified]**: not yet checked.

Recheck anything here when upgrading past the versions below.

## Versions this applies to

| Package | Version | Note |
|---|---|---|
| `@mastra/core` | 1.74.0 | `engines: node >=22.13`. Its dependency `posthog-node` wants ≥22.22 (EBADENGINE warning on 22.20). |
| `@mastra/server`, `@mastra/deployer` | 1.74.0 | |
| `@mastra/hono` | 1.7.16 | |
| `@mastra/memory` | 1.35.0 | Depends on zod ^4.6. |
| `@mastra/pg` | 1.29.0 | |
| `@mastra/libsql` | 1.25.0 | Tests only. |
| `@mastra/auth` | 1.1.3 | |
| `@ai-sdk/openai-compatible` | **2.x** (AI SDK 6, spec v3) | 3.x chat works, but 3.x embeddings break `Memory.saveMessages` ("Unsupported model version"). |
| `ai` | 7.0.x | For `ai/test` mocks (`MockLanguageModelV3/V4`). |
| `hono` | 4.13 | |
| `@hono/node-server` | 2.1 | |
| `drizzle-orm` | 0.45.3 | 1.0 is still an RC. |
| `drizzle-kit` | 0.31 | |
| `vitest` | 5.0 | |
| `@testcontainers/postgresql` | 12.2 | |
| `zod` | 4.6 | |

Later milestones: `@mastra/docker` 0.9.2, `@mastra/agent-browser` 0.5.3, `@mastra/mcp` 2.1.2, `@mastra/s3` 0.6.3, `@mastra/observability` 1.18.3, `@mastra/client-js` 1.51.2.

## 1. Server: own Hono app with `@mastra/hono`

```ts
const app = new Hono<{ Bindings: HonoBindings; Variables: HonoVariables }>();
app.get('/health', c => c.json({ ok: true }));                       // native route = public
await new MastraServer({ app, mastra, openapiPath: '/openapi.json',
  bodyLimitOptions: { maxSize: 4_718_592, onError: () => ({ error: 'too large' }) } }).init();
app.use('/v1/*', createAuthMiddleware({ mastra }));                  // REQUIRED for our routes
app.route('/v1', v1Router);
const http = serve({ fetch: app.fetch, port, hostname });
await mastra.startWorkers(); await mastra.restartAllActiveWorkflowRuns();
```

**Routes and auth:**
- Mastra's built-in routes keep the `/api` prefix and check auth per route. [src]
- **Native Hono routes are public unless `createAuthMiddleware` is applied**, even when they sit under `/api/*`. [spike]
- A pattern like `/v1/*` also matches `/v1`. [spike]
- Custom `registerApiRoute`/`createRoute` paths **may not start with `/api`**. Startup throws `Custom API route "/api/board" must not start with "/api"`. [spike]
- Changing Mastra's prefix (e.g. `/mastra`) leaves the built-in routes **unauthenticated** unless `protected: ['/mastra/*']` is set on the auth provider. Keep `/api`. [spike]

**OpenAPI:**
- Mastra's spec at `/api/openapi.json` requires auth unless whitelisted.
- It lists `createRoute` routes, and `registerApiRoute` routes that set `openapi`. Native routes never appear, so our `/v1` needs its own generator. [spike]

**What the adapter leaves to us:**
- It doesn't read `server.port/host/cors/timeout/bodySizeLimit`. Pass those ourselves. [src]
- `mastra.startWorkers()` is required; the scheduler and background workers don't start otherwise. [spike]

**Shutdown sequence:**
1. `http.close()`
2. `closeAllConnections()` after a timeout (SSE holds connections open)
3. `mastra.shutdown({ drainTimeout })`
4. `pool.end()` [src DEP:4770-4808]

**Studio isn't served by the adapter.** Run `mastra studio --server-port 4111 --server-api-prefix /api` (a static server on port 3000) and allow CORS. [doc]

**SSE through `createRoute`:**
- `createRoute({ responseType: 'stream', streamFormat: 'sse', sseFlushOnConnect: true, handler: () => ReadableStream })` emits `: connected`, then `data:` frames. Strings starting with `:` pass through raw, so they work as heartbeats. [spike]
- JSON `createRoute` responses are always 200. Use native Hono routes when we need other status codes. [src]
- Recommended: native Hono routes with `streamSSE` and our own heartbeat about every 25 s. [doc]

## 2. Auth

**Provider contract** (`@mastra/core/server`):
- `abstract authenticateToken(token, request): Promise<User|null>`
- `abstract authorizeUser(user, request): boolean|Promise<boolean>`
- optional `mapUserToResourceId`, `protected`, `public` [src]

**Token sources:**
- `Authorization: Bearer <t>`. The `Bearer ` prefix is matched case-sensitively.
- Fallback `?apiKey=<t>`, useful for EventSource. [spike]

**Request flow:**
1. Skip if the path isn't protected or is public (defaults: protected `/api/*`, public `/api`, `/api/auth/*`).
2. `authenticateToken`; `null` returns 401.
3. Set requestContext keys `mastra__user`, `user`, `mastra__authToken` and `mastra__resourceId`.
4. `authorizeUser` returning `false` gives 403. [src]

**Reading the user:**
- `c.get('requestContext').get('mastra__user')`. The key is reserved, so clients can't inject it. [spike]

**Don't set `mapUserToResourceId`.** It forces every memory call onto one resource; anything else gets a 403. We use several resourceIds. [doc]

**Studio:**
- Studio sends `x-mastra-client-type: studio`.
- With `studio: { auth: new SimpleAuth({ tokens: { [STUDIO_TOKEN]: owner } }) }`, Studio uses only that provider and shows a token login. It's license-free in production. [spike]
- `SimpleAuth` takes a `tokens:` map; the docs' `users:` example is wrong. [src]

**No EE imports:**
- None of the above imports anything from EE.
- The EE license check fires only when `rbac`, `fga` or Agent Builder is configured. [src]
- EE features count as "dev" when `MASTRA_DEV` is set or `NODE_ENV≠production`, so **images must set `NODE_ENV=production`**. [src]

## 3. Storage

**`PostgresStore`:**
- Constructor: `new PostgresStore({ id, pool, schemaName: 'mastra' })`.
- With a shared `pg.Pool`, `store.pool === pool`, and `store.close()` does not end a pool you passed in. [spike]
- `init()` creates about 43 `mastra_*` tables in `mastra` (schedules, notifications, background_tasks, threads...) in about 320 ms. Call it explicitly at boot; otherwise it runs lazily on first use. [spike]

**`PgVector`:**
- Constructor: `new PgVector({ id, connectionString, schemaName?, pgPoolOptions?: { max } })`.
- It always opens **its own pool**, so budget connections for it. [src]
- Index types: `ivfflat`, `hnsw`, `flat`. [src]

**pgvector extension:**
- If the `vector` extension is missing, a non-public `schemaName` makes PgVector install it into that schema and `SET search_path`.
- Avoid that: our first migration runs `CREATE EXTENSION IF NOT EXISTS vector` (in `public`). [spike]

**Drizzle:**
- Use `pgSchema('app')` and drizzle-kit `schemaFilter: ['app']`.
- `migrationsSchema: 'app'` fails on the first run (`CREATE SCHEMA "app"` already exists), so keep the migration journal in the default `drizzle` schema. [spike]

## 4. Runtime agent registry: definitions in our DB, live agents

**Registry methods:**
- `mastra.addAgent(agent, key?, { source? })`. **If the key already exists it silently does nothing** (the JSDoc says it throws). [spike]
- `removeAgent(keyOrId)` only deletes the registry entry. [src]
- There is no replace method.

**Agents added after boot are fully bound:** logger, storage, workspace, background executors, schedule sync. Server routes and the Studio list find them on the next request. [src]

**Only exception:** channel webhook routes mount at server init. Not relevant in v1. [src]

**Hot-swap pattern:**
1. Build the new `Agent` completely, awaiting anything you need first.
2. Run `mastra.removeAgent(id); mastra.addAgent(next, id);` back to back with no `await` between, so the id is never missing.
3. Keep the id, tool keys and subagent keys stable across versions.
4. Dispose old workspaces and signal providers yourself. [spike]

What survives a swap: [spike]
- Existing threads, because they belong to a resource, not an agent.
- Active runs, which finish on the old instance.
- Pending approvals. They are stored per run; after the swap the new instance listed and approved them, using its own tools.
- Schedules, which resolve the agent by id on every fire.

**Dynamic fields** take `T | ({ requestContext, mastra? }) => T | Promise<T>`.

Can be dynamic:
- instructions, model (including fallback arrays), tools, **agents**, workflows, memory, workspace, skills, defaultOptions, processors, `goal.judge`

Cannot be dynamic:
- id, name, **description** (a function breaks the delegation tool description), **browser** (throws), channels, signals, backgroundTasks, durable [spike]

**How dynamic functions behave:**
- **The `agents` function gets only `{ requestContext }`, no `mastra`.** Close over our instance and return `{}`, never `undefined`. [spike]
- **Nothing is cached.** Dynamic functions run on every call. They also run at `addAgent` and on every Studio listing, with an empty RequestContext. So we cache by definition version and tolerate an empty context. [spike]

**Subagents:**
- **Lazy lookup** inside the lead's `agents` function means boot order doesn't matter. Specialists created or edited later show up on the lead's next run without rebuilding the lead. [spike]
- The LLM sees each subagent as a tool named `agent-<key>`, so keys must match `[A-Za-z0-9_-]` and be at most 58 characters. [src]
- By default a delegation passes the lead's system prompt and conversation. Restrict that with `defaultOptions.delegation.messageFilter`. [spike]
- Each delegation runs in a fresh sub-thread with resourceId `{parent}-{key}`. [src]

## 5. Models

**`MastraModelConfig`** accepts: [src]
- an AI SDK `LanguageModelV1` to `V4` instance
- a router string `provider/model` or `gateway/provider/model`
- an `OpenAICompatibleConfig`: `{ id, url?, apiKey?, headers?, api?: 'chat'|'responses' }` or `{ providerId, modelId, ... }`
- a function returning any of these
- a fallback array `[{ model, maxRetries?, enabled?, modelSettings?, providerOptions?, headers? }]`

**Custom gateway:**
- `class X extends MastraModelGateway` from `@mastra/core/llm`.
- Required members: `id`, `name`, `fetchProviders()`, `buildUrl()`, `getApiKey()`, `resolveLanguageModel({ modelId, providerId, apiKey, headers })`.
- Optional members: `handlesModel(id)` (synchronous), `resolveAuth(req)`, `shouldEnable()`.
- Register it with `new Mastra({ gateways: { sa } })`. First registration wins and there's no remove. [src]

What the spike confirmed about the gateway: [spike]
- It can do an async DB lookup on every request.
- Providers added at runtime work, and URL edits and key rotations apply on the next request.
- `sa/<provider>/<model…>`: the model id may contain slashes.
- Return `{ apiKey, source: 'gateway' }` from `resolveAuth`.
- Prefer prefixed ids. `handlesModel` can hijack ids such as `openai/...`.

**Stream usage:**
- The plain `{ url }` config never sends `stream_options.include_usage`, so `stream()` reports 0 tokens.
- Our gateway builds `createOpenAICompatible({ includeUsage: true })` instead. [spike]

**Strict structured output:**
- The `{ url }` form sends `response_format: json_schema, strict: true`.
- To disable it: `providerOptions[<providerId>].strictJsonSchema=false`, `structuredOutput.jsonPromptInjection`, or `supportsStructuredOutputs: false` in the gateway. Expose this as a per-provider "strict JSON" flag. [spike]

**Request body passthrough:**
- Keys under `providerOptions[<providerId>]` are copied into the request body (e.g. `chat_template_kwargs`, `parallel_tool_calls`).
- `modelSettings.topK` is dropped. [spike]

**Tool calling:**
- `tool_choice: auto`; no `parallel_tool_calls` is sent.
- Mastra runs tool calls concurrently up to `toolCallConcurrency` (default 10), and forces 1 when an approval or suspend tool is present. [src]

**Reasoning:**
- `reasoning_content` and `reasoning` are parsed.
- `<think>` tags inside the content are not split out. [src]

**OpenAI schema layer:**
- A provider slug or model id containing "openai" (e.g. `openai/gpt-oss-20b`) switches on the OpenAI schema layer. Optional fields become nullable and required. [spike]
- `strict: false` on a tool skips that rewriting. [src]

**Model listing:**
- Mastra has no API for it. We call `GET {baseURL}/models` ourselves, cache the result, and return it from `fetchProviders()`. Studio's provider picker calls `fetchProviders()` on every request. [src]

**Embeddings:**

Works: [spike]
- `new ModelRouterEmbeddingModel({ providerId, modelId, url, apiKey })` from `@mastra/core/llm`
- or `@ai-sdk/openai-compatible` 2.x `.embeddingModel(id)`

Fails:
- `'local/x'` strings (no gateway lookup for embeddings)
- `{ id: 'p/a/b', url }` when the model id has a slash
- openai-compatible 3.x embeddings

Behaviour to plan around:
- **The embedding dimension is probed once per Memory**; the index is named `memory_messages_<dim>`.
- A semantic-recall cache is keyed by `${indexName}:${content}`.
- So changing the embedding model means a new Memory, a restart, and a re-index.
- pgvector indexes cap at 2000 dimensions.

**Other places a model is needed** (set each one explicitly):
- `observationalMemory.model`. **The default is `google/gemini-2.5-flash`.**
- `generateTitle.model`
- `goal.judge`
- `structuredOutput.model`
- model-based processors

These all accept gateway strings. Stagehand does not. [src]

## 6. Tools

**`createTool` fields:**
- `id`, `description`, input/output/suspend/resume schemas
- `requireApproval: boolean | (input, ctx) => boolean`
- `strict`, `providerOptions`, `toModelOutput`
- `background: { enabled, defaultDisposition, timeoutMs, maxRetries, ... }` [src]

**`execute(input, ctx)`** receives:
- `requestContext`, `mastra`, `abortSignal`, `runId`, `memory`, `workspace`, `browser`, `tracing`
- `writer` (`writer.custom({ type: 'data-…', data })` for progress)
- `agent: { agentId, toolCallId, threadId, resourceId, messages, suspend, resumeData, ... }` [spike]

**Approval flow:**
1. `generate` returns `finishReason: 'suspended'` with `suspendPayload: { toolCallId, toolName, args }`.
2. Approve with `approveToolCall` / `approveToolCallGenerate({ runId, toolCallId })`. [spike]

**Registry:**
- `mastra.addTool(tool, key?)` is first-wins and silent; `removeTool(key)`; `getToolById(id)`.
- Agents have no string references to tools. Build `tools: () => ({ key: mastra.getToolById('…') })`.
- **The record key is the tool name the LLM sees, not `tool.id`.** [spike]

**zod 4** (core imports `zod/v4`):
- Schemas convert to JSON Schema draft-07 with `additionalProperties: false`.
- Optional and defaulted fields are not required.
- Nullable becomes `[T, null]`. [spike]

## 7. Memory

**Registry:**
- `new Mastra({ memory: { lead: memLead } })` or `addMemory(m, key)` (first-wins, no remove), then `getMemory(key)`.
- Agents reference it with `memory: ({ mastra }) => mastra!.getMemory('lead')`. [spike]

**One Memory, many agents:**
- One Memory instance can serve many agents with different resourceIds. [spike]
- Resource-scoped working memory, recall and observational memory are shared by everyone using the same resourceId.

**Shape for Postgres:**

```ts
new Memory({ id: 'lead', storage, vector: new PgVector({ id: 'pgvector', connectionString }), embedder,
  options: {
    lastMessages: 20,                         // deprecated alias of messageHistory
    semanticRecall: { topK: 4, messageRange: 2, scope: 'resource', indexConfig: { type: 'hnsw', metric: 'cosine' } },
    workingMemory: { enabled: true, scope: 'resource', schema /* or template */ },
    observationalMemory: { model: 'sa/<provider>/<fast-model>' },
    generateTitle: { model: 'sa/<provider>/<fast-model>' },
  } });
```

Turning `semanticRecall` on without a vector store and an embedder throws in the constructor. [src]

**Threads:**
- Create a thread ahead of time with `(await agent.getMemory()).createThread({ resourceId, threadId, title, metadata })`. [spike]
- `sendMessage` to a missing thread auto-creates it, with `metadata: null`. [spike]
- **A schedule firing into a missing thread fails** with `thread "x" not found`. Pre-create department inbox threads. [spike]

## 8. Signals, schedules, background tasks, approvals

All of these are verified in [../spikes/server/agent-spike.ts](../spikes/server/agent-spike.ts) unless noted.

**Signals. Marked `@experimental`:** `sendMessage`, `queueMessage`, `sendSignal`, `sendNotificationSignal`, `subscribeToThread`. [src]

`agent.sendMessage(msg, target)`:
- Synchronous. `.accepted` resolves to `wake{runId, output}`, `deliver`, `persist`, `discard` or `blocked`.
- Message: `string | { contents, attributes?, metadata? }`.
- Target: `{ resourceId, threadId, ifActive?: { behavior: 'deliver'|'persist'|'discard' }, ifIdle?: { behavior: 'wake'|'persist'|'discard', streamOptions?, attributes? } }`.

`agent.queueMessage(msg, target)`:
- Runs on the next turn.

`agent.sendNotificationSignal(n, target)`:
- Returns `Promise<{ record, decision, accepted? }>`.
- Input: `{ source, kind, summary, priority?: 'low'|'medium'|'high'|'urgent', payload?, dedupeKey?, coalesceKey? }`.
- Urgent notifications wake the thread. Dispatch is on by default.

`agent.sendSignal({ type: 'user'|'state'|'reactive'|'notification', contents, ... }, target)`.

`agent.subscribeToThread({ resourceId?, threadId, withInitialHistory? })`:
- Returns `{ stream, activeRunId, abort, unsubscribe }`.

**Schedules: `mastra.schedules`**
- Methods: `create`, `get`, `list`, `update`, `delete`, `pause`, `resume`, `run`.
- `create` takes `{ id?, agentId, cron, prompt, name?, timezone?, threadId?, resourceId?, signalType?, ifActive?, ifIdle?, metadata?, status? }`.
- Hooks: `new Mastra({ schedules: { prepare, onFinish, onError, onAbort } })`.
- Ids are normalized (e.g. `agent_standup`).
- Fires missed during downtime are not replayed. The scheduler is single-instance.

**Background tasks:**
- Config: `new Mastra({ backgroundTasks: { enabled: true, globalConcurrency: 10, perAgentConcurrency: 5, defaultTimeoutMs: 300000 } })`.
- `mastra.backgroundTaskManager`: `listTasks(filter)`, `stream({ includeExisting, abortSignal })` returning a ReadableStream, and `cancel(id)`.
- HTTP routes are read-only: `GET /api/background-tasks`, `/:id`, `/stream`.

**Approvals:**
- `agent.listSuspendedRuns({ resourceId?, threadId? })` returns `{ runs: [{ runId, threadId, toolCalls: [{ toolName, requiresApproval }] }], total }`.
- Then `approveToolCall({ runId, toolCallId?, memory })` or `declineToolCall({ ..., reason? })`.
- This survives agent swaps.

**Pub/sub:**
- `mastra.pubsub.publish(topic, { type, data, runId }, { localOnly? })`. **`runId` is required.**
- `subscribe(topic, cb)`, `unsubscribe(topic, cb)`.
- Default is an in-process EventEmitter.

## 9. Testing

- **Spec versions:** core routes by spec version — v2 (AI SDK 5), v3 (AI SDK 6), v4 (AI SDK 7). `ai@7` `ai/test` exports `MockLanguageModelV3/V4`, not V2. [spike]
- **Script both methods:** `Agent.generate()` calls `doGenerate`, while `stream()`, signals and schedules call `doStream`. Use one shared step counter. See [../spikes/server/mock.ts](../spikes/server/mock.ts). [spike]
- **No Docker needed** for memory, signals, notifications, schedules, background tasks and approvals: `LibSQLStore({ id, url: ':memory:' })` covered all of them. [spike]
- **Testcontainers** `pgvector/pgvector:pg17` works on Docker Desktop for Windows: 14 s on the first run, 3.6 s warm. [spike]
- **Vitest config:** `environment: 'node'`, `pool: 'forks'`, `testTimeout: 20s`, `hookTimeout: 60–120s`, `env: { MASTRA_TELEMETRY_DISABLED: 'true' }`, and `logger: false` on Mastra. [spike]

## 10. Packaging

- **Image:** multi-stage, `node:24-bookworm-slim`. Build inside Linux; never copy Windows `node_modules` into an image.
- **pnpm:** `pnpm deploy --prod` needs `injectWorkspacePackages: true` in `pnpm-workspace.yaml`. Deploy copies workspace packages verbatim, so bundle `.ts`-exporting packages into the API with tsdown (`noExternal`). [spike]
- **Environment:** `NODE_ENV=production` (EE gating) and `MASTRA_TELEMETRY_DISABLED=true`. Use exec-form `CMD ["node","dist/main.js"]` so node is PID 1 and receives SIGTERM.
- **Compose:** `init: true`, and `stop_grace_period` longer than the drain timeout.
- **tsconfig:** ES2022, `moduleResolution: bundler`, `noEmit`, used for typechecking only. tsdown bundles.

## 11. Learned while building M0 (2026-10-07)

**Dependencies:**
- `@mastra/hono` 1.7.16 depends on `@hono/node-ws`, whose peer is `@hono/node-server ^1.19`. Pin `@hono/node-server` 1.19.x, not 2.x.
- pnpm 10 blocks dependency build scripts. Only `esbuild` needs approval (`onlyBuiltDependencies`). `ssh2`, `cpu-features` and `protobufjs` are ignored safely.

**`createAuthMiddleware`** (`@mastra/hono`):
- It marks the wrapped path as an auth-required custom route, so it enforces auth even outside the provider's `protected` patterns.
- Token comes from `Authorization` (with `"Bearer "` stripped) or `?apiKey=`.
- **With no `server.auth` configured it lets everything through.** `createMastra()` refuses to boot without a provider.

**Startup warning** `[mastra/auth] server.auth is configured without mapUserToResourceId`: expected and harmless with a single owner (decision D20).

**From the M0 review:**
- **`MastraServer.init()` registers a global context middleware that parses every JSON request body before auth** (`c.req.raw.clone().json()`). Without a global limit, an unauthenticated client can make the server buffer huge bodies. `app.ts` mounts Hono's `bodyLimit` (4 MiB) before `init()`.
- **A `pg.Pool` passed to `PostgresStore({ pool })` gets no `'error'` listener** (Mastra only adds one to pools it creates). An idle client dying (e.g. Postgres restart) then crashes the process. `bootstrap()` attaches the listener.
- **Mastra's `coreAuthMiddleware` turns exceptions from `authenticateToken` into 401.** `TokenService` therefore keeps recently verified tokens working through short database outages instead of returning 401 for every request.

**Mastra's generate route:**
- `POST /api/agents/:id/generate` accepts `{ messages: [{ role: 'user', content }] }` and returns JSON with `text`.
- Thread ids containing colons (`task:<id>`, `dept:<slug>`) work.

**Toolchain:**
- TypeScript 7.0 (native) typechecks Mastra 1.74 types with no issues.
- tsdown 0.23 emits `dist/main.mjs` for ESM node builds.
- **Biome 2.5 `biome migrate` rewrites `"recommended": true` to `"preset": "none"`, which turns the rules off.** Use `"preset": "recommended"`.

**Packaging:**
- `pnpm deploy --prod --legacy` assembles the runtime folder without `injectWorkspacePackages`.
- Image is about 650 MB: node:24 slim plus about 260 MB of production `node_modules`.
- SIGTERM stop takes about 0.8 s, exit code 0.

**Tests:** the integration suite (Testcontainers pgvector, 16 tests) takes about 11 s on Docker Desktop.

## 12. Learned while building M1 (2026-10-07)

**Throwaway agents for checks:**
- `new Agent({ ..., model: 'sa/<slug>/<model>', mastra })` resolves our gateway without being registered, so it never shows up in `/api/agents`. The provider test runner uses this.
- Set `maxRetries: 0` on such agents so failures come back in seconds instead of after retries with backoff.

**Unset model roles:**
- Dynamic `model` functions also run when Studio lists agents, so they must not throw.
- Unset roles therefore resolve to `sa/unconfigured/<role>`, and the gateway rejects that id at call time with instructions.
- Mastra's generate route surfaces that error message to the client.
- The slug `unconfigured` is reserved.

**Gateway:**
- `ProviderGateway` reads an in-memory registry rebuilt after every provider write.
- It builds `createOpenAICompatible({ includeUsage: true, supportsStructuredOutputs: strictJson })` from `@ai-sdk/openai-compatible` 2.x.
- `resolveAuth` returns `{ apiKey, source: 'gateway' }`.

**Embeddings:** `ModelRouterEmbeddingModel({ providerId, modelId, url, apiKey, headers })` works for the connectivity check against an OpenAI-compatible `/embeddings` endpoint.

**Live results with the owner's provider:**
- Model discovery, chat, streaming with token usage, and tool calling all pass.
- It lists no embedding model. M4 needs one: from that provider or another.

## 13. From the M1 review (2026-10-07)

**Gateway auth and Mastra's model cache:**
- Return a non-empty `apiKey` with `source: 'gateway'` from `resolveAuth`.
- If it returns an empty string, Mastra treats that as no credentials and falls back to `getApiKey()` with source `legacy`. On that path `ModelRouterLanguageModel` caches the model in a static WeakMap per gateway, with a key that ignores base URL and headers. Keyless providers then never pick up URL or header edits, and a disabled or deleted provider keeps working.
- Our gateway returns a revision-scoped placeholder (`sa-gateway:<id>:<updatedAt>`) and never the real key. `buildChatModel` reads the real key from the registry.

**Generate and stream don't throw on retryable failures:**
- Mastra's `generate` and `stream` resolve with empty text and `finishReason` `retry` or `aborted` on connection refused, HTTP 5xx or abort. Only 4xx errors throw.
- So check `finishReason`, not just text.

**Global tool registration:**
- An agent bound to Mastra (`mastra` option or `addAgent`) registers its tools globally (`mastra.addTool`, first wins). They show up in `/api/tools`.
- Remove throwaway tools with `mastra.removeTool(id)`.

**AES-GCM in Node:**
- `createDecipheriv` without `{ authTagLength: 16 }` accepts truncated tags.
- Pass `authTagLength` and check the tag length.

## 14. Learned while building M2 (2026-10-07)

**Delegation:**
- `defaultOptions.delegation.messageFilter: () => []` gives a specialist only the lead's delegation prompt.
- Subagent tools take `{ prompt }`.
- The lead's `agents` function closes over Mastra and looks specialists up per request.

**Crawl4AI 0.9.4** binds to its own loopback, refusing outside connections, unless `CRAWL4AI_API_TOKEN` is set. Requests then need `Authorization: Bearer <token>`. `POST /md { url, f: 'fit' }` returns `{ markdown, success }`.

**SearXNG** needs `search.formats: [html, json]` and `server.limiter: false` for API use (`infra/searxng/settings.yml`).

**URL normalization:** `new URL()` normalizes IPv4-mapped IPv6 to hex (`[::ffff:a00:1]`), so private-address checks must decode that form.

**Live result:** the owner's model led a research department, delegated to the web researcher, and produced a sourced answer via the real SearXNG.

**From the M2 review:**
- **A thrown tool error doesn't end the run.** Mastra returns the error message to the model as the tool result and the run goes on. [spike]
- **`requireApproval` is enforced as soon as it's set.** The run ends with `finishReason: 'suspended'` and empty text. Without an approval route the agent just stops answering, so `true` is rejected until M5. [spike]
- **Tools always get an abort signal on HTTP-driven runs.** The hono adapter passes the request's signal and delegation forwards it, so `signal ?? AbortSignal.timeout(ms)` never times out. Combine them with `AbortSignal.any`. [spike]
- **Crawl4AI 0.9.4 guards its own fetches.** It resolves each host once, pins the IP and refuses non-global addresses, for the first URL and every redirect. `assertPublicUrl` is our own first line: it resolves names too, and strips trailing dots (`postgres.` is `postgres`). [spike]
- **Directory reloads must not skip.** Returning early from a superseded reload let a caller miss its own write. Reloads now run one after another.

## 15. From earlier research, needed in later milestones

- **DockerSandbox 0.9.2:**
  - One long-lived container per sandbox, reused by label.
  - `stop()` doesn't delete it, so we need a reaper.
  - No `user`, `runtime` or `shmSize` options.
  - Volume `subpath` mounts need Engine 26+; this PC has 28.5.
- **Browser:**
  - `cdpUrl` forces shared scope. A per-task browser needs a custom thread manager; FirecrawlBrowser's source is the template.
  - **The screencast WebSocket `/browser/:agentId/stream` appears to be registered before auth** in deployer 1.74. Check this under our adapter in M7 and gate it ourselves.
- **Stored MCP config** has no headers, cwd or OAuth.
- **Plugins:** Agent Plugins 1.0 = `plugin.json` + `skills/` + `mcp.json`.
- **Factory patterns to reuse:** phase kinds (resting, working, terminal), seats, decisions outbox with idempotency keys, change-hint SSE.
