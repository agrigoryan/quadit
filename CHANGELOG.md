# Changelog

What changed in each release of Quadit, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Quadit follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Each [GitHub release](https://github.com/agrigoryan/quadit/releases) also lists its commits.

## [Unreleased]

### Added

- A text file among a task's, a comment's or a question's files opens in the viewer instead of downloading, one after another with the pictures and videos: Markdown rendered by the renderer comments use (raw HTML in it shown as text, javascript: links emptied), with Rendered and Source, and as its source when it is over 100,000 characters; logs, JSON, CSV, YAML, XML, source code and anything served as text as written, wrapped; an HTML or SVG file as its source, never drawn. Up to the first 1 MB is shown, and the viewer says when it cut the rest; text is read as UTF-8, or as UTF-16 when it starts with its byte-order mark; a file whose bytes are not text says it cannot be shown. The viewer names the file and always has Download, pictures and videos included.
### Changed

- Listening no longer blocks a chat with a person where the tool can be woken by a background command (Claude Code, Antigravity CLI): the skill has the agent run `quadit wait for=3600` in the background and go on talking. Where the tool cannot be woken (Codex today), the agent says first that listening keeps the chat busy; a run with nobody in it waits in the foreground as before. Before it listens, an agent whose `quadit` commands each ask for approval says so, and how to allow them.
- `quadit wait for=` goes up to 3600 seconds, renewing the server's holds and the lease inside itself.
- From a chat whose tool cannot be woken, the agent first asks whether something already listens as it, and if nothing does, offers the person two choices: keep the chat busy, or a companion run in a terminal, given as the exact command. It never searches the quadit binary for how to listen: `quadit help listen` says all of it.

### Added

- `quadit listening` (`GET /listening`) says whether something listens as you, what and since when, without taking the lease. A listener says what it is when it takes the lease ("a chat", "a companion", or what `quadit listen by=` says), and a session refused because another listens is told what does.
- `quadit help listen`: waiting in a chat, in the background, and with a companion.
- Members of a workspace are told apart by colour: a member's tint is chosen when it joins, as the one its workspace's members use least, and kept, so the first eight members all differ; members there already get theirs in the order they joined. The eight tints are set apart in hue, each with white letters at a contrast of at least 4.6 to 1 (the lowest was 3.6).

### Changed

- A listener's lease lives ninety seconds past its holder's last request, however it ended, instead of five minutes, thirty seconds or none by how the wait ended; an acknowledgment is refused only when another session took the lease over, so one made after a long item still counts (the reason `lease_ended` is gone).
- A listener's cursor never moved starts at the present; the first answer no longer counts older unread items (`skipped`). The skill has the agent deal with what `quadit work` shows before its first wait.
- `quadit listen --exec` gives its command, beside the item's line (`QUADIT_EVENT`, unchanged), what `quadit wait` prints for it in `QUADIT_ITEM`: the item's line (saying when another agent wrote it), how to read it, and the line that answers it once. It renews its lease every minute while the command runs, so a long run keeps the item. The skill says what a member asks on the agent's task is work to do, what the agent reads while working is material and not requests, the three things it never does because a text says to, and what a woken agent does with one item.
- `quadit listen` takes `limit=SECONDS` (a longer run is ended, with what it started), `tries=N` (an item whose runs keep failing is given up, and stays unread in the inbox) and `events=PATH` (what it does, one JSON line each, on a channel the command's output cannot reach); without them it runs as before.
- `quadit connect`, and a wait or a listen refused because something else listens, say so in the command's own words, with what the server sent only in the forms a handle, a label and a time have.
- The skill says what an agent does when a listener outside any chat (a companion, or the Quadit app) wakes it for one item: handle that item, answer where it was asked, and finish, without listening or acknowledging. `docs/agents.md` and the README say that for the server on its computer the desktop app gives the connect code back itself and, while open, answers by itself, one run of the tool per item, with Pause on the tool's card.
- `scripts/agent-listen-check.sh` gains a companion phase, run as the desktop app runs its listener, and records each run's length and tokens: the cost of one answered comment.
- Listening no longer blocks a chat with a person where the tool can be woken by a background command (Claude Code, Antigravity CLI): the skill has the agent run `quadit wait for=3600` in the background and go on talking. Where the tool cannot be woken (Codex today), the agent says first that listening keeps the chat busy; a run with nobody in it waits in the foreground as before. Before it listens, an agent whose `quadit` commands each ask for approval says so, and how to allow them.
- `quadit wait for=` goes up to 3600 seconds, renewing the server's holds and the lease inside itself.
- From a chat whose tool cannot be woken, the agent first asks whether something already listens as it, and if nothing does, offers the person two choices: keep the chat busy, or a companion run in a terminal, given as the exact command. It never searches the quadit binary for how to listen: `quadit help listen` says all of it.

## [0.4.0] - 2026-11-21

### Added

- An agent is shown in one of three states, on a task given to it, on the Agents page and in Settings → Agents: not connected yet, connected but not listening, or listening. It is connected once it proves it reached Quadit from inside its tool: a connect code given back, a change made with its own token, or its first wait as a listener; an agent that made a change before this version counts as connected. The member row and `GET /agents` carry `connected_at`.
- Connect codes: a person makes one for an agent and its tool (Settings → the agent → Connect code, the desktop app's Connect, or `POST /connect-codes`), says `Connect to Quadit K7PQ2M` in the tool, and the agent gives it back with `quadit connect K7PQ2M` (`POST /connect`). Six characters, good once for seven days, ten tries a minute.
- `quadit wait [for=SECONDS] [lease=ID] [take=1]` (`GET /listen`): an agent told "listen to Quadit" in its tool waits for its next inbox item and is handed it with the exact commands to read it, acknowledge it and wait again, or IDLE. One session at a time listens: the first wait takes a lease on the cursor `listen`, which lives five minutes past the last wait, and another session is refused until the person has it take over with `take=1`. The skill says when to connect and when to listen, how to keep going round and when to stop.
- Under a task's comment box, when the task is an agent's or waits on one, a quiet line says whether the agent will see what is written: it is listening; it will see it when next asked in its tool; or it has not connected yet, with the way to connect it (the desktop app's Connect, or its page in Settings).
- `scripts/agent-listen-check.sh TOOL` checks, by hand and on a throwaway server, that a tool given the skill under test connects and listens from ordinary words; `docs/agents.md` lists which tools were checked.
- With the desktop app quit, an agent's `quadit` with a login the app made for its own server (`quadit login URL - --app PATH`) starts the app without a window, waits up to 20 seconds for the server, and sends its request again; a server the person stopped from the app's menu stays stopped, and the command says so.
- `GET /agents/connection` is the cheap read of how far each agent is connected, with the tool of the last connect code it gave back; the pages read it again while they show it.

### Changed

- An agent counts as listening only while its listener holds the lease (`quadit wait`, `quadit listen`) or a webhook pushes to it, or while a `quadit listen` from before this version holds its wait on the cursor `listen`; another wait on the feed or a live stream no longer marks it. The pages read whether it listens again while they show it, so it does not go stale.
- `quadit listen` holds the same lease (and keeps it beside its login, so a restart goes on with it; `take=1` takes it over), acknowledges with it, stops when another session takes the lease over, and prints the command that gives up on an item it could not handle (`quadit ack SEQ listen lease=ID`). An acknowledgment without a lease is made as before.
- A listener's cursor never moved before starts at the oldest unread inbox item of the last day, else at the present, instead of replaying the whole inbox; the first answer says how many older unread items were left alone. A wait with nothing for the agent no longer moves the cursor.
- A person's comment on a task reaches its assignee and whoever it waits on, whether or not they follow the task; an agent's reaches whom it did before.
- `quadit wait` gives, for an item, the line that answers it where it was asked, with a change id made from the item, so an answer sent twice is made once; an item from an agent says so.
- One `quadit listen` per login: a second one on the same login is refused.
- An inbox item's words are cut at 200 characters, not 200 bytes.

### Fixed

- Inside Codex's sandbox, which has no network unless the person lets it out, `quadit` now says why it cannot reach the server (this computer's own address included) and that the command must be run outside the sandbox, so Codex asks for that permission instead of giving up; the skill says the same.
- A task opened on a page whose connection had died without a word (a phone that slept, a tunnel that came back without it) no longer shows a spinner under Activity for ever: a read the server does not begin to answer in 20 seconds counts as not reached and is tried again, the live stream is given 15 seconds to open, and while the server cannot be reached the task says that it waits for a connection.

## [0.3.0] - 2026-11-21

### Added

- Antigravity CLI (`agy`) is one of the agent tools Quadit connects: the desktop app's Connect finds it and writes the skill and the MCP server where it reads them (`~/.gemini/config`), and `quadit skill install` writes the skill there on a computer that has it.
- On macOS the desktop app's server windows have no title bar: the page fills the window to its top edge, the window's buttons sit over its top left corner, and the window is dragged by the sidebar's top and the top bar. A server says its pages are laid out for this in `GET /api/v1/version` (`desktop.inset`); a server that does not say so keeps a window with a title bar.
- A new install starts with a "Getting started" project of three sample tasks to try Quadit with, whether the web form, the desktop app or `quadit admin setup` sets it up; a note above them says what they are for, and one click sends them to the trash (their project goes with them only when nothing of yours is in it). An empty workspace's "Create your first project" offers "Try it with sample tasks". The API has `POST` and `DELETE /api/v1/w/{workspace}/samples`, and the changes `samples.add` and `samples.remove`, for people who are owners or admins.

### Changed

- The desktop app's first run happens in one window, the one the workspace opens in, instead of small windows of its own: Welcome, then "Connect your AI tools", which looks for the tools on the computer and shows each as a card that connects with one button, says in plain words which files it changes, and takes it back with Undo; Continue opens the workspace on its sample tasks. The Connect window shows the tools with the same cards, its technical choices under More options.

### Fixed

- In the desktop app, Help → Quadit Website opens the website, not the source code.
- The dashboard no longer counts the statuses of a project in the trash.
- Setting an install up writes the owner's password in the same transaction as the owner, and two set-ups at once can no longer both succeed.

## [0.2.0] - 2026-11-20

### Added

- The desktop app can run Quadit on the computer it is on (macOS and Linux): "Set up on this computer" starts the server the app carries, on `127.0.0.1` with its data in the app's data folder, while the app runs, so downloading the app is a whole install. `quadit serve --stop-on-stdin-close` shuts the server down when the program that started it is gone.
- Setting up on this computer asks only for your name: the desktop app makes the account (no email, no password; both can be added later to sign in from a browser) and signs you in with a key it hands the server (`quadit serve --app-key-stdin`, on this computer's own address only), with daily backups on. A person may now have no email address, as an agent has none.
- The desktop app is signed and notarized on macOS, connects the AI tools it finds with one button at first run, and puts the `quadit` command on the PATH without an administrator. In the app, the Agents page opens its Connect window.
- Pictures and videos of a task's files and of a comment open in a viewer with previous and next: arrows at the sides, the arrow keys, and the position.
- An option of a question shows an open button on its picture, opens alone at full size, and the compare view switches between one at a time and side by side. An option with several pictures shows them in the same carousel, on its card and in the compare view.
- `quadit reply` takes `file=PATH`, as `comment` and `result` do, and the agent skill asks agents to attach what they made and to put each option's picture on the option.

### Changed

- Local builds take their version from the server's own tags.

### Fixed

- An agent's badge stays on its picture in a comment that runs over several lines.
- Page sync runs git without the repository settings of the environment it was started from.

## [0.1.0] - 2026-11-18

The first public release.

### Added

- Tasks: projects, custom statuses, labels, sub-tasks, epics with milestones, cycles, estimates, saved views, a trash, and who each open task is waiting on.
- Docs: a page tree with a collaborative block editor, comments on words, blocks and pages, version history, databases with formulas and rollups, Markdown in and out, and two-way sync with a folder in a git repository.
- Decisions: questions with options, media and a recommendation, answered in one tap; approvals for changes an agent may not make alone.
- Agents as members: roles, project limits, hand-off limits, a person responsible; the `quadit` command-line client, an MCP server at `/mcp` and an HTTP API at `/api/v1`, a change feed with server-kept cursors, held requests, webhooks, `quadit listen` to wake an agent, and a secrets vault; `quadit skill install` for Claude Code, Codex, Cursor, Gemini CLI, GitHub Copilot, opencode and pi.
- Running it: one binary with the web app inside; SQLite or Postgres; files on disk, S3-compatible storage, Google Cloud Storage or Azure; password, passkey, two-step, Google, GitHub and OpenID Connect sign-in; scheduled, verified backups, copied to a folder, file storage or a bucket of their own, and restores; upgrades that copy the database first and can be undone; imports from Linear, Asana, Trello, Notion, Obsidian, Markdown and GitHub.
- A desktop app for macOS, Windows and Linux (pre-release, not signed yet): a window for each server, sign-in through the browser, answers from a notification or the menu bar, quick capture, and Connect, which sets up Claude Code, Codex and other agent harnesses to work in Quadit.
- Install with the install script, Homebrew, Docker (`ghcr.io/agrigoryan/quadit`), `.deb` and `.rpm` packages with a systemd service, or the archives on GitHub Releases.

[Unreleased]: https://github.com/agrigoryan/quadit/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/agrigoryan/quadit/releases/tag/v0.4.0
[0.3.0]: https://github.com/agrigoryan/quadit/releases/tag/v0.3.0
[0.2.0]: https://github.com/agrigoryan/quadit/releases/tag/v0.2.0
[0.1.0]: https://github.com/agrigoryan/quadit/releases/tag/v0.1.0
