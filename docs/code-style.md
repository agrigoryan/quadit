# Code style

How code in this repository is designed and written. The first part is the thinking, taken from John Ousterhout's *A Philosophy of Software Design*, which is the reference for every judgement call here; read the book for the argument behind each point. The second and third parts are this repository's own conventions for Go and for the web app. Where a convention and a principle disagree, the principle wins and the convention gets fixed.

There are no numeric limits in this document: no maximum length for a function, a file or a component, no maximum nesting, no maximum number of parameters. Size is never the reason to split something.

## Principles

**Complexity is the thing we fight.** Complexity is whatever makes the system hard to understand or to change. It shows up three ways: one change needs edits in many places; a reader must hold a lot in their head to do anything; and, worst, it is not clear what must be known or changed at all. It has two causes, dependencies and obscurity, and it grows in small steps, each of which looked harmless. So every change is judged by whether it leaves the whole simpler, not by whether it works.

**Working code is not enough.** The fastest way to finish the task at hand usually adds a little complexity. Take the time to find the design that keeps the system simple, and when touching existing code leave its design better than it was; do not patch around it.

**Modules should be deep.** A module (a package, a type, a function) is worth what it hides behind its interface. The best give a lot of behaviour through a small, simple interface. A shallow one, whose interface is nearly as complicated as what it does, costs its callers more to learn than it saves them. Many small functions or types that each do little are not simpler than one that does the whole job: the complexity has moved into how they fit together.

**Hide information.** Each design decision (a file format, a protocol, how rows are stored, a retry rule) should be known in one place. If changing it means touching several modules, it has leaked. A common cause is shaping code by the order things happen in (read, then process, then write) instead of by what each part needs to know: steps that share knowledge belong together.

**Make interfaces somewhat general.** Shape an interface around what the module is, not around the one caller that exists today. The general form is usually simpler and deeper. Keep the special cases above it or below it, not mixed in.

**Each layer is a different abstraction.** A function that only passes its arguments to another with the same shape adds an interface and no value. So does a value threaded through many layers that do not use it. If two adjacent layers say the same thing, one of them should not be there.

**Pull complexity downward.** When something is hard, the module should take the difficulty on so that its callers do not have to. A simple interface matters more than a simple implementation. A configuration knob or a flag pushed up to the caller is a decision the module declined to make.

**Together or apart is decided by meaning.** Put things together when they share knowledge, when one cannot be understood without the other, or when joining them makes the interface simpler. Split them when they are truly separate concerns. For functions in particular: each should do one thing and do it completely, and a long function is fine when it reads as one story with a simple signature. Splitting one creates new interfaces to learn; if the pieces can only be understood by reading them together, they were one function.

**Define errors out of existence.** Every error a caller has to handle is complexity. First try to design the operation so the situation is not an error (asking to delete what is already gone is a success). Then try to handle it inside, where the knowledge is. Then gather what must be handled in one place high up, so that most code does not deal with it at all. The exception is anything that decides access: there, when in doubt, the answer is no.

**Design it twice.** For anything that matters (a package boundary, an interface many callers will use) sketch at least two different designs and compare them before building one. The first idea is rarely the best.

**Comments say what the code cannot.** Code shows how; a comment gives what a reader cannot get from the code: what a thing is for and what it promises (so callers need not read its body), and why something is done the way it is. A comment that repeats the code or the name next to it is noise. Write the interface comment before the body: if it is hard to describe simply, the design is not right yet.

**Names are precise, and consistent.** A name should give a reader a clear picture of the thing without reading further, and the same word should mean the same thing everywhere. A name that is hard to choose usually marks a thing that is not one thing.

**Be consistent and obvious.** Do similar things the same way throughout, and follow the conventions already here even where another would be as good. Code is obvious when a reader's first guess about what it does is right; anything surprising needs either a redesign or a comment.

### Red flags

Signs, when reading or reviewing, that a design needs another look:

- **Shallow module:** its interface is not much simpler than its body.
- **Information leakage:** the same decision shows up in more than one module.
- **Temporal decomposition:** the structure follows the order of execution, not the knowledge each part holds.
- **Pass-through:** a function that only forwards, or a value handed down through layers that ignore it.
- **Repetition:** the same piece of non-trivial code in more than one place.
- **Special-general mixture:** a general mechanism that contains code for one particular use of it.
- **Conjoined functions:** one cannot be understood without reading the other.
- **Overexposure:** using the common case requires knowing about the rare ones.
- **Comment repeats code**, or a name so vague that a comment has to rescue it.
- **Hard to name or hard to describe:** usually the thing is doing more than one job, or half of one.
- **Non-obvious code:** its behaviour cannot be understood by a quick read.

## Go conventions

`make lint` checks what a tool can; the rest is for whoever writes and whoever reviews.

### Packages and files
1. Every package has one doc comment saying what it is for, what it hides from the rest of the program, and how its files are laid out.
2. One topic per file; the file's name is the topic. A file is split when it holds more than one topic, never because it is long. A file opens with a comment when its name does not say enough.
3. Packages below `server` never import it. `server` holds routing, the request context, sign-in, the reads (the viewer) and what shares the viewer's knowledge (the dashboard, export, the dispatcher). A part that hides one thing behind a small interface is a package of its own (`reposync`, `github`, `mcp`, `picture`, `webpush`, `settings`); a package is never made for size, nor by cutting through knowledge two sides share.

### Functions
4. A function does one thing and does it completely. A long function that reads top to bottom as one story, with a blank line and a short comment between its parts, is good code. Take a part out only when it is a thing of its own: it has a clear name, a simple interface, and can be understood without reading its caller. A group of functions or methods that hand state to each other through parameters or struct fields, and that only make sense read together, is one function in disguise: write it as one.
5. A call should read as what it says. When arguments are hard to tell apart at the call site (several of the same type in a row, or bare `true, false`), give them names: a struct with named fields, or separate functions. Do not make a struct only to carry a list of arguments around.
6. An exported name has a comment that tells a caller what they need and cannot see from the signature: what it promises, what it changes, what the units and the edge cases are. A comment that only restates the name is worse than none: leave it out or say something. A comment sits on the declaration it describes: moving code moves its comment.
7. Inside a function, comment the why and the non-obvious, in plain words. Comments do not restate the code, and they do not tell the history of a change.

### Wiring and state
8. No `init()` for registration: a feature is named in an explicit list in one visible place (routes in `allRoutes`, background loops and job kinds in `run.go`, commands, tables, import sources). The one exception is change types: each `internal/engine/ch_*.go` registers its own changes from `init()`, beside their code, and `TestCatalog` checks the catalogue whole; lint allows `init()` there and nowhere else.
9. No package-level mutable state except lookup tables. A hook is a field set by the constructor.
10. Every goroutine has an owner that can wait for it. `ctx` is the first parameter and is not stored in a struct, except in a struct that is one run of work and says so. `context.Background()` appears only in `main`, in tests, and in detached work that says why it is detached.

### Errors

The aim is few places that deal with errors (see "Define errors out of existence"): operations defined so the common odd case is not an error, failures handled where the knowledge is, and the rest gathered at one place per entry point (the HTTP error path, a job's retry). Within that:

11. An error is returned, logged with `slog`, or discarded with `_ =` and the reason on the same line. Nothing else.
12. Ask whether a row is there with `store.Find`: false for a row that is missing, an error only when the read failed. Use `Get` when the row must be there and return its error as it is; it names the row ("task not found") and is answered 404. Never test a `Get` error for absence by hand: a database outage is never answered as "not found".
13. A count, a limit or a setting that decides access fails closed: when it cannot be read, the answer is no.
14. Errors are matched with `errors.Is` or `errors.As`, never by their text. Wrapping uses `%w`.

### Handlers, reads and writes
15. An HTTP handler is `func(x *c) error` named `handle<Verb><Object>`. Its job is the HTTP side: read the request, call what does the work, write the answer. The work itself lives where it can be used without a request: a read is a method of the viewer, a write is a change.
16. Every write is a change, handled in `internal/engine`. Every read of a workspace's data is a method of `viewer` (who is asking, in which workspace, limited to which projects) and takes a `ctx` first; work outside a request gets its viewer from `viewerFor`. What a viewer may see is asked of it (`canProject`, `canSeeDoc`, `canSeeView`, `canSeeFile`, `readable`, `feed`, `search`), never worked out from project ids where the read is made. A kind of row given as stored is one line in `rowKinds`, with its rule. Neither side builds an `http.Request` to reach the other.

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

## Web app conventions

The web app follows common React and TypeScript practice first: the official React guidance (the Rules of React, "You Might Not Need an Effect"), an established library before a hand-written equivalent, generated types from the server before hand-kept copies, semantic HTML, and Testing Library's way of testing what a person sees. The principles above are the lens for how deep a module is and what it is called; where the two pull apart here, common practice wins.

`pnpm check` checks the rules a tool can (types, lint, format, tests). The folders under `web/src` are layers, bottom up: `types` (the wire types, the generated `changes.gen.ts` and `rows.gen.ts` among them) and `i18n` (the words); `lib` (small modules that know neither the server's data, the router nor any screen); `data` (the workspace copy and what keeps it current, the HTTP client, the reads the copy does not hold) and `hooks` (general React hooks); `nav` (what the app keeps in the browser's history, through the router); `ui` (shared components); the feature folders (`tasks`, `detail`, `decisions`, `docs`, `insights`, `settings`, `admin`, `auth`); `shell`, `pages` and `palette` on top. Each folder's first file says what the folder holds.

### Files and layers
1. One topic per file, and the file's name is the topic. No `bits`, `parts`, `more`, `helpers` or `utils`. A file is split when it holds more than one topic, never because it is long.
2. A file opens with a comment saying what it is for when its name and its exports do not already say it.
3. A layer imports only the layers below it and its own files: `types` and `i18n` import nothing else; `lib` only those two; `data` and `hooks` nothing above `lib`, and not each other; `nav` nothing above them; `ui` no feature folder; features do not import `shell`, `pages` or `palette`. Lint enforces it.
4. Imports go through `@/`. No relative imports, no barrel files. Default exports only for lazy routes.

### Data and views
5. A write that carries knowledge (an optimistic row, several changes that belong together, a mapping from what the view has to what the change takes) lives in the folder's `actions.ts`. A write that is one plain change is called where it happens: a wrapper that only passes its arguments on adds nothing. Either way the change's name and arguments are checked against `types/changes.gen.ts`, generated from the server (`make generate`); arguments built field by field are declared as `Changes["name"]`, never `Record<string, unknown>`. A read or a response shape used twice has a name in the folder's data module.
6. Everything a person does to the workspace is a named change through `mutate` or `send`. Besides those, only what brings the server's rows in writes the store: the starting copy and the feed (`data/sync.ts`), and a read that hands its rows over (rule 7).
   Components and actions read the store through `data/selectors.ts`, never through `collections`. A list from a selector holds live rows only (not in the trash, not archived, not a removed member); a gone row is reached only through a selector whose name says so (`useTrashed`, `useArchived`, `…EvenIfGone`). The arrays and lookups a selector returns are shared and frozen: copy before sorting. Whether the signed-in member may do something is asked of `data/access.ts` (`useCan()`, or `can(getState().me)` outside a component), never of `me.role` or `me.scope`; a control the answer forbids is disabled or hidden the way a trashed task's controls are.
7. Data that is not in the store is read with TanStack Query through the one client in `data/query.ts` (or `useLive` when the feed should refresh it), never in a component's own effect. A workspace read's key starts with `inWorkspace(slug)` and is named in the folder's data module. A read that brings rows the store keeps hands them to the store inside its `queryFn` and caches only what the store does not hold. A plain REST write is a `useMutation` that invalidates, or sets from its answer, the key it changed. A failed read shows `LoadGate`/`LoadFailed`; only a 404 reads as not found.
8. An effect synchronises with something outside React, has a complete dependency array and cleans up. State derived from props is computed in render or reset with `key`.
9. No `Date.now()` or `Math.random()` in render. Use `useNow`, `useMinute` or an event handler.

### Shape
10. A component does one thing and does it completely. Take a hook or a child out when it is a thing of its own: a clear name, a small interface, understandable without reading the component it came from. A hook with one user that hands back a dozen values is the component's own state moved to another file: keep it in the component. State that always changes together (the fields of one form) can be one object.
11. The same goes for plain functions: together or apart by meaning, never by length.
    A task property (status, assignee, due date…) is described once, in its own file under `tasks/properties/`, and listed in `tasks/properties/index.ts`; the pickers, the property panel, the bulk bar, the create dialog, the palette, the filters, the groupings and the timeline read that table and never name a kind themselves.
12. A form in a dialog that follows the usual pattern (clear errors, mark busy, send, show a refusal, close) uses `ui/form-dialog`; a check made in the browser throws `refuse(field, message)` so it shows the way a server refusal does. Other forms that follow the pattern use `useSubmit` and `useFieldErrors`. A form whose submit does something different writes it out plainly; do not bend it to fit the hook, and do not give the hook an option for one caller.

### Types
13. No `any`, no `!`, no `@ts-ignore`. `as unknown as` only at a third-party boundary, with the reason on the line.
14. Wire types are declared once in `types/*.ts`, named after the Go type they mirror. A response shape used twice has a name. Each row type is held to the server's by `types/rows.check.ts` against the generated `types/rows.gen.ts` (`make generate`); a difference made on purpose is listed there with its reason, and the app never imports `rows.gen.ts`.
15. Promises are awaited, returned, or marked `void` with the reason it is safe to drop on the line above. `navigate()` is the exception that needs no reason: its type says promise, but under `BrowserRouter` it returns nothing. Event handlers contain no comma operator.

### Words, dates, controls
16. Every word shown goes through `t()`. Strings live in `i18n/en/`.
17. Dates are `YYYY-MM-DD` strings handled only by `lib/days.ts`; times are milliseconds formatted only by `lib/time.ts`.
18. Clickable things are `<button>` or `<a>`, or `ui/` components. An icon-only button has a label. Modal forms use `ui/form-dialog` (built on `ui/dialog`); a side sheet, a lightbox, a drawer or a command bar is a different thing and is built on the primitive directly.

### Names and state
19. Names are words. One letter is allowed for the parameter of a one-expression callback, plus `e` (event), `t` (translate), `s` (store state) and `i`.
20. Module state outside a store is a constant, or carries a comment saying who writes it.

### Tests and the gate
21. A test file sits beside the file it checks (`store.test.ts`) and is named after the behaviour. A fix comes with a test that fails without it.
22. `pnpm check` is clean. A disable comment names the rule and the reason.
23. An end-to-end test lives in `web/e2e` (Playwright, run with `make e2e`, not part of `pnpm check`): it finds things by role and accessible name, seeds and checks through the CLI or the API, and waits with web-first assertions, never a fixed sleep.

### Lint warnings still to fix

These rules are warnings in `web/.oxlintrc.json` because the code breaks them today; `pnpm lint` passes with them. Fix one rule's findings, make the rule an `"error"`, and take its line off this list. Counts as of the commit that made the layering rule an error.

| Rule | Findings |
| --- | ---: |
| none: every rule that was a warning is an error now | 0 |
