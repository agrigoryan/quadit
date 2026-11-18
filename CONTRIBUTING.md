# Contributing to Quadit

Thanks for helping. Bug reports and feature ideas go in [issues](https://github.com/agrigoryan/quadit/issues); for anything larger than a small fix, open an issue first so we can agree on the shape before you write the code. Security problems: see [SECURITY.md](SECURITY.md), not an issue.

## Build and run

You need Go (the version in `go.mod`), Node.js 24 and pnpm 10.

```bash
make build        # the web app, then the binary with it inside: bin/quadit
make server       # the binary without the web app: faster, for API work
make dev          # the server without the web app on 127.0.0.1:4780, data in ./data
make seed         # in another terminal: fill that server with sample data (scripts/dev-seed.sh)
```

After `make seed`, sign in as `owner@example.com` / `correct-horse-battery`. For the web app with hot reload, run `make dev` and `cd web && pnpm dev` (Vite sends the API to the server).

## Tests

Every test that touches data runs on SQLite, and on Postgres too when `QUADIT_TEST_POSTGRES` holds a URL. A Postgres to test against:

```bash
docker run -d --name quadit-pg -e POSTGRES_PASSWORD=quadit -e POSTGRES_DB=quadit -p 127.0.0.1:54329:5432 postgres:17-alpine
```

| Command | What |
| --- | --- |
| `make test` | The Go tests on SQLite |
| `make test-all` | The Go tests on SQLite and Postgres with the race detector (the Postgres above), then the web app's types and tests |
| `cd web && pnpm check` | The web app: types, lint, format, unit tests (Vitest) |
| `make e2e` | The end-to-end suite: Chromium against the binary (builds it first). Once: `cd web && pnpm exec playwright install chromium` |
| `make lint` | golangci-lint for Go, then the web app's lint and format check. CI runs this |

Before you open a pull request: `gofmt`, `go vet ./...`, `make lint`, `make test-all` and `cd web && pnpm check` are clean, and `make e2e` passes if you changed the web app.

### Generated files and goldens

- `make generate` writes the web app's types for every change and row (`web/src/types/*.gen.ts`) from the server. A test fails until it is run after a change's arguments or a row type change.
- Some tests compare against files written down once. When a change to them is intended, run the test with the variable below, then read the diff before you commit it:

| File | Variable |
| --- | --- |
| `internal/server/testdata/reads/*.golden` | `QUADIT_UPDATE_READS=1` |
| `internal/engine/testdata/events.golden` | `QUADIT_UPDATE_EVENTS=1` |
| `internal/engine/testdata/missing.golden` | `QUADIT_UPDATE_MISSING=1` |
| `internal/server/testdata/surface.txt` (the agent surface: it only ever grows within a major version) | `QUADIT_UPDATE_SURFACE=1` |
| `internal/store/sqlstore/testdata/migrations.txt` | `QUADIT_UPDATE_MIGRATIONS=1` |

### Database migrations

Migrations live in `internal/store/sqlstore/migrations/`, one set of files for both databases: `NNNN_name.sql` for every database, with column types as macros (`{{ID}}`, `{{TS}}`, `{{JSON}}`, `{{BOOL}}`, …), and `NNNN_name.sqlite.sql` / `NNNN_name.postgres.sql` for what only one of them has. A released file is never edited: a change to the schema, or a repair of rows already stored, is a new file with the next number, recorded with `QUADIT_UPDATE_MIGRATIONS=1`. There is no way down; an upgrade first copies the database, and `quadit upgrade --undo` puts the copy back. A new table also needs its row struct in `internal/core` and a line in `internal/store/tables.go` (that file says how).

### End-to-end tests

`web/e2e` is a [Playwright](https://playwright.dev) suite that drives the real binary in Chromium, one spec per area of the app. Each run starts `bin/quadit serve` on a free port with an empty data directory in the system's temp folder, makes the owner, an agent (`@coder`) and their tokens, and deletes it all at the end (`web/e2e/global-setup.ts`). After `make build`, `cd web && pnpm e2e tasks` runs the specs whose file name matches, `pnpm e2e --ui` opens Playwright's runner.

A test imports `test` and `expect` from `./quadit`, not from `@playwright/test`. It asks for `project` to get a project of its own, and for `quadit` to run the CLI (`quadit.cli`, `quadit.agent`) and to check what reached the server. Seed and check through the CLI or the API, never the database. Find things the way a person does (`getByRole` with the accessible name, `getByLabel`, `getByText`), and wait with web-first assertions, never a fixed sleep. A control that cannot be found by role and name is an accessibility defect: fix the control, not the test.

### Against real services

The suite runs without a network. Some checks also run against real services when told where they are:

```bash
# S3 (AWS, R2, MinIO), Azure Blob and Google Cloud Storage: the store's settings as JSON, as the admin area saves them
QUADIT_TEST_FILES_S3='{"kind":"s3","bucket":"quadit","endpoint":"http://127.0.0.1:9000","region":"us-east-1","access_key":"…","secret_key":"…"}' \
QUADIT_TEST_FILES_AZURE='{"kind":"azure","bucket":"quadit","account":"…","account_key":"…"}' \
QUADIT_TEST_FILES_GCS='{"kind":"gcs","bucket":"quadit","credentials":"{…service account key…}"}' \
  go test -run TestRealBuckets ./internal/blob

# Google's sign-in addresses, found the way sign-in finds them, and GitHub's answer about who a token belongs to
QUADIT_TEST_GOOGLE=1 QUADIT_TEST_GITHUB_TOKEN=$(gh auth token) go test -run TestRealProviders ./internal/server

# Automatic certificates, against an ACME authority that can reach this machine (Pebble, for one)
QUADIT_TEST_ACME=https://localhost:14000/dir,pebble.minica.pem,quadit.test,127.0.0.1:5001,127.0.0.1:5002 \
  go test -run TestAutomaticCertificate ./internal/app
```

## Layout

| Path | Holds |
| --- | --- |
| `cmd/quadit` | The binary: `serve`, `admin`, `backup`, `restore`, and the client commands |
| `internal/core` | The product's row types |
| `internal/store` | The data layer's interface; `sqlstore` implements it for SQLite and Postgres |
| `internal/engine` | Every change type, applied in one transaction with its events |
| `internal/server` | The HTTP API: routes, sign-in, reads (through the viewer), feed, files, background work |
| `internal/app` | Wiring the server together, and the commands that run on its machine |
| `internal/mcp` | The MCP server: the API's surface as MCP tools |
| `internal/cli`, `internal/importer` | The command-line client and the importers |
| `integrations` | The skill coding agents read (`quadit skill install`), and the Claude Code plugin around it |
| `web` | The web app (React, TypeScript), built into the binary |

Every write is a named change applied by `internal/engine`; every read of a workspace's data goes through the server's viewer, which knows who is asking and what they may see. In the web app, every write goes through `mutate` or `send` (`web/src/data/mutate.ts`) with types generated from the server, and the folders under `web/src` are layers that lint keeps from importing upward.

## Code style

The Go code follows John Ousterhout's *A Philosophy of Software Design*:

- **Deep modules.** A package, type or function is worth what it hides behind a small interface. Many small pieces that each do little are not simpler than one that does the whole job.
- **Hide information.** Each design decision (a format, a protocol, a retry rule) is known in one place. Group code by what it needs to know, not by the order things happen in.
- **Pull complexity down.** The module takes the difficulty on so its callers do not have to; no flag pushed up to the caller for a decision the module could make. No pass-through functions.
- **Split by meaning, never by size.** There are no length limits. A long function that reads as one story is fine; pieces that only make sense read together are one function.
- **Define errors out of existence** where possible; anything that decides access fails closed.
- **Comments say what the code cannot:** what a thing promises and why it is done this way, in full sentences. Not what the next line does, not the history of a change.
- **Precise, consistent names.** A name that is hard to choose usually marks a thing that is not one thing.

In Go, an error is returned, logged with `slog`, or discarded with `_ =` and the reason on the same line. A fix comes with a test that fails without it, and a test is named after the behaviour it checks.

The web app follows standard React and TypeScript practice first (the Rules of React, "You Might Not Need an Effect", established libraries, semantic HTML, Testing Library), with the same principles as the lens for depth and names. Every visible word goes through `t()` (strings in `web/src/i18n/en/`), data the store does not hold is read with TanStack Query, and there is no `any`, `!` or `@ts-ignore`.

Follow the patterns already in the files you touch. `make lint` and `pnpm check` hold what a tool can check.

## Commits and pull requests

- [Conventional Commits](https://www.conventionalcommits.org): `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `build`, `ci`, `chore`, `style`, with an optional scope (`fix(web): …`). A one-line subject that says what changed for the user or the code.
- Small commits, one topic each.
- A pull request says what it changes and how it was checked.

## Dependencies

Quadit is MIT licensed and stays that way. Prefer the standard library, and check that a new dependency is maintained (recent releases, real use) before adding it. What its licence may be depends on how it reaches a release:

- **Compiled into the binary or bundled into the web app** (Go modules, the web app's npm packages): a permissive licence (MIT, Apache-2.0, BSD, ISC, 0BSD, the Unlicense; OFL-1.1 for a font), or MPL-2.0. The MPL is file-level copyleft: its files are used unmodified, their notice is kept and their source is available (THIRD_PARTY_NOTICES says where); a changed MPL file would have to be published under the MPL itself. Never GPL, LGPL or AGPL: CI fails on one (`go run ./scripts/notices -check`).
- **Programs Quadit runs as separate processes** (git, FFmpeg, Chromium): any licence that lets them be redistributed, since they are not linked into Quadit and their licence does not reach its code. The archives and the `.deb` and `.rpm` packages contain none of them. The Docker image installs them from Alpine's packages, so it does carry GPL and LGPL programs: git (GPL-2.0) and FFmpeg (LGPL-2.1-or-later, with GPL-2.0-or-later parts as Alpine builds it). The image lists every package it holds with its licence in `/usr/share/doc/quadit/IMAGE_PACKAGES`, and their sources are Alpine's.

After adding or updating a dependency, run `make notices` and commit `THIRD_PARTY_NOTICES`: it holds the licence of every module and package a release contains, ships in every archive, package and image, and is served at `/licenses`.

## Versions and releases

Quadit follows [Semantic Versioning](https://semver.org). A release is a tag `vX.Y.Z` on `main`, and the version comes from that tag alone: GoReleaser sets it in the binary (`-X main.version`), and `quadit version` prints it. A build from a checkout prints `git describe` (`make build`) or `dev` (plain `go build`).

A change people or agents will notice gets a line under "Unreleased" in [CHANGELOG.md](CHANGELOG.md). To release: move those lines under the new version with the date, commit, and push the tag. The tag runs GoReleaser (`.goreleaser.yaml`, `.github/workflows/release.yml`): the archives, `.deb` and `.rpm` packages and checksums on a GitHub Release with notes grouped from the commit messages, the Docker images on `ghcr.io/agrigoryan/quadit` (`X.Y.Z`, `X.Y`, `X`, `latest`), and the Homebrew cask. `make release` makes the same into `dist/` locally, publishing nothing.

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).
