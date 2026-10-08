# Superagent web app: development plan

**Status:** started 2026-10-08. Builds on the API of [api-plan.md](api-plan.md) (M0–M9 merged).

**Progress:**
- W1 (foundation and the board): merged in PR #11. Verified in a browser against an API driven by a scripted model:
  - sign-in swapped the admin token for a device token;
  - the board and home page followed the tasks live;
  - an approval made on the task page let the lead finish, its report appeared without a reload, and accepting closed the task;
  - light and dark themes, and a phone's width.

  Browser tests run the same checks against the release image in CI, and fail on any CSP violation. That check caught zod probing for `eval`, which the CSP refuses, so zod runs `jitless`. In W2 it caught that setting arriving too late once the bundler moved the schemas into a shared chunk: `public/boot.js` now sets it before any module runs.
- W2 (conversations): merged in PR #12. Verified in a browser against an API driven by a scripted model (answers streamed word by word, a step slowed down to watch it):
  - the chief's answer streamed in, its tool calls showed as rows, and the stored answer took its place without a flicker or a repeat;
  - a message sent while the chief was answering waited for its turn;
  - leads' reports appeared as cards linked to their tasks, and notices of reports on the way as notes;
  - a task's transcript showed the brief, the lead's tool calls and its specialist's answer; it stayed whole while a call waited for approval, and after the approval the rest of the turn streamed in.
- W3 (the inbox): in review. Verified in a browser against the same scripted API:
  - the inbox put the calls to approve first, and accepting a result took it off the list at once;
  - the rail counted what waits;
  - the command palette (Ctrl+K) found pages and tasks, and a question typed into it opened the chief's conversation with the question sent.

**Related docs:**
- [decisions.md](decisions.md): D06 and D43–D48 cover the web app.
- [api-plan.md](api-plan.md): the API it talks to.

## 1. Goal and scope

A web app that runs the whole organization from a browser, on a desktop or a phone, over the tailnet. It replaces the `.http` walkthroughs as the way to use superagent day to day.

What it covers, milestone by milestone:
- the board and tasks, live;
- conversations with the chief of staff and the leads;
- the attention inbox;
- the organization (departments, agents, notes, schedules, knowledge);
- settings, models, usage and capabilities;
- workspaces and live browsers.

Not in scope:
- accounts or roles: one owner, as in the API;
- offline use;
- chat channels (D04).

## 2. Design

The design follows Mastra Factory, Mastra's agent-run software factory (open source, `mastracode/factory-ui` in the Mastra repository). We take its visual language and its patterns, not its code. Its design system, `@mastra/playground-ui`, is a 19 MB package versioned weekly with peer dependencies on Mastra's server packages, and it ships an `ee/` folder we must never import (D03). So we keep our own small design system and adapt Factory's tokens (Apache-2.0, credited in `THIRD-PARTY-NOTICES.md`).

### What we take from Factory

**The frame:**
- A dark rail (the sidebar) holds the navigation.
- The page sits in one rounded frame inset from the window edges, one step lighter than the rail.
- Cards and fields sit one step lighter again.

**Material:**
- Surfaces are drawn with a 1px inset rim and a short drop shadow rather than borders.
- Hover and press states are translucent layers of the foreground colour (4%, 6%, 9%, 12%), the same in both themes.
- Hover animates colour only, over 150 ms.

**Type:**
- Mona Sans Variable throughout.
- Text styles are named roles, each with a fixed size, weight and line height: title 18, heading 16, body 14, label 13, caption 12, meta 10.
- Weights stay at or below 500, except card titles (550).

**Colour:**
- Neutral greys carry the interface.
- Hues are reserved for meaning: a task's phase, its priority, status dots, and badges tinted at 13% on a dark surface.
- Dark is the default. Light comes from the same roles with the tint flipped, and the system preference is followed unless you pick one.

**Controls:**
- Buttons and fields are pills, 28/30/32 px tall.
- The primary button is the inverse colour (white on dark).
- Menus and popovers are rounded 14 px panels.

**Patterns:**
- The board: columns with a phase icon and a count badge; translucent cards with a meta line, a title, chips, a status line and one pill action.
- A conversation: a centred column, the owner's messages in bubbles, agents' answers as plain text, tool calls as foldable activity rows, and a composer whose ring lights up while an agent works.
- An attention center reachable from the sidebar footer.
- Live dots, and skeletons while loading.

### Our own touches

- Each department gets a colour (from its slug), so cards scan by department.
- Phases have their own icons and tones:
  - inbox: neutral
  - queued: blue
  - working: amber, pulsing
  - needs you (`waiting`): orange
  - review: purple
  - done: green
  - failed: red
  - cancelled: muted
- Costs and tokens appear wherever work happens: on cards, tasks and the home page.

## 3. Architecture

**App:**
- `apps/web`: Vite 8, React 19 and TypeScript, with Tailwind CSS 4 for styling.
- Base UI 1.x for accessible primitives (dialogs, menus, popovers, tooltips, selects, tabs, toasts), as Factory does.
- lucide icons, and react-markdown with GFM for reports and messages. Raw HTML is never rendered.

**Data:**
- TanStack Query holds the server state.
- A typed client calls `/v1` with `fetch` and validates responses with the zod schemas in `@superagent/shared`, the same ones the API uses.
- Errors are problem+json: a `ProblemError` carries the status, code and detail to the UI.

**Live updates (D46):**
- One connection to `GET /v1/events`, read with `fetch` so the token goes in a header.
- It resumes with `Last-Event-ID`, reconnects with backoff, and reloads everything on `reset`.
- Each task event refreshes the queries it affects: the board, that task, its events, the attention inbox.
- The sidebar shows whether the connection is live.

**Conversations (D47):**
- The chief's conversation and each task's transcript come from `/v1` in our own shapes (`ConversationMessage`, `LiveEvent` in `@superagent/shared`), never Mastra's.
- History comes in pages (`GET /v1/chief/messages`, `/v1/tasks/{id}/transcript`, newest first, `?before=` for older).
- While a conversation is on screen, its own stream (`GET /v1/chief/stream`, `/v1/tasks/{id}/stream`) sends the turn being taken: text as it is written, tool calls as they run, the messages that reach the agent.
- Mastra stores a turn's answer as it goes, and a stream that joins a turn midway sees only its latest step. So the history stays whole, its tool calls take their live status, and the live turn shows only what the history doesn't have yet. A turn that has ended gives way to its stored answer once a history fetched after its end has it (the stream names the answer's message ids).

**Sign-in (D45):**
- You paste a token once.
- An admin token is exchanged for a device token named after the browser (`POST /v1/tokens`). Only the device token is kept, in local storage. The admin token is never stored.
- Signing out revokes the device token.
- Pages that need the admin token (managing devices) ask for it and keep it in memory only.

**Hosting (D44):**
- The API serves the built app from its own origin: assets under `/assets` (cached for a year, they are hashed) and `index.html` for every other page path.
- `/api`, `/v1`, `/health` and `/ready` are untouched.
- One origin means no CORS, and the same `tailscale serve` exposes both.
- In development, Vite serves the app on :5173 and proxies `/api` and `/v1` (WebSockets included) to the API on :4111.

**Security headers on the app's pages:**
- `Content-Security-Policy: default-src 'self'`, no inline scripts, `frame-ancestors 'none'`, `object-src 'none'`.
- A small script file (`boot.js`, not an inline script) runs before the app: it applies the theme before the first paint, and switches zod to `jitless` parsing before any schema is made.
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`.

**Tests:**
- Unit and component tests: Vitest with jsdom, Testing Library, and MSW mocking only the network.
- Browser tests: Playwright (Chromium) against the packaged stack in CI. They catch what jsdom can't: the served app, the CSP, sign-in, live updates.

## 4. Pages

| Path | Page | Milestone |
|---|---|---|
| `/sign-in` | Paste a token | W1 |
| `/` | Home: what needs you, what's running, what finished | W1, richer in W3 |
| `/board` | The board, live, filterable by department | W1 |
| `/tasks/:id` | A task: brief, report, checklist, artifacts, history, actions, a message to the lead | W1 |
| `/chief` | Conversation with the chief of staff | W2 |
| `/tasks/:id` (transcript) | The lead's thread: its steps, tools and specialists | W2 |
| `/inbox` | The attention inbox: approvals, questions, reviews, problems, health | W3 |
| `/departments/:slug` | A department: its team, notes, schedules and board | W4 |
| `/schedules`, `/knowledge` | Recurring tasks; documents and search | W4 |
| `/usage` | Tokens and cost by day, department, model, agent, task | W5 |
| `/settings/...` | Providers and models, preferences, profile, devices, secrets, MCP servers, plugins, skills | W5 |
| `/tasks/:id` (files, browser), `/settings/browsers` | Workspaces, sandboxes, live browsers and sign-in sessions | W6 |

## 5. Milestones

Each milestone ends like the API's: tests pass, a PR, one review, fixes, CI green, merged.

### W1: foundation and the board

**Build:**
- `apps/web`: the design system (tokens, type roles, buttons, badges, fields, dialogs, menus, tooltips, tabs, toasts, skeletons, empty states, markdown), the app frame with its sidebar (a drawer on phones), and light and dark themes.
- Sign-in, sign-out, and a gate on every page: a revoked token sends you back to sign-in.
- The API client and live events.
- Home: what needs you, what's in progress, what finished recently.
- Board: columns by phase, department filter, live cards (phase, priority, progress, lead, tokens and cost), a new-task dialog.
- Task page: brief, report, checklist, artifacts, history, usage; accept, send back, cancel, edit title, priority and due date; message the lead (steer or queue).
- The API serves the app (static files, page fallback, security headers). The API image builds and includes it.
- CI runs the web unit tests in `pnpm check` and Playwright against the packaged stack.

**Done when:**
- In a real browser, from the release images: you sign in with the admin token (a device token is created, the admin token isn't kept); a task created through the API appears on the board without a reload; you open it, edit it and cancel it.
- Lint, typecheck, unit and browser tests pass.

### W2: conversations

**Build:**
- API: `/v1/chief/messages` (history, and sending with a streamed answer) and `/v1/tasks/{id}/transcript`.
  - Both return a normalized message shape from `@superagent/shared`, so clients don't depend on Mastra's internal formats.
  - Live following of a thread goes through our own module (D22).
- Web: the chief page; the task transcript; tool calls and delegations as activity rows; leads' reports as notification cards linking to their tasks.

**Built:**
- API:
  - `GET`/`POST /v1/chief/messages`, `POST /v1/chief/stop`, `GET /v1/chief/stream`;
  - `GET /v1/tasks/{id}/transcript` and `/stream`.
  - `ConversationService` reads the threads (the only module that subscribes to them) and normalizes:
    - stored messages into owner, agent, report, brief and note messages;
    - tool calls into rows with a status (a delegation carries its specialist's answer);
    - stream chunks into live events.
  - A message to a busy chief waits for its turn to end, then goes out with any others as one turn (`DispatchService.messageChief`).
  - Reports carry their task's id in the notification's metadata; older ones are matched by their number.
  - Live streams close when their token is revoked, through one helper that `/v1/events` now uses too.
- Web:
  - the chief page (`/chief`): streaming answers, tool rows that open to their arguments and results, report cards, notes, a stop button, earlier messages on demand, and a composer that holds a message until the current answer is done;
  - a quick line to the chief on the home page;
  - the transcript as a tab of the task page (`?view=transcript`).

### W3: the inbox

**Build:**
- The attention inbox with each kind's action:
  - approvals: approve, or decline with a reason (arguments shown);
  - questions: answer, which goes to the lead;
  - reviews: accept or send back;
  - problems: open the task;
  - health: what to fix.
- A count in the sidebar.
- A command palette (⌘K).
- Opt-in browser notifications.
- A web manifest, so the app can be added to a phone's home screen.

**Built:**
- **The inbox** (`/inbox`) puts what stops an agent first (calls to approve, questions, tasks stuck or stopped), then results to review and setup, newest first within each kind. A filter by kind lives in the URL (`?kind=`). Each item carries its action:
  - approvals: the approval card, with its task;
  - questions: an answer, which sends the task back to its lead;
  - reviews: accept, or send back with the changes you want;
  - problems: a task stuck in the inbox goes to its lead, and one that stopped takes a message telling the lead how to go on;
  - setup: what is wrong, and what to do.

  An item leaves the list as soon as its action goes through. The rail counts everything waiting, and the home page links to the inbox.
- **The command palette** (⌘K, Ctrl+K, or Search in the rail) finds pages, departments and the board's tasks. It also holds actions: a new task, the theme, and "Ask the chief", which opens the conversation with what you typed sent. It loads the first time it opens.
- **Notifications** are opt-in, from the account menu or the inbox (D48), and work in desktop browsers: a phone's browser refuses them from a page, and the app says so. While the app's tab is hidden, a new item that needs you shows as a notification (task items as they happen, setup items within a minute), and a click brings the app to its task. Turning them on shows a first one, so a browser that can't show them is found out then.
- **The web manifest and icons** let a phone add the app to its home screen. The PNG icons are rendered from `favicon.svg` (`pnpm --filter @superagent/web icons`).

### W4: the organization

**Build:**
- Departments (create, edit, archive).
- Agents: instructions, model, tool, skill and MCP grants with approvals, versions and activation.
- Department notes and your profile.
- Schedules: create, edit, pause, run now, with readable cron.
- Knowledge: upload, search, delete.

### W5: settings and usage

**Build:**
- Providers: add, test, models, prices.
- Model roles, timezone, concurrency.
- Devices (with the admin token).
- Secrets, MCP servers, plugins (preview, then install), skills.
- The usage page: totals, by day, and by department, model, agent and task.

### W6: workspaces and browsers

**Build:**
- A task's files: tree, preview, download.
- Sandboxes.
- Live browser views:
  - a task's browser, with takeover;
  - identities and their sign-in sessions, over the live-view WebSocket (`?apiKey=`, which the request log never records).

## 6. Risks

| Risk | Mitigation |
|---|---|
| A token in local storage is readable by any script on the page | Strict CSP (scripts from our origin only), no raw HTML in markdown, no third-party scripts; device tokens are per browser and revocable |
| Drift between the API and the app | Responses are parsed with the shared zod schemas; Playwright runs against the real images in CI |
| Mastra's message and stream formats change | The app reads conversations only through `/v1` (W2), normalized on the server, with a contract test |
| Bundle size | Routes load lazily; no chart or editor libraries until a page needs one |
