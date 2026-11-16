# Quadit

Tasks, decisions and docs for a small team of people and AI agents. One binary, self-hosted.

Quadit (a working name) is Linear's tasks and Notion's docs in one place, built so agents are members, not add-ons: they have accounts and roles, read one ordered feed of everything that changes, and ask people for decisions in a form that takes one tap to answer.

## What it does

| Area | In short |
| --- | --- |
| Tasks | Projects, custom statuses, labels, sub-tasks, epics with milestones, cycles, estimates, saved views, trash. Every open task says who it is **waiting on** |
| Decisions | A question inside a task with options, media per option, a recommendation, and an answer: this one, this one with changes, none, or approve/decline. The task moves to whoever has the next move by itself |
| Docs | A page tree with a block editor, edited by several people and agents at once, block by block. Version history, databases with formulas and rollups, Markdown in and out, two-way sync with a folder in a git repository |
| Agents | Workspace members with roles, scopes, budgets and a person responsible. One API with names instead of ids, compact text output, a change feed with server-kept cursors, held requests, webhooks, an MCP server, and a command-line tool |
| Oversight | Dashboard, live view of what each agent is doing, shared-resource queues, session records, approvals, audit log |
| Running it | SQLite or Postgres. Files on disk, S3-compatible storage, Google Cloud Storage or Azure. Password, passkeys, two-step codes, Google, GitHub and OpenID Connect sign-in. Scheduled, verified backups |

## Quick start

```bash
make build                      # needs Go 1.26 and pnpm
./bin/quadit serve              # http://localhost:4780, data in ./data
```

Open the address, create the first account and workspace, and you are in. Or with Docker:

```bash
docker compose -f deploy/docker-compose.yml up -d
```

To look around with sample data: `make server && make dev` in one terminal, `make seed` in another, then sign in as `owner@example.com` / `correct-horse-battery`.

## For agents

```bash
quadit login https://quadit.example.com qd_your_token
quadit me            # who am I: role, projects, budget, feed position
quadit work          # what waits on me, what is assigned, unread inbox
quadit events cursor=main mine=1 others=1 wait=50    # held until something happens
quadit context SVA-12                                # everything needed to work on it
quadit result SVA-12 "Burst is 20% larger." checked="in game at 1x and 2x" file=burst.png
```

See [docs/agents.md](docs/agents.md). The same surface is an MCP server at `/mcp` and an OpenAPI document at `/api/v1/openapi.json`.

## Documents

| File | About |
| --- | --- |
| [docs/install.md](docs/install.md) | Running it: settings, storage, sign-in, backups, upgrades, monitoring |
| [docs/agents.md](docs/agents.md) | Connecting agents: tokens, the feed, wake-ups, the CLI, MCP |
| [docs/data-model.md](docs/data-model.md) | How data is stored and why |
| [docs/store.md](docs/store.md) | The data layer: migrations on goose, restores, and the queries |
| [docs/code-style.md](docs/code-style.md) | How the code is designed and written |

## Layout

| Path | Holds |
| --- | --- |
| `cmd/quadit` | The binary: `serve`, `admin`, `backup`, `restore`, and the client commands |
| `internal/core` | The product's row types |
| `internal/store` | The data layer's interface; `sqlstore` implements it for SQLite and Postgres |
| `internal/engine` | Every change type, applied in one transaction with its events |
| `internal/server` | The HTTP API: routes, sign-in, reads (through the viewer), feed, files, background work |
| `internal/settings` | The install's settings: the environment over the stored value, sealed secrets, a short cache, safe values when unreadable |
| `internal/app` | Wiring the server together, and the commands that run on its machine (`serve`, `admin`, `backup`, `restore`, `upgrade`) |
| `internal/mcp` | The MCP server: the API's surface as MCP tools |
| `internal/github`, `internal/reposync` | The GitHub integration; pages kept in step with Markdown files in a git repository |
| `internal/hub`, `internal/webpush`, `internal/picture` | Waking held requests, browser push, pictures of pages through a headless browser |
| `internal/cli`, `internal/importer` | The command-line client and the importers |
| `internal/md`, `internal/formula`, `internal/rank`, `internal/id`, `internal/plainjson` | Markdown ↔ blocks, database formulas, manual ordering, ids, JSON of plain values |
| `internal/backup`, `internal/blob`, `internal/mail`, `internal/auth` | Archives, file storage, mail, credentials |
| `internal/testdb` | Every kind of database, for tests |
| `web` | The web app (React), built into the binary |

## Development

```bash
make test        # SQLite
make test-all    # SQLite and Postgres, with the race detector (needs Postgres: see docs/install.md), then the web app's types and tests
make server      # the binary without the web app, for API work
make lint        # the Go linter, then the web app's lint and format check
make generate    # web/src/types/changes.gen.ts, the web app's types for every change, from the engine
cd web && pnpm check   # the web app: types, lint, format, tests (Vitest)
make e2e         # the end-to-end suite: Chromium against the binary (builds it first)
```

Every test that touches data runs on both databases. Dependencies are permissively licensed only.

### The web app

`web/src` is in layers, bottom up: `types` (the wire types, the generated `changes.gen.ts` among them) and `i18n`; `lib`; `data` and `hooks`; `nav`; `ui`; the feature folders (`tasks`, `detail`, `decisions`, `docs`, `insights`, `settings`, `admin`, `auth`); `shell`, `pages` and `palette` on top. Lint keeps each layer to the ones below it; [docs/code-style.md](docs/code-style.md) has the rest of the rules.

- The browser holds a copy of the workspace (`data/store.ts`): `data/sync.ts` fills it from `/bootstrap` and keeps it current from the event feed, shared by the tabs. Components read it through `data/selectors.ts`, and ask `useCan()` (`data/access.ts`) what the signed-in member may do.
- Every write is a named change through `mutate` or `send` (`data/mutate.ts`): it shows at once, waits on the device (`data/outbox.ts`) until the server answers, and is undone if refused. Its name and arguments are typed from `types/changes.gen.ts` (`make generate`).
- What the copy does not hold (settings lists, a task's history, a page's blocks, the trash, the admin pages) is read with TanStack Query, through the one client in `data/query.ts`.
- A task property (status, assignee, due date…) is described once under `tasks/properties/`; the pickers, the property panel, the bulk bar, the filters and the rest read that table. A form in a dialog is built on `ui/form-dialog`.
- Unit and component tests (Vitest, Testing Library) sit beside the file they check and run in `pnpm check`.

### End-to-end tests

`web/e2e` is a [Playwright](https://playwright.dev) suite that drives the real binary in Chromium: one short spec per area of the app (sign-in, tasks, keyboard, board, task page, decisions, docs, private pages, palette, live updates, offline, read-only access, project limits, trash, settings, phone width). It is not part of `pnpm check`, because it needs the binary.

- First time: `cd web && pnpm exec playwright install chromium`.
- `make e2e` builds and runs everything. After `make build`, `cd web && pnpm e2e` runs it again; `pnpm e2e tasks` runs the specs whose file name matches, `pnpm e2e --ui` opens Playwright's runner, `pnpm e2e --headed` shows the browser.
- Each run starts `bin/quadit serve` on a free port with a new empty data directory in the system's temp folder, makes the owner through the first-run page, an agent (`@coder`) and a token for each, and deletes it all at the end (`web/e2e/global-setup.ts`). It never touches another server. The server's log is left in `web/test-results/quadit-server.log`.
- In CI a failed test is retried once with a trace; the HTML report and traces are kept as the run's `playwright-report` artifact (`pnpm exec playwright show-trace <trace.zip>` opens one).

To add a test, put it in the spec of its area (or a new `web/e2e/<area>.spec.ts`) and import `test` and `expect` from `./quadit`, not from `@playwright/test`. A test is signed in as the owner. It asks for `project` to get a new project of its own, and makes what it needs with `project.newTask(title, "status=Done", …)`; it asks for `quadit` to run the CLI as the owner (`quadit.cli`) or as the agent (`quadit.agent`) and to check what reached the server (`quadit.task(key)`). Seed and check through the CLI or the API, never the database. Find things the way a person does: `getByRole` with the accessible name, `getByLabel`, `getByText`; no CSS classes. Wait with web-first assertions (`expect(locator).toBeVisible()`, `expect.poll`), never a fixed sleep. Give anything that is not inside the test's project (a token, a workspace name) a name of its own, so the test can run again on the same server. A control that cannot be found by role and name is an accessibility defect: fix the control, not the test. A test that shows a product bug is written as `test.fixme` with a comment saying what is wrong.
