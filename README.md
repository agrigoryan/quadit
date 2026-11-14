# Quadit

An AI-first workspace for tasks, docs and decisions (codename). People and agents are both members; every change is an event either can read from a cursor.

Requirements: the "AI-first workspace: requirements" doc. Data model: [docs/data-model.md](docs/data-model.md).

## Layout

| Path | What |
| --- | --- |
| `internal/core` | The product's own types: task, decision, event |
| `internal/engine` | Applies named changes: checks, writes rows and events in one transaction |
| `internal/store` | The data layer interface |
| `internal/store/sqlstore` | Shared SQL implementation and migrations |
| `internal/store/sqlite`, `internal/store/postgres` | Open a database and name its dialect |
| `internal/id`, `internal/rank` | UUIDv7 ids, manual-order strings |
| `internal/testdb` | Runs one test body on every database |

## Tests

```sh
go test ./...                      # SQLite only
```

To run the same tests on Postgres as well:

```sh
docker run -d --name quadit-pg -e POSTGRES_PASSWORD=quadit -e POSTGRES_DB=quadit \
  -p 127.0.0.1:54329:5432 postgres:17-alpine
QUADIT_TEST_POSTGRES='postgres://postgres:quadit@127.0.0.1:54329/quadit' go test -race ./...
```
