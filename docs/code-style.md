# Code style

What "readable" means in this repository, as rules a reviewer can check. `make lint` checks the ones a tool can; the rest are for the person (or agent) writing and the one reviewing. `internal/importer` is the model to copy: an interface with an explicit list of implementations, one run of work as a struct with small named methods, and a package comment that says how the package is laid out.

## Go

### Packages and files
1. Every package has one doc comment saying what it is for and how its files are laid out.
2. Every file other than the package's doc file opens with one line saying what is in it. One topic per file; the file's name is the topic. There is no limit on a file's length: a file is split when it holds more than one topic, never because it is long. A long file about one thing stays one file.
3. Packages below `server` never import it. `server` holds routing, the request context, sign-in and thin handlers; a feature with logic of its own is a package.

### Functions
4. A function does one thing a reader can name. There are no limits on its length, its nesting or its number of branches: a long function that reads top to bottom as one story is fine, and so is deep nesting that follows the shape of the data. Split a function when a part of it has a name of its own and the whole reads better with that name in its place; when work has many steps that share state, a struct for one run with named methods is the usual form (see `internal/importer`). Never split only to make something shorter or flatter.
5. A call should read as what it says. When a function's parameters are hard to tell apart at the call site (several of the same type in a row, or bare `true, false`), pass a struct with named fields instead.
6. Every exported name, and every function of 20 lines or more, has a comment saying what it is for, starting with its name. A comment sits on the declaration it describes: moving code moves its comment.
7. Comments say what a thing is for, in plain words. They do not restate the code, and they do not tell the history of a change.

### Wiring and state
8. No `init()` for registration. A feature is named in an explicit list (routes, background loops, job kinds, change types, import sources).
9. No package-level mutable state except lookup tables. A hook is a field set by the constructor.
10. Every goroutine has an owner that can wait for it. `ctx` is the first parameter and is not stored in a struct, except in a struct that is one run of work and says so. `context.Background()` appears only in `main`, in tests, and in detached work that says why it is detached.

### Errors
11. An error is returned, logged with `slog`, or discarded with `_ =` and the reason on the same line. Nothing else.
12. A store `Get` used to ask "is it there?" checks `errors.Is(err, store.ErrNotFound)`; any other error is returned. A database outage is never answered as "not found".
13. A count, a limit or a setting that decides access fails closed: when it cannot be read, the answer is no.
14. Errors are matched with `errors.Is` or `errors.As`, never by their text. Wrapping uses `%w`.

### Handlers, reads and writes
15. An HTTP handler is `func(x *c) error` named `handle<Verb><Object>` and does three things: parse the request, call, write the answer.
16. Every write is a change, handled in `internal/engine`. Read logic takes a viewer (who is asking, in which workspace, limited to which projects) and a `ctx`. Neither builds an `http.Request` to reach the other.

### Names
17. Names are words. Short names are kept for these and nothing else: `st` the `store.Store`, `db` a workspace-bound `store.DB`, `tx` a `store.Tx`, `x` the request (server only), `c` the change context (engine only), `a` a change's arguments, `t` a task, `ws` the workspace row, `wsID` its id.
18. A state or a kind that code compares against has a named constant in `core`. A number used twice has a name; durations are `time.Duration`.
19. Prefer the standard library (`slices`, `maps`, `cmp`, `strings.Cut`) to a local helper that does the same.
20. "Page" in prose, in the web app and in handler names; `Doc` in types, tables and change names. They are the same thing.

### Tests
21. A test file is named after the file whose behaviour it checks; a test is named after the behaviour (`TestSignInGivesUpOnASilentProvider`), never after the occasion it was written on.
22. A test of several behaviours has a `t.Run` for each. Helpers call `t.Helper()`. Waiting is done by polling for the result, not by a fixed sleep.
23. A fix comes with a test that fails without it.

### The gate
24. `gofmt`, `go vet` and `make lint` are clean. A `//nolint` names the linter and gives the reason.
25. `make test-all` (SQLite and Postgres, with the race detector) passes before anything is released.

## Web app

`pnpm check` checks the rules a tool can (types, lint, format, tests). The folders under `web/src` are layers: `lib`, `i18n` and `ui` at the bottom; the feature folders (`tasks`, `detail`, `decisions`, `docs`, `insights`, `settings`, `admin`, `auth`) above them; `shell`, `pages` and `palette` on top.

### Files and layers
1. One topic per file, and the file's name is the topic. No `bits`, `parts`, `more`, `helpers` or `utils`. A file is split when it holds more than one topic, never because it is long.
2. Every file opens with a comment saying what it is for.
3. `lib`, `i18n` and `ui` import no feature folder; features do not import `shell`, `pages` or `palette`. Lint enforces it.
4. Imports go through `@/`. No relative imports, no barrel files. Default exports only for lazy routes.

### Data and views
5. A view file (`.tsx`) calls neither `api.*` nor `mutate` with an inline payload. Reads live in the folder's `data.ts`, writes in `actions.ts`.
6. Every write is a named change through `mutate` or `send`. Nothing else writes the store.
7. Data that is not in the store is read with `useLoad` or `useLive`, never in a component's own effect.
8. An effect synchronises with something outside React, has a complete dependency array and cleans up. State derived from props is computed in render or reset with `key`.
9. No `Date.now()` or `Math.random()` in render. Use `useNow`, `useMinute` or an event handler.

### Shape
10. A component does one thing a reader can name. There are no limits on its length, its props or its state. Extract a hook or a child when that part has a name of its own; when several pieces of state always change together (the fields of one form), hold them as one state object.
11. The same goes for plain functions: split by meaning, never by length.
12. A form uses `useSubmit` and `useFieldErrors`. No hand-rolled busy flag.

### Types
13. No `any`, no `!`, no `@ts-ignore`. `as unknown as` only at a third-party boundary, with the reason on the line.
14. Wire types are declared once in `lib/types*.ts`, named after the Go type they mirror. A response shape used twice has a name.
15. Promises are awaited, returned, or marked `void` with the reason it is safe to drop on the line above. `navigate()` is the exception that needs no reason: its type says promise, but under `BrowserRouter` it returns nothing. Event handlers contain no comma operator.

### Words, dates, controls
16. Every word shown goes through `t()`. Strings live in `i18n/en/`.
17. Dates are `YYYY-MM-DD` strings handled only by `lib/days.ts`; times are milliseconds formatted only by `lib/time.ts`.
18. Clickable things are `<button>` or `<a>`, or `ui/` components. An icon-only button has a label. Dialogs use `ui/dialog`.

### Names and state
19. Names are words. One letter is allowed for the parameter of a one-expression callback, plus `e` (event), `t` (translate), `s` (store state) and `i`.
20. Module state outside a store is a constant, or carries a comment saying who writes it.

### Tests and the gate
21. A test file sits beside the file it checks (`store.test.ts`) and is named after the behaviour. A fix comes with a test that fails without it.
22. `pnpm check` is clean. A disable comment names the rule and the reason.

### Lint warnings still to fix

These rules are warnings in `web/.oxlintrc.json` because the code breaks them today; `pnpm lint` passes with them. Fix one rule's findings, make the rule an `"error"`, and take its line off this list. Counts as of the commit that made the layering rule an error.

| Rule | Findings |
| --- | ---: |
| `jsx-a11y/prefer-tag-over-role` | 67 |
| `react/refs` | 21 |
| `react-hooks/exhaustive-deps` | 21 |
| `react/set-state-in-effect` | 15 |
| `jsx-a11y/click-events-have-key-events` | 11 |
| `jsx-a11y/no-static-element-interactions` | 9 |
| `jsx-a11y/no-noninteractive-element-interactions` | 8 |
| `jsx-a11y/no-noninteractive-tabindex` | 6 |
| `react/immutability` | 3 |
| `jsx-a11y/no-noninteractive-element-to-interactive-role` | 3 |
| `jsx-a11y/interactive-supports-focus` | 3 |
| `react/purity` | 3 |
| `react/preserve-manual-memoization` | 2 |
| `react/no-did-update-set-state` | 2 |
| `react/incompatible-library` | 1 |
