# superagent

[![CI](https://github.com/SohaibBelaroussi/superagent/actions/workflows/ci.yml/badge.svg)](https://github.com/SohaibBelaroussi/superagent/actions/workflows/ci.yml)

A self-hosted personal assistant organized like a company, built on [Mastra](https://mastra.ai).

- A **chief of staff** you talk to.
- **Departments** that do the work, each with a lead agent and specialist agents.
- A **board** where you watch tasks move.

Everything runs behind one HTTP API and ships as Docker images. Web and mobile clients come later.

> **Status:** early development. M0 (foundation), M1 (model providers), M2 (departments and agents) and M3 (tasks, board and dispatch) are done. See the [plan](docs/api-plan.md) for M4–M9.

## Design

- [Vision and architecture](docs/vision/superagent-architecture.html). Open it in a browser.
- [Decisions](docs/decisions.md)
- [API development plan](docs/api-plan.md)
- [Verified Mastra 1.74 notes](docs/notes/mastra-1.74.md)

## Quick start

You need Node 22.22+ (24 LTS recommended), pnpm 10 and Docker.

1. Install dependencies and create your env file:

   ```bash
   pnpm install
   cp .env.example .env
   ```

2. Fill in `.env`: `POSTGRES_PASSWORD` (and the matching `DATABASE_URL`), `SUPERAGENT_ADMIN_TOKEN` (at least 32 characters) and `STUDIO_TOKEN`. `.env.example` shows a one-line command that generates a token.

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

To run the packaged image instead, use `pnpm stack:up`. The container listens on http://127.0.0.1:4112.

The web tools (search and page reading) use two self-hosted services from `compose.yaml`: SearXNG and Crawl4AI. Start them with `docker compose up -d searxng crawl4ai` after setting `CRAWL4AI_API_TOKEN` in `.env`.

For a request-by-request tour, open the files in [docs/http/](docs/http/) in VS Code (REST Client) or a JetBrains IDE.

## API layout

| Prefix | What |
|---|---|
| `/health`, `/ready` | Liveness and readiness. Public |
| `/api/*` | Mastra's built-in routes: agents, threads, memory, schedules. Token required |
| `/v1/*` | The superagent control plane: tokens, model providers, settings, departments, agents, the tool catalog, tasks and the board, and live task events (`/v1/events`, SSE). Token required |

## Development

```bash
pnpm check
```

This runs the EE-import guard, lint, typecheck, unit tests and integration tests. Integration tests need Docker.

Other commands:
- `pnpm test:e2e` runs against a running stack (`pnpm stack:up` first).
- `pnpm test:live` runs against your real model provider, using the `LIVE_LLM_*` keys in `.env`: connectivity checks, delegation and a task from dispatch to report.
- `pnpm studio` opens Mastra Studio against the dev server. Log in with `STUDIO_TOKEN`.

CI runs the same checks on every pull request. It also builds the Docker image and runs the e2e suite against it.

## License

[MIT](LICENSE)
