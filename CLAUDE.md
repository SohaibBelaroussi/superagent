# superagent

Self-hosted personal multi-agent system on Mastra: a chief of staff, departments (lead + specialists) and a task board, behind one HTTP API. One user, the "owner".

## Read first
- [docs/api-plan.md](docs/api-plan.md): milestones M0–M9 and what each must deliver.
- [docs/decisions.md](docs/decisions.md): settled decisions. Build within them; don't reopen them.
- [docs/notes/mastra-1.74.md](docs/notes/mastra-1.74.md): verified Mastra behaviour and gotchas. Check it before guessing at a Mastra API.
- [docs/spikes/](docs/spikes/): runnable reference code for Mastra APIs.

## Layout
- `apps/api`: the server. Hono app with Mastra mounted on `/api`, our control plane on `/v1`.
- `packages/shared`: zod schemas for `/v1` requests and responses (future clients reuse them).
- `compose.yaml`: Postgres (pgvector), SeaweedFS (S3 storage), SearXNG and Crawl4AI (web tools), and, under the `app` profile, the packaged API.

## Commands (from the repo root)
- `pnpm db:up`, then `pnpm dev`: the API on http://127.0.0.1:4111 with reload. Docs UI at `/v1/docs`.
- `pnpm check`: EE-import guard, lint, typecheck, unit and integration tests. Integration needs Docker running.
- `pnpm test` / `pnpm test:int` / `pnpm test:e2e`. e2e needs `pnpm stack:up` (packaged API on :4112).
- `pnpm test:live`: checks against the owner's real provider (`LIVE_LLM_*` in `.env`). Not part of CI.
- `pnpm db:generate`: new Drizzle migration after editing `apps/api/src/db/schema.ts`.
- `pnpm stack:up` / `pnpm stack:down`: packaged API plus Postgres in Docker.
- `pnpm studio`: Mastra Studio on :3000 against the dev server. Log in with `STUDIO_TOKEN`.

## Rules
- **Routes.** Mastra built-ins live under `/api`; our routes go under `/v1`, registered on the v1 router so `requireAuth` covers them. Native Hono routes are public otherwise. An integration test lists every `/v1` route and asserts 401 without a token.
- **No EE code.** Never import `@mastra/*/ee` (paid license). `pnpm check:ee` enforces this.
- **Experimental APIs.** Mastra's signals, notifications and `subscribeToThread` are called only from dedicated modules (`DispatchService` for signals and notifications).
- **Agent definitions are ours.** They live in our tables and compile into Mastra `Agent`s. Swap with `removeAgent` + `addAgent`; `addAgent` silently ignores duplicate ids.
- **Models.** Agents reference models as `sa/<provider-slug>/<model-id>`, resolved by our gateway from the providers table, or through a settings role (`settings.modelRouterId(role)`). Set every internal model explicitly; observational memory defaults to a Google model.
- **Secrets.** Provider keys and headers are sealed with `SecretBox` (AES-256-GCM, context-bound) using `SUPERAGENT_ENCRYPTION_KEY`. Never return or log them.
- **Organization.** Departments and versioned agent definitions live in our tables (`OrgDirectory` keeps an in-memory view, `AgentRuntime` compiles them into Mastra agents). A lead's team is its department's specialists; specialists see only the delegation prompt.
- **Tools.** Agents get tools from the code-defined `ToolCatalog`. Anything that fetches a URL for an agent must go through `await assertPublicUrl(url)` (no internal or private addresses; names are resolved and every address checked). A tool that fetches directly must also follow redirects manually and check each hop.
- **Tasks.** Every task change goes through `TaskService`: one locked read-modify-write that appends its event, published after commit. Only `DispatchService` sends work to agents: new work starts a fresh run on the task's thread (`agent.stream`) or waits for the lead's turn to end, and only steered messages go into a running turn as signals. Its per-task supervisor flags a task once the lead's thread is idle without a report.
- **Memory.** The owner profile and department notes are our tables, written only through `MemoryService` (the chief's `update_owner_profile`, the leads' `save_department_note`, the `/v1` routes). Input processors add them to agents' context. Each profile (chief, lead, specialist) has its own Mastra Memory for history; observational memory compresses long threads and passes thread-less calls through.
- **Knowledge.** Uploads go through `KnowledgeService`: the file to object storage (`BlobStore`), its text read in the `extract.worker` thread (never on the main thread), its passages to Postgres full-text search. Only a multipart `POST /v1/knowledge` with a declared length gets the 20 MiB body limit.
- **Schedules.** Our `schedules` table and `ScheduleService` ticker, never `mastra.schedules` (it drops fires due at boot and deletes rows). A fire creates a task and dispatches it.
- **Approvals.** Resolve a gated tool call only through `DecisionService` (which calls `DispatchService.resolveApproval`), so the task, the chief and the decisions log stay in step. Attention items are computed, not stored.
- **Config writes.** Settings updates, provider deletion and every organization write (departments and agents) run under `settings.lock`.
- **Errors.** `/v1` errors are problem+json: throw `ApiError`, or return `problem()`.
- **Schemas.** zod 4 everywhere. Request and response schemas go in `packages/shared`.
- **Tests.** Single-agent checks use the scripted mock model (`apps/api/test/support/mock-model.ts`). Multi-agent flows run against the fake OpenAI server (`apps/api/test/support/fake-openai.ts`), steered by directives in the user message (`[assign]`, `[artifact]`, `[no-report]`, `[slow]`, `[linger]`). Database tests use `startTestSystem()` from `apps/api/test/int/helpers.ts` (Testcontainers, one database per file).

## Public repository
- Never commit `.env`, keys, or the owner's provider endpoints. `.env.example` keeps placeholders.
- **Commits use the owner's git identity.** Add no `Co-Authored-By` trailers to commits and no "Generated with" footers to PRs or merge commits.
- **Workflow:**
  1. Work on one branch per milestone (`m0-foundation`, `m1-providers`, ...) and commit as you go.
  2. Scan the diff for secrets before pushing.
  3. When the milestone is done, open a PR into `main`, review it, and merge with a merge commit once CI is green.
- **CI** (`.github/workflows/ci.yml`) runs on every PR and every push to `main`: `pnpm check`, then it builds the image, starts the stack, and runs the e2e suite against it.

## Windows notes
- A dev server started in the background can outlive its shell. If port 4111 stays busy, stop the leftover `node` process.
- Node 24.21 comes from nvm-windows (`.nvmrc`). nvm keeps global tools per Node version, so pnpm comes from `corepack enable`. The Docker image and CI use the same Node version.
