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

## Layout

| Path | Holds |
| --- | --- |
| `cmd/quadit` | The binary: `serve`, `admin`, `backup`, `restore`, and the client commands |
| `internal/core` | The product's row types |
| `internal/store` | The data layer's interface; `sqlstore` implements it for SQLite and Postgres |
| `internal/engine` | Every change type, applied in one transaction with its events |
| `internal/server` | The HTTP API, feed, files, sign-in, background work, MCP |
| `internal/cli`, `internal/importer` | The command-line client and the importers |
| `internal/md`, `internal/formula`, `internal/rank`, `internal/id` | Markdown ↔ blocks, database formulas, manual ordering, ids |
| `internal/backup`, `internal/blob`, `internal/mail`, `internal/auth` | Archives, file storage, mail, credentials |
| `web` | The web app (React), built into the binary |

## Development

```bash
make test        # SQLite
make test-all    # SQLite and Postgres, with the race detector (needs Postgres: see docs/install.md)
make server      # the binary without the web app, for API work
make lint        # the Go linter, then the web app's lint and format check
cd web && pnpm check   # the web app: types, lint, format, tests
```

Every test that touches data runs on both databases. Dependencies are permissively licensed only.
