# Data model

How Quadit stores work, why it is shaped this way, and where each idea came from.
The schema itself is `internal/store/sqlstore/migrations/`; this page explains it.

## The write path

Every write, from a browser or an agent, is a **named change** with an id made by the caller:

```json
{"id": "0193…", "type": "task.update", "args": {"id": "0192…", "status_id": "0191…"}}
```

The engine (`internal/engine`) applies it in one transaction:

1. Take the workspace's row lock. Writes to one workspace run one at a time on every database.
2. If the change id was used before, return the first answer and write nothing.
3. Check the actor's role and the arguments. A refusal has a code, a message, and the allowed values.
4. Write the rows.
5. Write one **event** per changed row, each with the next number in the workspace's sequence.
6. Remember the change id.

| Property | How |
| --- | --- |
| Safe to resend | `changes (workspace_id, id)` remembers every change id |
| Strict order | The row lock is held until commit, so number N is visible before N+1 is handed out |
| Nothing changes silently | Rows and their events commit together or not at all |
| Readers catch up with one number | "Everything after seq N" is the whole protocol for agents and browsers |

## Tables

| Table | Holds | Notes |
| --- | --- | --- |
| `workspaces` | A team's space | `seq` is the last event number handed out |
| `users` | People and agents | One table: an agent can be assigned, mentioned and notified like a person. An agent has a workspace and a responsible person |
| `members` | A user's role and @handle in a workspace | Roles: owner (people only), admin, member |
| `api_tokens` | Credentials for agents and scripts | Only the SHA-256 is stored, plus a display prefix and scopes |
| `projects` | Container for tasks | Owns the key (SVA) and the task counter |
| `statuses` | A project's workflow | Free names; fixed categories: backlog, unstarted, started, waiting, done, canceled |
| `labels` | Tags | `project_id` NULL means shared by the workspace |
| `tasks` | The work | See below |
| `task_labels`, `task_relations` | Links | One relation row per pair; the reverse name is derived |
| `decisions`, `decision_options` | A question, its options, its answer | Kinds: choice, approval. States: open, picked, sent_back |
| `comments` | Discussion | On a task, a decision, or one option |
| `events` | The feed | Every accepted change, in order, with its new values |
| `changes` | Applied change ids | Makes writes safe to resend |
| `cursors` | Each member's place in the feed | Kept by the server; never moves backwards |

### Tasks

- `number` comes from the project's counter row, bumped in the same transaction. Numbers are never reused.
- `assignee_id` is who does the work. `waiting_on_id` is who has the next move. They differ while a task waits for a review.
- `updated_seq` moves when the task's own fields change. `activity_seq` moves on anything inside the task, comments and decisions included. "What is new on my tasks" filters on `activity_seq`, so a comment is never missed.
- `started_at`, `completed_at` and `canceled_at` follow the status category.
- `rank` is a string that sorts tasks in manual order. Moving a task writes one row.
- `deleted_at` is the trash. Nothing is removed in place.

### Decisions

- `decision.open` creates the question and its options, and with `ask` hands the task to whoever should answer.
- `decision.pick` records the answer and hands the task back to the asker.
- The first answer stands; a second is refused. The asker cannot answer its own question.
- `with_changes` needs a note. `none` and `declined` send the decision back.

### Events

An event names the row that changed (`entity`) and the top-level object whose timeline it belongs to (`scope`). A comment's scope is its task, so a task's timeline is one indexed query.

| Event | Data |
| --- | --- |
| `task.created` | The whole task |
| `task.updated` | `changes: {field: {from, to}}`, `labels_added`, `labels_removed` |
| `task.deleted`, `task.restored` | The task key |
| `comment.created` | The comment |
| `decision.opened`, `decision.picked` | The decision with its options |
| `project.created`, `status.created`, `label.created`, `member.added` | The new row |

The feed is the task history, the record of who did what, what agents read from a cursor, and what a local-first browser will replay.

## Conventions

| Thing | Rule | Why |
| --- | --- | --- |
| Ids | UUIDv7, made by client or server | Sorts by time; a client can link new things before syncing |
| Times | Unix milliseconds in `*_at` columns | Identical in every database |
| Sequence numbers | `*_seq` columns | One number answers "what changed since" |
| Manual order | `rank` strings (`internal/rank`) | One-row moves; strings behave the same everywhere, floats do not |
| Scoping | `workspace_id` on every row, in every query | A row in another workspace is "not found" |
| Deleting | `deleted_at` | Trash and restore; uniqueness uses partial indexes |

## Two databases, one schema

- Migrations are written once with type macros (`{{ID}}`, `{{TS}}`, `{{JSON}}`, `{{BOOL}}`). SQLite gets TEXT and INTEGER; Postgres gets UUID, BIGINT, JSONB and BOOLEAN.
- A file named `NNNN_name.sqlite.sql` or `NNNN_name.postgres.sql` runs only on that database, for things like full-text search.
- Queries are written once with `?` placeholders and rebound for Postgres.
- The code above the data layer uses `store.Store` and `store.Tx` (`internal/store/store.go`) and never sees SQL.
- Every test in `internal/engine` runs on both through `internal/testdb`.

## Where the ideas came from

| Idea | From | What we changed |
| --- | --- | --- |
| Per-workspace sequence as feed cursor and version | Linear (sync id), Orbit (realtime sequence) | Per workspace, not global; events carry values, where Orbit's are empty "something changed" signals |
| Event written in the same transaction as the change | Orbit | Also the task history; Plane writes history later in a background job and can lose it |
| Agents as ordinary user rows | Plane and Vikunja (bot users) | Orbit keeps service accounts in a side table, which is why they cannot be assigned or notified |
| Task number from a counter row | Vikunja, Orbit | Works on both databases; Plane's advisory lock is Postgres-only |
| Fixed status categories, free names | Linear, Plane | Added `waiting` as a category |
| From/to values per changed field | Linear issue history, Plane activity | Kept as JSON in the event, not one column pair per field |
| Hashed tokens with a display prefix and scopes | Orbit, Vikunja | Plane stores tokens in plain text |
| Change ids for safe resends | Orbit idempotency keys | On every change, not two endpoints |
| Rank strings for order | Outline, Docmost (fractional index) | Orbit's integer positions rewrite many rows per move |
| One relation row per pair | Linear, Orbit | Vikunja's mirrored rows can drift |
| Lowest-common-denominator time and id handling | Orbit | Type macros give Postgres native UUID and JSONB without a second schema |
| Cursors kept by the server, `waiting_on`, decisions, `activity_seq` | Ours | From the frictions of running agents on Orbit |

Only ideas were taken. No code was copied; Plane, Vikunja and Docmost are AGPL.

## Not built yet

Sessions and sign-in, files and uploads, epics, cycles, saved views, watchers and the inbox, docs, webhooks, and search each arrive as a later migration.
