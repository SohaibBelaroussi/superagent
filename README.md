# superagent

[![CI](https://github.com/SohaibBelaroussi/superagent/actions/workflows/ci.yml/badge.svg)](https://github.com/SohaibBelaroussi/superagent/actions/workflows/ci.yml)

A self-hosted personal assistant organized like a company, built on [Mastra](https://mastra.ai).

- A **chief of staff** you talk to.
- **Departments** that do the work, each with a lead agent and specialist agents.
- A **board** where you watch tasks move.

Everything runs behind one HTTP API and ships as Docker images. A web app, served by the API, runs it from a browser or a phone; a mobile app comes later.

> **Status:** the API is built (M0–M9, see the [plan](docs/api-plan.md)). The web app is under way: W1 (foundation, sign-in, home, the live board and tasks). See the [web plan](docs/web-plan.md) for W2–W6.

## Design

- [Vision and architecture](docs/vision/superagent-architecture.html). Open it in a browser.
- [Decisions](docs/decisions.md)
- [API development plan](docs/api-plan.md)
- [Web app plan](docs/web-plan.md)
- [Verified Mastra 1.74 notes](docs/notes/mastra-1.74.md)

## Quick start

You need Node 22.22+ (24 LTS recommended), pnpm 10 and Docker.

1. Install dependencies and create your env file:

   ```bash
   pnpm install
   cp .env.example .env
   ```

2. Fill in `.env`: `POSTGRES_PASSWORD` (and the matching `DATABASE_URL`), `SUPERAGENT_ADMIN_TOKEN` (at least 32 characters), `SUPERAGENT_ENCRYPTION_KEY` (32 random bytes, base64), `STUDIO_TOKEN`, and `S3_ACCESS_KEY` and `S3_SECRET_KEY` for document storage. `.env.example` shows one-line commands that generate them.

3. Start Postgres and the API:

   ```bash
   pnpm db:up
   pnpm dev
   ```

   The API listens on http://127.0.0.1:4111, and the interactive API docs are at http://127.0.0.1:4111/v1/docs.

4. Check that your token works:

   ```bash
   curl -H "Authorization: Bearer <SUPERAGENT_ADMIN_TOKEN>" http://127.0.0.1:4111/v1/me
   ```

5. Start the web app, and sign in with your admin token:

   ```bash
   pnpm dev:web
   ```

   It runs on http://127.0.0.1:5173 and talks to the API through Vite's proxy. Signing in swaps the admin token for a token for this browser, which is the only one kept; signing out revokes it.

To run the packaged image instead, use `pnpm stack:up`. The container listens on http://127.0.0.1:4112 and serves the web app on the same address.

The web tools (search and page reading) use two self-hosted services from `compose.yaml`: SearXNG and Crawl4AI. Start them with `docker compose up -d searxng crawl4ai` after setting `CRAWL4AI_API_TOKEN` in `.env`. Document uploads are stored in SeaweedFS: `docker compose up -d seaweedfs`.

Agents granted `files` or `shell` work in a sandbox container per task, run by the runner (the only service that talks to Docker). In dev, build the sandbox image once with `docker compose --profile app build sandbox-dev`, set `RUNNER_TOKEN` and `RUNNER_URL` in `.env`, and start the runner next to the API with `pnpm dev:runner`. The packaged stack runs it for you.

Agents granted `browser` get a Chromium of their task's own, also run by the runner, with no way out but the egress proxy (public sites only). Build the browser image and start the proxy with `pnpm browsers:up`. Watch a task's browser, or take it over, from the live view (`/v1/tasks/{id}/browser/stream`, a WebSocket). To let agents browse signed in, create a browser identity, sign it in yourself through its sign-in session and live view, and name it in the agent's browser grant. On Ubuntu 24.04 hosts, Chromium's sandbox needs `sysctl kernel.apparmor_restrict_unprivileged_userns=0`.

Agents can be given more than the built-in tools (`GET /v1/capabilities` lists everything):
- **Plugins** bring skills and MCP servers. Preview one from GitHub (`POST /v1/plugins/preview` with `{ "source": { "kind": "github", "repo": "owner/repo", "ref": "v1.2.3" } }`), then install it. Agent Plugins 1.0, Claude Code and Codex plugins, and plain skill folders work.
- **Skills** attach to departments or agents (`"skills": ["plugin"]` or `["plugin/skill"]`).
- **MCP servers** too (`"mcp": [{ "server": "slug", "tools": [...], "requireApproval": true }]`). Add remote ones by hand with `POST /v1/mcp-servers`.
- **Secrets** they need go in the vault (`PUT /v1/secrets/{NAME}`). A `GITHUB_TOKEN` secret raises GitHub's rate limits for plugin installs.

Plugins' stdio MCP servers run in containers of their own: build their image and start the egress proxy with `pnpm mcp:up`.

Every run is traced (Mastra Studio's Traces page shows them, tagged `task:<id>` and `dept:<slug>`), and every model call is counted:
- **Task cards** show their tokens and cost: the lead's calls, its specialists' and memory's.
- **`GET /v1/usage`** groups tokens and cost by department, task, agent, model or day.
- **Costs** come from the prices you give your models (`PUT /v1/providers/{id}/prices`, USD per million tokens). A model without a price counts tokens at no cost.

## On a server

The stack runs from prebuilt images under rootless Docker, behind `tailscale serve`:
- `pnpm release <version> --save` builds the images into one tarball.
- `compose.prod.yaml` runs them with limits and rotated logs.
- `scripts/backup.sh` backs up the database, documents and task files.
- `scripts/restore-drill.sh` proves a backup restores.

See the runbooks: [server](docs/runbooks/server.md), [upgrades](docs/runbooks/upgrade.md), [backups](docs/runbooks/backups.md).

For a request-by-request tour, open the files in [docs/http/](docs/http/) in VS Code (REST Client) or a JetBrains IDE.

## API layout

| Prefix | What |
|---|---|
| `/health`, `/ready` | Liveness and readiness. Public |
| `/api/*` | Mastra's built-in routes: agents, threads, memory, schedules. Token required |
| `/v1/*` | The superagent control plane: tokens, model providers, settings, departments, agents, the tool catalog, tasks and the board, live task events (`/v1/events`, SSE), your profile, department notes, knowledge documents, schedules, the attention inbox, task files and sandboxes, browsers, browser identities and live views (WebSockets: a bearer header, or `?apiKey=` from a browser), capabilities, secrets, MCP servers, skills and plugins, model prices and usage. Token required |
| everything else | The web app, from the image (`WEB_DIR`): its files are public, its data comes from `/v1` |

## Development

```bash
pnpm check
```

This runs the EE-import guard, lint, typecheck, unit tests and integration tests. Integration tests need Docker.

Other commands:
- `pnpm test:e2e` runs against a running stack (`pnpm stack:up` first).
- `pnpm test:web` runs the browser tests (Playwright) against a running stack. `PW_CHANNEL=msedge` or `chrome` uses an installed browser; otherwise run `pnpm --filter @superagent/web exec playwright install chromium` once.
- `pnpm test:live` runs against your real model provider, using the `LIVE_LLM_*` keys in `.env`: connectivity checks, delegation and a task from dispatch to report.
- `pnpm studio` opens Mastra Studio against the dev server. Log in with `STUDIO_TOKEN`.

CI runs the same checks on every pull request. It also builds the images, runs the stack from them as a server would (`compose.prod.yaml`), runs the e2e and browser suites against it, then backs it up and restores the backup in a drill.

## License

[MIT](LICENSE)
