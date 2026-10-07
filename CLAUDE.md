# superagent

Self-hosted personal multi-agent system on Mastra: a chief of staff, departments (lead + specialists) and a task board, behind one HTTP API. One user, the "owner".

## Read first
- [docs/api-plan.md](docs/api-plan.md): milestones M0–M9 and what each must deliver.
- [docs/decisions.md](docs/decisions.md): settled decisions D01–D23. Build within them; don't reopen them.
- [docs/notes/mastra-1.74.md](docs/notes/mastra-1.74.md): verified Mastra behaviour and gotchas. Check it before guessing at a Mastra API.
- [docs/spikes/](docs/spikes/): runnable reference code for Mastra APIs.

## Layout
- `apps/api`: the server. Hono app with Mastra mounted on `/api`, our control plane on `/v1`.
- `packages/shared`: zod schemas for `/v1` requests and responses (future clients reuse them).
- `compose.yaml`: Postgres (pgvector) and, under the `app` profile, the packaged API.

## Commands (from the repo root)
- `pnpm db:up`, then `pnpm dev`: the API on http://127.0.0.1:4111 with reload. Docs UI at `/v1/docs`.
- `pnpm check`: EE-import guard, lint, typecheck, unit and integration tests. Integration needs Docker running.
- `pnpm test` / `pnpm test:int` / `pnpm test:e2e`. e2e needs `pnpm stack:up` (packaged API on :4112).
- `pnpm db:generate`: new Drizzle migration after editing `apps/api/src/db/schema.ts`.
- `pnpm stack:up` / `pnpm stack:down`: packaged API plus Postgres in Docker.
- `pnpm studio`: Mastra Studio on :3000 against the dev server. Log in with `STUDIO_TOKEN`.

## Rules
- **Routes.** Mastra built-ins live under `/api`; our routes go under `/v1`, registered on the v1 router so `requireAuth` covers them. Native Hono routes are public otherwise. An integration test lists every `/v1` route and asserts 401 without a token.
- **No EE code.** Never import `@mastra/*/ee` (paid license). `pnpm check:ee` enforces this.
- **Experimental APIs.** Mastra's signals, notifications and `subscribeToThread` are called only from dedicated modules (the dispatch module from M3 on).
- **Agent definitions are ours.** They live in our tables and compile into Mastra `Agent`s. Swap with `removeAgent` + `addAgent`; `addAgent` silently ignores duplicate ids.
- **Models.** Set every internal model explicitly. Observational memory defaults to a Google model.
- **Errors.** `/v1` errors are problem+json: throw `ApiError`, or return `problem()`.
- **Schemas.** zod 4 everywhere. Request and response schemas go in `packages/shared`.
- **Tests.** Agent flows use the scripted mock model (`apps/api/test/support/mock-model.ts`). Database tests use `startTestSystem()` from `apps/api/test/int/helpers.ts` (Testcontainers, one database per file).

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
