# Research spikes (reference only)

These are throwaway scripts from the 2026-10-07 research pass. They were run against `@mastra/core` 1.74.0, and the results are summarized in [../notes/mastra-1.74.md](../notes/mastra-1.74.md).

- They are **not part of the build**. M0 excludes `docs/spikes/` from lint, typecheck and tests.
- They use a local fake OpenAI-compatible server or scripted mock models. No real LLM calls, no real keys.
- Keep them as working examples of APIs whose docs are thin or wrong.

## runtime/ (plain Node ESM)

| File | Shows |
|---|---|
| `fake-openai.mjs` | A minimal OpenAI-compatible server for tests. Logs request bodies and auth headers |
| `s1-registry.mjs`, `s1b.mjs` | `addAgent` no-op on duplicate ids, the `removeAgent` + `addAgent` swap, dynamic `agents`, delegation context |
| `s2-gateway.mjs` | DB-backed custom gateway `sa`: runtime-added providers, URL and key edits, `includeUsage`, fallbacks |
| `s3-memory.mjs`, `s3b.mjs` | One shared Memory across agents, embeddings from an OpenAI-compatible endpoint, which embedder shapes work |
| `s4-tools.mjs` | `createTool` execute context, approval flow, tools records built at request time |
| `s5-compat.mjs` | Request bodies sent to OpenAI-compatible servers (strict JSON, providerOptions passthrough) |
| `s6-zod.mjs` | zod 4 → JSON Schema conversion for tools |
| `s7-pattern.mjs` | The full "definitions in DB → compiled agents → hot swap" pattern |

Run: `npm install` in `runtime/`, then `node s7-pattern.mjs`.

## server/ (TypeScript, run with tsx)

| File | Shows |
|---|---|
| `mock.ts` | Scripted `MockLanguageModelV4` covering both `doGenerate` and `doStream` |
| `server-spike.ts` | `@mastra/hono` mounting, custom auth provider, `/api` reservation, native routes being public, SSE, workers |
| `agent-spike.ts` | `sendMessage` (wake), `queueMessage`, notification signals, schedules, approvals, pub/sub, background tasks |
| `thread-spike.ts` | Auto-created threads vs. schedules failing on missing threads |
| `pg-spike.ts` | Drizzle and `PostgresStore` sharing one pool, schemas, and the pgvector extension placement |
| `studio-auth-spike.ts` | Studio authenticating with its own `SimpleAuth` token |
| `test/`, `itest/`, `vitest.config.ts` | Vitest with the mock model, and Testcontainers Postgres |

Run: `npm install` in `server/`, then `npx tsx agent-spike.ts`. `pg-spike.ts` needs Postgres; set `DATABASE_URL`.
