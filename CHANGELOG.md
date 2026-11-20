# Changelog

What changed in each release of Quadit, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Quadit follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Each [GitHub release](https://github.com/agrigoryan/quadit/releases) also lists its commits.

## [Unreleased]

### Added

- The desktop app can run Quadit on the computer it is on (macOS and Linux): "Run Quadit on this computer" starts the server the app carries, on `127.0.0.1` with its data in the app's data folder, while the app runs, so downloading the app is a whole install. `quadit serve --stop-on-stdin-close` shuts the server down when the program that started it is gone.

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

[Unreleased]: https://github.com/agrigoryan/quadit/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/agrigoryan/quadit/releases/tag/v0.1.0
