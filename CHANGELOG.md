# Changelog

What changed in each release of Quadit, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Quadit follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Each [GitHub release](https://github.com/agrigoryan/quadit/releases) also lists its commits.

## [Unreleased]

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

[Unreleased]: https://github.com/agrigoryan/quadit/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/agrigoryan/quadit/releases/tag/v0.2.0
[0.1.0]: https://github.com/agrigoryan/quadit/releases/tag/v0.1.0
