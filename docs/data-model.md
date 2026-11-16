# Data model

How Quadit stores work, why it is shaped this way, and where each idea came from.
The schema is in `internal/store/sqlstore/migrations/`; the row types are in `internal/core`.

## The write path

Every write, from a browser or an agent, is a **named change** with an id made by the caller:

```json
{"id": "0193…", "type": "task.update", "args": {"id": "SVA-12", "status": "In Progress"}}
```

The engine (`internal/engine`) applies it in one transaction:

1. Take the workspace's row lock. Writes to one workspace run one at a time on every database.
2. If the change id was used before, return the first answer and write nothing.
3. Check the actor's role, scope and the arguments. A refusal has a code, a message, the allowed values and the nearest match, and a few a reason that tells them apart from others of the same code (`in_use`, `number_taken`).
4. Write the rows.
5. Write one **event** per changed row, each with the next number in the workspace's sequence.
6. Write what follows from it in the same transaction: inbox items, watchers, mentions, the search index.
7. Remember the change id.

| Property | How |
| --- | --- |
| Safe to resend | `changes (workspace_id, id)` remembers every change id |
| Strict order | The row lock is held until commit, so number N is visible before N+1 is handed out |
| Nothing changes silently | Rows and their events commit together or not at all |
| Readers catch up with one number | "Everything after seq N" is the whole protocol for agents and browsers |
| All or nothing | A batch of changes is one transaction; a dry run is the same transaction rolled back |

After the commit a hub wakes whoever waits (held requests, live streams, the dispatcher). They read the feed from the database, not from the process that took the write, so several servers can share one database later.

## Events

An event names the row that changed (`entity`) and the object whose timeline it belongs to (`scope`). A comment's scope is its task, so a task's timeline is one indexed query.

| Shape of `data` | Means | A client does |
| --- | --- | --- |
| `{"row": {…}}` | A row was made, or changed in a way that is clearer whole (a pick) | Put the row in its copy |
| `{"id", "changes": {field: {from, to}}}` | Fields changed | Set each field to `to` |
| `{"ids": […], "changes": …}` | The same change to several rows of the reader's own (`notification.updated`: inbox items marked read or archived together) | The same, for each |
| `{"id", "gone": true}` | The row was removed for good | Drop it |
| `{"id", "changes", "blocks": […] or null, "deleted": […] or null}` | `doc.edited`: a page's blocks were edited. `id` and `changes` are the page's own; `blocks` are the blocks written, whole; `deleted` the ids of the blocks taken out | Apply the changes to the page, put each block in its copy, drop the deleted ones |

Two keys can be on the data of any event:

- `rule`: the id of the rule whose action made the change. A change a person or an agent made has none.
- `quiet: true`: the change brought history in (an import) and was not done now. It notifies nobody and sets off no rule; a webhook still gets it, with `quiet` in its payload.

The keys an event's data can have are defined once, by `core.EventData`; `internal/engine/testdata/events.golden` has an example of every event.

A relation is told twice: `relation.created` (or `relation.deleted`) belongs to the task at its `task_id` end, and `task.related` to the task at its `related_task_id` end, with the relation's id (`relation`), its `type`, `removed`, and the far end (`other_id`, `other_key`). An event belongs to one project, so a member who may read only the `related_task_id` end gets `task.related` alone, and gets it without `other_id` and `other_key`, as `/list/relations` gives them the row with that end blank. A client adds the relation's row from it (or drops it, when `removed`), unless it already has the whole row from the relation's own event.

A soft delete is a change to `deleted_at`. A page sent to the trash with the pages under it is one `doc.deleted` for each page, placed in that page's project and given to that page's audience, so no reader learns the id of a page they may not see. A browser's copy does not hold the trash, so what comes back from it comes whole: `task.updated` with `restored: true` carries the task's `row` as well as its `changes`, and a page brought back with the pages under it is one `doc.restored` for each page, with its `row`, so each goes only to those who may see that page. `decision.restored`, `attachment.restored`, `epic.restored`, `milestone.restored` and `cycle.restored` carry their `row` too; restoring an epic, a milestone or a cycle does not put its tasks back in it, which takes a `task.update` for each. An event with `audience_id` is for one member only: inbox items, and everything about a private page.

The feed is the task history, the record of who did what, what agents read from a cursor, what webhooks deliver, and what a browser replays to keep its copy current.

## Tables

| Group | Tables | Notes |
| --- | --- | --- |
| Identity | `workspaces`, `users`, `members`, `api_tokens` | People and agents are one kind of row, so anything that can point at a person can point at an agent. An agent has a workspace and a responsible person. A member carries role, handle, scope and budget |
| Work | `projects`, `statuses`, `labels`, `tasks`, `task_labels`, `task_relations`, `task_links` | See Tasks below |
| Planning | `epics`, `milestones`, `cycles`, `views`, `templates` | A view is a saved query plus a layout; agents run it by slug |
| Review | `decisions`, `decision_options`, `comments`, `preferences` | A comment hangs on a task, a decision, one option, a page or one block |
| Inbox | `notifications`, `watchers`, `refs` | `refs` is who mentions what: the "linked from" lists |
| Files | `files`, `attachments` | Bytes live in file storage; an attachment shows a file on something |
| Docs | `docs`, `doc_blocks`, `doc_versions`, `db_properties`, `db_views`, `doc_sources` | A page is rows of blocks with stable ids. A database is a page; its rows are pages under it |
| Feed | `events`, `changes`, `cursors` | Cursors are kept by the server and never move back |
| Wake-ups | `webhooks`, `webhook_deliveries`, `rules`, `jobs` | Deliveries and jobs are claimed in the database, so a second server can share them |
| Oversight | `agent_sessions`, `resources`, `resource_claims`, `integrations` | |
| Install | `sessions`, `identities`, `passkeys`, `recovery_codes`, `invites`, `one_time_tokens`, `settings`, `audit_log`, `rate_counters`, `push_subscriptions`, `oauth_clients`, `backups` | Outside any workspace's sequence |
| Search | `search_index` | FTS5 on SQLite, a `tsvector` column on Postgres |

### Tasks

- `number` comes from the project's counter, bumped in the same transaction. `key` (SVA-12) is kept on the row.
- `assignee_id` is who does the work. `waiting_on_id` is who has the next move. They differ while a task waits for a review.
- `updated_seq` moves when the task's own fields change. `activity_seq` moves on anything inside the task, comments and decisions included. "What is new on my tasks" filters on `activity_seq`, so a comment is never missed.
- `lease_holder_id` and `lease_until` are who is working on it right now. A lease that is not renewed ends by itself.
- `started_at`, `completed_at` and `canceled_at` follow the status category.
- `rank` is a string that sorts tasks in manual order. Moving a task writes one row.

### Decisions

- `decision.open` creates the question and its options and hands the task to whoever should answer.
- `decision.pick` records the answer and hands the task back to the asker. The first answer stands; the asker cannot answer its own question.
- `decision.unclear` is the asker saying the answer does not settle it: the question opens again for whoever answered.
- An approval is a decision with no options. One opened with an `action` can unlock a change the asker's scope says needs approval.

### Docs

- An edit is a list of block operations (insert, update, move, delete) in one change. Two people in one page each change their own blocks; a block changed by both keeps the later change, and the other is in the page's history.
- `doc.write` takes Markdown and keeps the blocks that did not change, so their comments stay attached.
- A version of the page as it was is kept at most every 15 minutes while it is edited, and whenever asked.
- A private page has an `owner_id`; its events carry that as their audience.
- A page built from data (a decision log, a changelog, the open questions) is built for each reader when it is opened, from what that reader may see, so two members can read it differently. It is not stored: it has no blocks and no versions, and search finds it by its title alone. What it says is found by searching the tasks and decisions themselves, not the page.

## Conventions

| Thing | Rule | Why |
| --- | --- | --- |
| Ids | UUIDv7, made by client or server | Sorts by time; a client can link new things before syncing |
| Times | Unix milliseconds in `*_at` columns | Identical in every database |
| Sequence numbers | `*_seq` columns | One number answers "what changed since" |
| Manual order | `rank` strings (`internal/rank`) | One-row moves; strings behave the same everywhere |
| Scoping | `workspace_id` on every row; a workspace-bound connection adds it to every query | A row in another workspace is "not found" |
| Deleting | `deleted_at`; purged after 30 days | Trash and restore |
| Secrets | Encrypted with the install's key, never returned | Storage keys, mail password, integration tokens |

## One data layer, two databases

The rest of the code talks to `store.DB` (`internal/store/store.go`): get, list, insert, update and delete rows of registered types, plus the few queries that need more (task filters, the feed, search). `sqlstore` implements it once for SQL:

- Row types are structs with `db` tags; a small mapper builds the statements. `,null` stores a zero value as NULL; `,json` stores a field as JSON.
- Migrations are written once with type macros (`{{ID}}`, `{{TS}}`, `{{JSON}}`, `{{BOOL}}`). SQLite gets TEXT and INTEGER; Postgres gets UUID, BIGINT, JSONB and BOOLEAN. A file named `NNNN_name.sqlite.sql` or `.postgres.sql` runs only there (search). goose runs them: [store.md](store.md) says how.
- Queries are written with `?` and rebound for Postgres.
- Every test that touches data runs on both through `internal/testdb`.

Another database is another implementation of `store.Store` that passes the same tests.

A backup is every table as JSON lines plus every file, so an archive made on one database restores onto the other.

## The browser's copy: the trial of ready-made stores

The requirements ask that client-side stores get a trial before one is written by hand. It was run on 2026-11-14 with the product's own shapes: 10,000 tasks, 2,000 decisions, 500 pages; 1,000 feed events one at a time; one filtered and sorted query; an optimistic write with undo; saving the whole copy to the device and a cold start; two tabs. Production builds, headless Chrome 157, an M4 Pro.

| | Hand-written (Zustand) | TanStack DB 1.0-rc | RxDB 17 | TinyBase 10 |
| --- | --- | --- | --- | --- |
| Load 12,580 rows | 3 ms | 20 ms | 8 ms in memory, 789 ms on IndexedDB | 108 ms |
| One feed event with 200 rows and a list on screen | 2.2 ms | 0.06 ms | 0.3 ms | 0.01 ms |
| Query re-read after an unrelated change | 1 ms, recomputed | incremental | incremental | incremental |
| Optimistic write with undo | ours, 40 lines | built in | by hand | by hand |
| Cold start from the device | 93 ms (a 90-line layer of our own) | 134 ms | 104 ms, rows stay on disk | 137 ms |
| Added to the first download, gzipped | 0 | 84 kB | 45 kB | 15 kB |
| Licence | MIT | MIT | Apache-2.0, with paid storages | MIT |

What decided it:

- **RxDB**'s free build opens at most 13 collections, and the product has about 27; every read is asynchronous; each collection needs a versioned schema.
- **TinyBase** has no optimistic layer; its tab sync needs its CRDT store, which is the opposite of a server-ordered copy, and its stock tab channel lost the 10,000-task table.
- **TanStack DB** fits the model best, but is a release candidate, costs 84 kB, and while one of a person's own changes waits for the server it hides incoming feed events for that whole collection.

So the copy stays hand-written, and the on-device copy planned after 1.0 gets a persistence layer of its own on top of it. The trial also showed where the hand-written store was slow (every subscriber ran on every event); the task list and board were then windowed and their subscriptions narrowed, which took one event on a 10,000-task list from 1.7 s of blocking to under 50 ms. The trial's code and raw numbers were kept outside the repository; TanStack DB is worth a second look once it is released as 1.0.

## Where the ideas came from

| Idea | From | What we changed |
| --- | --- | --- |
| Per-workspace sequence as feed cursor and version | Linear (sync id), Orbit (realtime sequence) | Per workspace, not global; events carry values, where Orbit's are "something changed" signals |
| Event written in the same transaction as the change | Orbit | Also the task history; Plane writes history later in a background job and can lose it |
| Agents as ordinary user rows | Plane and Vikunja (bot users) | Orbit keeps service accounts in a side table, which is why they cannot be assigned or notified |
| Task number from a counter row | Vikunja, Orbit | Works on both databases; Plane's advisory lock is Postgres-only |
| Fixed status categories, free names | Linear, Plane | Added `waiting` as a category |
| From/to values per changed field | Linear issue history, Plane activity | Kept as JSON in the event, not one column pair per field |
| Hashed tokens with a display prefix and scopes | Orbit, Vikunja | Plane stores tokens in plain text |
| Change ids for safe resends | Orbit idempotency keys | On every change, not two endpoints |
| Rank strings for order | Outline, Docmost (fractional index) | Orbit's integer positions rewrite many rows per move |
| One relation row per pair | Linear, Orbit | Vikunja's mirrored rows can drift |
| Blocks with stable ids | BlockNote, Notion | Synced through the same changes as tasks, not a second system |
| Cursors kept by the server, `waiting_on`, decisions, `activity_seq`, names instead of ids | Ours | From the frictions of running agents on Orbit |

Only ideas were taken. No code was copied; Plane, Vikunja and Docmost are AGPL.
