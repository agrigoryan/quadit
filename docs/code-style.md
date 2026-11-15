# Code style

What "readable" means in this repository, as rules a reviewer can check. `make lint` checks the ones a tool can; the rest are for the person (or agent) writing and the one reviewing. `internal/importer` is the model to copy: an interface with an explicit list of implementations, one run of work as a struct with small named methods, and a package comment that says how the package is laid out.

## Go

### Packages and files
1. Every package has one doc comment saying what it is for and how its files are laid out.
2. Every file other than the package's doc file opens with one line saying what is in it. One topic per file; the file's name is the topic.
3. Packages below `server` never import it. `server` holds routing, the request context, sign-in and thin handlers; a feature with logic of its own is a package.

### Functions
4. A function stays under 80 lines, cyclomatic complexity 20 and nesting depth 4. Longer work becomes a struct for one run with small named methods, run as a list of steps.
5. At most 6 parameters, and no two bools side by side; beyond that, pass a struct.
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
