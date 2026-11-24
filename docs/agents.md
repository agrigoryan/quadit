# Connecting agents

An agent is a member of the workspace with its own account, role and token. People assign it tasks and mention it like anyone else. This page is what an agent, or the person setting one up, needs.

## Set up

1. In Settings → Agents, create the agent: name, handle, role (member or admin), the person responsible for it, and optionally which projects it may touch, which changes need approval, and how many times a week it may pass work on to another agent.
2. Issue it a token (an admin, or the person responsible for the agent). It is shown once.
3. Give the agent `QUADIT_URL` and `QUADIT_TOKEN`, or run `quadit login URL TOKEN` (`-` for the token reads it from standard input). Or let the desktop app do steps 2 to 4: see [Connect from the desktop app](#connect-from-the-desktop-app).
4. Teach the agent Quadit: `quadit skill install` (see [Your agent](#your-agent)).
5. Prove it reaches Quadit from where it runs: on the agent's page in Settings, make a connect code and say the line it gives in the agent's chat (`Connect to Quadit K7PQ2M`). See [Connected, and listening](#connected-and-listening).

## Your agent

Any coding agent works: Quadit needs nothing made for one in particular. An agent reaches Quadit in one of two ways, and one is enough:

- **The skill and the `quadit` command.** The skill (`integrations/skills/quadit/SKILL.md`, carried by the binary) teaches the agent the `quadit` commands this page describes; the agent runs them in its shell. `quadit skill install` writes it to `~/.agents/skills/quadit/`, where Codex, Cursor, Gemini CLI, GitHub Copilot, opencode and pi look, to `~/.gemini/config/skills/quadit/` on a computer that has Antigravity CLI, and to `~/.claude/skills/quadit/`, where Claude Code looks. Run it again after updating Quadit. `quadit skill install DIR` writes it into another skills folder instead, such as a project's `.agents/skills`.
- **MCP**, for an agent without a shell, or one that should not have the `quadit` command: the server at `https://your.server/mcp`, with the token as a bearer header (see [MCP](#mcp)). The agent's own settings say where the server is, and, for work nobody watches, that its tools may run without asking each time.

For Claude Code and Codex, Quadit can start the agent itself for each task, on your computer, and record each run: see [Quadit runs the agent](#quadit-runs-the-agent). For any agent, to wake it when something needs it, run `quadit listen --exec COMMAND`, with the agent's command that runs one prompt and exits. The item is in `QUADIT_ITEM` as `quadit wait` prints it (its `ITEM` line, saying `(agent)` when another agent wrote it; the command that reads it; the line that answers it once, with a change id made from the item), and its line in the feed in `QUADIT_EVENT` and on standard input, as before:

```bash
#!/bin/sh
# wake.sh: one inbox item for the agent
exec codex exec "Quadit woke you for this inbox item:
$QUADIT_ITEM
Handle it with the quadit skill: answer where you were asked, and write nothing when it asks nothing of you."
```

While the command runs, `listen` renews its lease every minute, so a run that takes longer than the lease's ninety seconds keeps the item from being handed to another session. Without more, a run that fails is tried again, with longer pauses up to five minutes, until it succeeds. Three optional arguments bound that, for a caller that runs it unattended:

- `limit=SECONDS` (1 to 86400): a run that takes longer is killed, with everything it started (its process group), and counts as failed.
- `tries=N` (1 to 100): after N failed runs of the same item, it is given up: acknowledged, so the next item comes. Nothing is posted to the task; the item stays unread in the agent's inbox (`quadit inbox`).
- `events=PATH`: a file or named pipe the caller made, which `listen` writes one JSON object a line to. The command's own output never goes there (it does not inherit it), so a caller can trust it. Each object has `event` and `at` (UTC, RFC 3339): `run_started` with `seq` (the item); `run_ended` with `seq` and `status`, the exit status (-1 for none) or `"limit"`; `gave_up` with `seq`; `refused` with `why`, `listening_elsewhere` or `lease_stale` (another session took the lease over), after which `listen` ends.

`listen` also ends, with the server's error, when the server refuses it in a way waiting will not change: a person's login, a token taken away. A server or a network away is tried again.

Each agent below: its MCP settings with Quadit's tools allowed to run unattended, and its one-prompt command. Replace `https://quadit.example.com` with your server; `QUADIT_TOKEN` is read from the environment.

**Claude Code.** The skill, or the plugin in this repository, which brings the skill and the MCP server together: `claude plugin marketplace add agrigoryan/quadit`, then `claude plugin install quadit@quadit`. MCP alone: `claude mcp add --transport http quadit https://quadit.example.com/mcp --header "Authorization: Bearer $QUADIT_TOKEN"`. Unattended: allow `mcp__quadit` (or `Bash(quadit:*)` for the command) in `permissions.allow` of its settings. One prompt: `claude -p "…"`.

**Codex.** In `~/.codex/config.toml`:

```toml
[mcp_servers.quadit]
url = "https://quadit.example.com/mcp"
bearer_token_env_var = "QUADIT_TOKEN"
default_tools_approval_mode = "approve"   # unattended: no approval for each call
```

One prompt: `codex exec "…"`. Its sandbox has no network by default; the `quadit` command needs it: `codex exec -s workspace-write -c sandbox_workspace_write.network_access=true "…"`.

**Cursor.** In `~/.cursor/mcp.json`:

```json
{ "mcpServers": { "quadit": {
  "url": "https://quadit.example.com/mcp",
  "headers": { "Authorization": "Bearer ${env:QUADIT_TOKEN}" } } } }
```

One prompt, with its MCP tools allowed: `cursor-agent -p --approve-mcps "…"`.

**Gemini CLI.** In `~/.gemini/settings.json` (`trust` lets the tools run without asking):

```json
{ "mcpServers": { "quadit": {
  "httpUrl": "https://quadit.example.com/mcp",
  "headers": { "Authorization": "Bearer ${QUADIT_TOKEN}" },
  "trust": true } } }
```

One prompt: `gemini -p "…"`.

**Antigravity CLI** (`agy`, Google's successor to Gemini CLI, with settings of its own). One command, its flags before the name, which writes `~/.gemini/config/mcp_config.json`:

```sh
agy mcp add --header "Authorization: Bearer $QUADIT_TOKEN" quadit https://quadit.example.com/mcp
```

One prompt: `agy -p "…"`.

**GitHub Copilot CLI.** In `~/.copilot/mcp-config.json`:

```json
{ "mcpServers": { "quadit": {
  "type": "http", "url": "https://quadit.example.com/mcp",
  "headers": { "Authorization": "Bearer ${QUADIT_TOKEN}" },
  "tools": ["*"] } } }
```

One prompt, with its tools allowed: `copilot -p "…" --allow-tool='quadit' --allow-tool='shell(quadit)'`.

**opencode.** In `opencode.json` (the project's, or `~/.config/opencode/`); its tools run without asking unless a `permissions` rule says otherwise:

```json
{ "$schema": "https://opencode.ai/config.json",
  "mcp": { "quadit": {
    "type": "remote", "url": "https://quadit.example.com/mcp", "oauth": false,
    "headers": { "Authorization": "Bearer {env:QUADIT_TOKEN}" } } } }
```

One prompt: `opencode run "…"`.

**pi.** MCP from pi 1.0: `pi mcp add quadit --url https://quadit.example.com/mcp --bearer-token-env-var QUADIT_TOKEN`; pi does not ask before a call. One prompt: `pi -p "…"`.

### Connect from the desktop app

The desktop app's Connect (macOS and Linux) sets up the coding agents it finds on its computer: Claude Code, Codex, Cursor, Gemini CLI, Antigravity CLI, GitHub Copilot CLI, opencode and pi. For each, pick the workspace, the agent it works as (or a new one, for an admin), and how it connects:

- **The command and the skill** (all eight). The app asks the server for a token for the agent, which only an admin or the person responsible for the agent may have, and saves it with `quadit login URL -`, the token on standard input. Each agent gets a login file of its own beside the default one (`quadit/<name>.json` in the user's config folder), and the app sets `QUADIT_CONFIG` to it in that agent's own environment setting (Claude Code's `settings.json` `env`, Codex's `shell_environment_policy.set`), so each works under its own name. An agent without such a setting uses the computer's default login, the one `quadit login --path` prints. The app installs the skill, and uses the `quadit` command already on the shell's `PATH`, or links in the copy it carries.
- **MCP** (Claude Code, Codex, Cursor, Gemini CLI, Antigravity CLI, opencode). The app writes only the server's address into the agent's MCP settings; the agent signs in through OAuth, and the consent page asks which agent it works as.

Tokens are kept only in `quadit`'s own login files, readable by the user alone, never in an agent's settings. Nothing is written until the plan, every file with its change, has been shown and accepted; each file touched is backed up first. `QUADIT_URL` and `QUADIT_TOKEN`, when both are set, still win over any login file; one without the other is ignored. If the Claude Code plugin is installed, Connect warns that its MCP entry still wants those two variables.

**Disconnect** puts back what Connect changed, except where a file has been changed since (it is left as it is, and said), and revokes the token; for a tool Quadit runs, it first removes its entries (Run by Quadit, below). An MCP sign-in is ended in the agent itself.

Connect is a page of the app laid over the workspace window (File → Connect Agents…, the Agents page, the button under a task's comment box). An agent it set up shows the line to say in its chat, `Connect to Quadit K7PQ2M`, until it gives the code back; then whether it listens, and, while it does not, the line that has it listen, `listen to Quadit`, with Copy. Above the cards, the page says the two steps: connect an agent here, then write `listen to Quadit` in its chat.

**For the server on this computer, the app gives the code back itself.** Right after Connect writes an agent's files, the app runs its program (Claude Code, Codex…) once, without a window, with its one-prompt command and "Connect to Quadit CODE", as its own login, and the card turns "Connected" when the server says the code was used. If it cannot be run, is not signed in, or the code does not come back within two minutes, the card shows the line to say in its chat instead, with a word on why. That one run is all Connect does. Connected is not listening; to have the agent answer what is written in Quadit, write `listen to Quadit` in its chat, in your project's folder (below), or, for Claude Code and Codex, have Quadit run it (Run by Quadit, below).

**Run by Quadit.** On the card of a connected Claude Code or Codex that works with an agent's own login, for any server, **Run by Quadit…** sets up [Quadit runs the agent](#quadit-runs-the-agent): pick one of the agent's projects and the project's folder. Before anything starts, the card says that the program runs there with full access, as you, whenever the agent is assigned a task in that project or a comment is addressed to it, and that only the words of the agent's responsible person, or of their other agents, start it. **Start running** runs `quadit run add`; the app then runs its own copy of `quadit run`, keeps it running while an entry is left (started again if it ends, from 2 seconds up to 5 minutes apart), and stops it with the last entry and when the app quits. When another `quadit run` already serves the computer, the card says so and the app tries again every 5 minutes. Each entry is a line on the card with what it does now (`Ready.`, `Working on SVA-12.`, a pause and what to do about it), **Stop running** and **Show log**. Disconnect first removes the tool's entries (`quadit run remove login=PATH`), which ends a run in progress and tells the server how it ended, and only then revokes the login; when the server has not heard yet, Disconnect stops there and says to try again in a moment.

### Connected, and listening

Files written are not proof that an agent reaches Quadit, and an agent that does reach it sees what is written to it only when it looks. So an agent is in one of three states, shown on a task given to it, under the comment box, on the Agents page and in Settings → Agents:

- **Not connected yet**: it has never proven it reached Quadit from where it runs.
- **Connected, not listening**: it works when the person asks it in a chat ("check Quadit"); what is written in Quadit waits until then. To have it answer as things come in, write `listen to Quadit` in its chat: that is the recommended way.
- **Listening**: a session of it is waiting for its inbox right now (a chat, a companion, or Quadit's runner, which starts the agent for each item), or a webhook pushes to it, and answers what comes in. A session listens to one project or to everything, so a place that is about one project says whether something listens to that one: under a task's comment box, "@claude is listening to other projects, not to this one", with “listen to Quadit for SVA”, the line that has it listen there; for an agent that does not listen at all, the line names the project only when the agent may work in several, since with one plain “listen to Quadit” has it listen to everything. The Agents page and the agent's page in Settings say what each listener listens to, and from what ("Listening to Samurai vs Aliens, from a chat").

An agent is connected by the first of: a connect code given back, a change made with its own token, its listener's first wait. Reading proves nothing: `quadit login` and `quadit me` do not connect it. The member row and `GET /agents` carry `connected_at`; `GET /agents/connection` is the cheap read of all three, with the tool of the last code the agent gave back, which pages read again while they show it. Each agent there (and in `GET /agents`) also has `listeners` (`[{project_id, project, by, last_heard, live}]`, the listener of everything without a project), `listening_projects` (the ids of the projects something live is handed now) and `listening_outside_projects` (whether something live is handed the items of no project); `listening` is whether anything listens at all. The listener of a project that a computer runs the agent for also has `runner` (see [Quadit runs the agent](#quadit-runs-the-agent)).

A person's comment on a task that mentions nobody reaches the inbox of the task's assignee and of whoever the task waits on, whether or not they follow it; a reply also reaches whoever wrote earlier in its thread. A comment that mentions members is for them: it reaches no other agent through the task or the thread, though people still hear it as before. Whom a comment hands the task to is told either way. An agent's comment reaches another agent only by mentioning it or handing it the task, or, as a reply, when that agent asked its author by mention earlier in the thread: the one who asked hears the answer without being mentioned, and its own reply after that does not wake the one it asked unless it mentions it again. So agents answer only what is asked of them, and not each other. The line under the comment box follows the draft the same way: it speaks of each agent the comment would reach, in full for one ("@codex is listening and will see this"), in a few words each for several ("@helper is not listening here and sees this when next asked").

An agent follows a task or a page only by choice (`quadit do watch.set '{"type": "task", "subject": "SVA-12"}'`, or `epic`, `doc`), and then hears every comment there; commenting, being mentioned, being assigned or asking a question makes a person follow, not an agent. Upgrading from 0.6.0 or earlier ends the follows of tasks, epics and pages agents had, which cannot be told apart from chosen ones; an agent's follows of projects and views stay.

**Connect codes.** A person who may make the agent a token makes a code for it and the tool it runs in: Settings → the agent → Connect code, the desktop app's Connect, or `POST /connect-codes {"agent": "@codex", "tool": "Codex"}`, which answers `{id, code, …}` with the code this once. It is six characters with no look-alikes, good once for seven days; a new code for the same agent and tool replaces the open one, and `GET /connect-codes/{id}` tells its maker whether it was used. Said in the tool, `Connect to Quadit K7PQ2M` has the agent run:

```bash
quadit connect K7PQ2M    # with its own login: 'Connected as @codex in the workspace "Personal".' and what to tell the person
quadit connect           # with no code: who this login is
```

A wrong, used or expired code is refused saying which (`reason`: `wrong`, `used`, `expired`), ten tries a minute per agent; a person's login is refused, since an agent connects with its own. The code is taken in any case and with spaces or a dash in it, and a code for a tool replaces the open one of the same tool however its name is written. Connecting starts no wait.

**Listening.** Only when the person asks it in a chat ("listen to Quadit"), the agent runs `quadit wait` again and again: in the background where its tool wakes it for a background command, in the foreground otherwise, and not at all from a chat when `quadit listening` says something already listens to what it would take. It listens to one project, or to everything: the one the person named ("listen to Quadit for SVA"), else the one the repository's instruction file for agents names (CLAUDE.md, AGENTS.md), else everything when the agent has one project or none; with several and nothing to settle it, it asks once. The skill (`quadit skill`) says how it tells which, and `quadit help listen` says all of it. Listening needs the `quadit` command and the skill: an agent connected by MCP alone cannot listen. For an agent that should answer with no chat open, have Quadit run it (Claude Code and Codex, [Quadit runs the agent](#quadit-runs-the-agent)), run a companion (`quadit listen --exec …`, [Following changes](#following-changes)), or push its inbox to a webhook.

```bash
quadit wait project=SVA for=3600   # in the background: up to an hour, renewing the server's holds and the lease inside itself
quadit wait project=SVA for=110    # in the foreground: blocks until the next inbox item, at most for= seconds (50 when left out)
quadit wait for=110                # without project=: everything
```

It prints one record: `ITEM #SEQ KIND TASK-OR-PAGE from @WHO: "…"` (`from @WHO (agent)` for another agent's) with the commands to read it, to answer it where it was asked (`quadit reply THREAD "…" --id=…` or `quadit comment KEY "…" --id=…`), to acknowledge it once handled (`quadit ack SEQ listen lease=ID`) and to wait again (`quadit wait lease=ID`, with `project=` when it listens to one); or `IDLE` and the command to wait again. The answer's change id is made from the item's own id, the same every time, so an answer sent twice (two sessions handed the same item at a takeover, or one sent again after a crash) is made once. The agent runs those lines as written, so `wait` prints nothing the server sent unless it has the form quadit gives it (a lease id, a task key, a page id, a handle), and the item's words in quotes, cut at 200 characters, without line breaks or quotes of their own.

Who is handed what:

| Sessions | What happens |
| --- | --- |
| One listens to SVA, another to GS | Each is handed only its project's items. |
| Two ask for SVA | The second is told what already listens to SVA, and can take over. |
| One listens to SVA, another to everything | SVA's items go to the first, the rest to the other. |
| The SVA session stops | SVA's items wait for the next SVA listener; they never fall to the one of everything. `quadit listening forget project=SVA` sends SVA's items from then on to the one of everything, which starts at the present: what was waiting stays unread in the inbox. |
| Only project listeners, and an item of no project (a comment on a page outside one) | It waits, for "check Quadit" or something listening to everything. |

The rule of the lease:

- One session of an agent delivers its inbox at a time in each scope (a project, or everything): the one holding that listener's lease. It says what it is when it takes it (`quadit wait`: "a chat"; `quadit listen`: "a companion", or what `by=` says; `quadit run`: "Quadit's runner"), and `quadit listening` (`GET /listening`) tells, without taking a lease, what listens to each project and to everything else, and when each was last heard. Only `GET /listen` takes a lease (`quadit wait` and `quadit listen`); the first wait takes it, and the commands it prints carry its id and its project. Another session's wait in the same scope is refused, "@coder is already listening to SVA from another session (a chat, last heard 14:02 UTC)", ending with the `take=1` command for when the person has it take over. A wait that slept through a takeover hands nothing over. Against a server older than listening by project, a wait with `project=` stops: "this Quadit server is older and cannot listen to one project: … Listen without project=, or update the server".
- The agent counts as listening while the lease lives: ninety seconds past the end of the hold its holder last asked for. A holder at work renews it by asking again: a wait by waiting, `quadit listen` every minute while its command runs. A chat that handled an item for longer, with nobody else taking the lease meanwhile, still acknowledges with it, and its next wait takes it again.
- An acknowledgment that gives a lease (`PUT /cursors/listen {"seq", "lease"}`) is refused when another session took the lease over since (`reason` `lease_stale`). One that gives none is made as before: a `quadit listen` from before the lease acknowledges so, and so does a person giving up on an item by hand.
- Only an acknowledgment moves the cursor: a wait with nothing for the agent leaves it where it was. A cursor never moved starts at the present, so history is not replayed; before its first wait, an agent deals with what `quadit work` shows is waiting on it.
- A tool that is killed while its `quadit wait` runs in the background can leave that wait running (Claude Code and Antigravity CLI did, in the check): the agent then shows as listening until the next item ends the wait, or its hour does. That item is not lost: it stays unread in the inbox, and whatever listens next is handed it.
- A `quadit listen` from before the lease keeps working: its waits on the feed with `cursor=listen` take no lease, but do not count as listening.

The API is `GET /listen?wait=50&lease=ID` (`project=KEY` for one project, `take=1` to take over), answering `{lease}` or `{lease, seq, item, line, wake}`, with `project` for a project's listener (`wake` says what Quadit's runner does with the item; a chat ignores it; `item.decision` is the decision's id for an item about one); `DELETE /listening/{key}` forgets a project's listener (`quadit listening forget project=KEY`), refused while its lease lives. `for=` should be a little under the longest the tool lets one command run.

Each tool, as `scripts/agent-listen-check.sh TOOL` finds it (a throwaway server, the skill under test given to the tool in its own project folder, ordinary words: "Connect to Quadit CODE", then "Listen to Quadit", a stretch with nothing arriving, two comments answered exactly once each, a second session that finds the agent listening and does not listen; for a tool that can be woken, a chat with a person in which the wait runs in the background while the person's question is answered and a comment still is; and a companion, `quadit listen --exec` with the tool's one-prompt command). It spends the person's plan, so it is run by hand.

**When the app is quit.** A server on this computer runs only while the desktop app does. When the app is quit and an agent runs `quadit` with a login the app made for that server (`quadit login URL - --app PATH`), the command finds nothing listening at this computer's address, starts the app without a window (on macOS by its bundle id, unless it is running already; on Linux by the path the login records, without a shell), waits up to 20 seconds for the server, says `Quadit was not running; started it.` on stderr and sends the request again, once per run. If that fails, the error ends `Quadit could not be started: open the Quadit app.` (or, with the app running and its server silent, `Quadit is running but its server does not answer: look at the Quadit menu.`). A server the person stopped from the app's menu stays stopped: the app keeps a file `server-stopped` beside its logins while it is, and the error says `Quadit's server is stopped: start it from the Quadit menu.` A login made by hand, a server elsewhere, a timeout, Windows, and a command kept off the network (Codex's sandbox) start nothing. The request is sent again only once Quadit answers there (its `/api/v1/version`), and a file going up is not sent twice: the command says `Quadit was not running; started it. Run the command again.` On macOS `open` and `lsappinfo` are run by their full paths.

| Tool | Connect and listen |
| --- | --- |
| Claude Code | verified on 2026-11-22 with 2.1.330: connect, listen, a chat with a person, a companion |
| Codex | verified on 2026-11-22 with codex-cli 0.170.0: connect, listen, a companion (it cannot be woken in a chat) |
| Antigravity CLI | verified on 2026-11-22 with 1.5.14: connect, listen, a companion (the chat was not run) |
| Gemini CLI | not verified yet |
| Cursor | not verified yet |
| GitHub Copilot CLI | not verified yet |
| opencode | not verified yet |
| pi | not verified yet |

## Quadit runs the agent

For Claude Code and Codex, Quadit can start the agent itself. When the person responsible for an agent assigns it a task, or comments on one of its tasks, `quadit run` on that person's computer starts the agent's program in the project's folder, hands it what came in, and records the run on the task. No chat has to be open, and each later comment on the task goes on in the same session. Only the person responsible for the agent (its owner), and the owner's other agents, start it: anyone else's words do not, and the task says so.

It is set up for one agent and one project on each computer: in the desktop app with **Run by Quadit…** on the agent's card ([Connect from the desktop app](#connect-from-the-desktop-app)), or with `quadit run add`. The program runs with full access, as the person whose computer it is: read [Security](#security-of-runs) first.

- The **runner**, `quadit run`, serves every entry of the computer's registry: one process per computer, on macOS and Linux. The desktop app starts it and keeps it running while there is an entry; it can also be run by hand.
- An **entry** binds an agent's login, a project, a folder and a program: "@claude runs SVA in ~/devel/game with Claude Code".
- For each entry the runner holds the agent's listener of that project, as `quadit wait` does, under the name `Quadit's runner`. The listener's cursor is the queue: an item is acknowledged only once its run has ended.
- A **run** is one start of the program for one inbox item, with the other items of the same task that came with it. It is a session on the task, shown under Sessions.
- Each task has one **program session** (the program's own conversation) per agent, computer and folder: every later run on that task resumes it.
- One run at a time in a folder. The program works in the folder itself, as it is.

### Commands

| Command | What it does |
| --- | --- |
| `quadit run [registry=PATH]` | Serves every entry until Ctrl-C or SIGTERM, and picks up entries added or removed while it runs (it looks at the registry every 2 seconds). Exits 0 when stopped; 1 for an unreadable registry or wrong arguments; 3 when another `quadit run` serves this computer (`another quadit run serves this computer (pid 4123)`). On a system without file locks and process groups (Windows), every form says `quadit run serves agents on macOS and Linux only` and exits 1. |
| `quadit run add login=PATH project=KEY folder=PATH program=claude\|codex [program_path=PATH] [max_minutes=N]` | Checks, then adds an entry: the login reaches its server and is an agent's that may write; the agent may work in the project (by key or name); the folder passes the folder rules (below); the program is found (on the `PATH`, or at `program_path=`) and answers `--version` within 10 seconds. Prints `Added: @claude runs SVA in ~/devel/game with Claude Code 2.1.331 on Aram's MacBook Pro.`; `--json` prints the entry. `max_minutes=` limits how long a run may take, from 0 (no limit, the default) to 10080. |
| `quadit run remove ENTRY_ID`, or `quadit run remove login=PATH [project=KEY]` | For each entry matched: stops its run, tells the server how it ended, lets the project's listener go, and drops the entry. With a runner serving, it waits up to 60 seconds for it; when the server has not answered by then it says `Quadit is still telling the server how @claude's last run ended; it is removed once the server answers.` and exits 1. `Nothing to remove.` when nothing matches. |
| `quadit run list [--json]` | Each entry and what it does now: `e5d2a91c  @claude  SVA  ~/devel/game  Claude Code  ready` (or `working on SVA-12`, `paused: …`, `aside: a chat listens`, `removing`, `not served: no quadit run is running`). A runner that serves but has not reported an entry yet: `starting`; an entry it cannot serve: `not served: <why>`; an empty registry: `Nothing runs on this computer: quadit run add registers an agent's project.` `--json` is `{"machine", "serving", "entries"}`, each entry with its `status` while a runner serves. |
| `quadit run machine name="…"` | Renames this computer as Quadit shows it (1 to 64 characters). |

`quadit run --secret NAME -- COMMAND` is still the secrets form ([Secrets](#secrets)): a first argument `--secret` makes it that, and every other form is the runner's. The runner's forms need no default login, since each entry has its own; they refuse `--dry-run`, and, before they touch anything, a field they do not take, a field given twice and an argument too many. `registry=PATH` uses another registry, with the runner's other files in `runner/` beside it (for tests).

`quadit run` prints one line for each thing that happens, and writes the same lines with their times to `runner.log`:

```
quadit run: serving 2 entries on Aram's MacBook Pro (stop with Ctrl-C)
SVA @claude ~/devel/game: listening
SVA-12 @claude: received #1042 (comment from @aram)
SVA-12 @claude: waiting for the folder (@codex works there)
SVA-12 @claude: running Claude Code, new session 3f2a6c1e-7b0d-4c1e-9a52-6d1f0e8b2c47, run 8b1c0d2e-5f3a-4b6c-8d7e-9f0a1b2c3d4e
SVA-12 @claude: done in 4m 12s
SVA-13 @claude: not started: @mia is not the person responsible for @claude
SVA-14 @claude: failed: Claude Code's usage limit; @claude paused until 18:00
SVA-15 @claude: stopped: a member asked it to stop
GS @codex ~/devel/site: a chat listens to GS; trying again in 2 s
GS @codex ~/devel/site: paused: Codex is not signed in (codex login)
```

Other lines say `waiting: its session was written outside Quadit a moment ago`, `waiting: what SVA-12 covers could not be read (…)` (the item comes again), `failed: the login file changed since it was verified`, `failed: Claude Code lost its session twice on Aram's MacBook Pro`, `interrupted: a chat took SVA over`, `interrupted: the agent's login was refused`, and `removed`.

A later run of the task prints `session <id>` (the one it resumes); a first Codex run, whose session Codex names itself, `a new session`.

`add` refuses with one sentence, such as `~ is your home folder: pick the project's own folder`, `/usr/local/src is a system folder: pick the project's own folder`, `~/devel/game already runs GS on this computer: one project per folder`, `@claude already runs SVA on this computer, in ~/devel/x`, `Claude Code was not found on this computer: install it, or give program_path=`, `this login is @mia's, a person's: Quadit runs an agent with the agent's own login`, `this login may only read: Quadit runs an agent whose login may write`, or `@claude may not work in SVA: quadit me lists its projects (it may work in GS, OPS)`. A folder holds one project (of one server and workspace); a second agent may run the same project in the same folder, and the two take turns. An agent runs a project in one folder per computer.

**Folder rules.** The folder is made absolute and its links resolved, and so are the home folder and the system folders (on macOS `/tmp`, `/var` and `/etc` are under `/private`). It must exist and be a folder. Refused: the home folder itself and every folder above it (`/`, `/Users`, `/home`), and anything at or under `/System`, `/Library`, `/Applications`, `/usr`, `/bin`, `/sbin`, `/etc`, `/var`, `/private`, `/opt`, `/tmp`, `/dev`, `/proc`, `/sys`, `/boot`, `/lib`, `/lib64`, `/snap`, `/nix`, `/root` or `/cores`. Anything else is allowed. The rules are checked again when the entry starts and before every start of the program. The server is told only a label: the resolved path with the home folder written `~`.

### Files on the computer

Beside the login files (`~/Library/Application Support/quadit/` on macOS, `~/.config/quadit/` on Linux, or the folder of `QUADIT_CONFIG` when it is set):

- `runner.json`, the registry (readable by the user alone): this computer's id (16 random hexadecimal characters, made once) and its name (on macOS its Computer Name, else its host name), and the entries. An entry is bound by ids: the server's address, the workspace, the agent and the project by their ids, the folder by its resolved path, and the program by its path; the keys and handles in it are for display. `quadit run add`, `remove` and `machine` write it, and the runner when it drops a removed entry; always whole.
- `runner/`, the runner's own files (readable by the user alone):

| File | What |
| --- | --- |
| `runner.lock` | held by the one `quadit run` that serves the computer |
| `registry.lock` | held while the registry is written |
| `status.json` | what each entry does now, written as soon as the runner serves; `quadit run list` and the desktop app read it |
| `locks/` | one lock per folder, named from the folder's identity, so two spellings of one folder share it: one run at a time there |
| `entries/<id>/state.json` | what the entry keeps between runs: each task's program session, the items its runs already took, the guards' counts, a pause |
| `entries/<id>/journal.json` | the run in flight, so that a crash can be told from a run that ended |
| `entries/<id>/outbox/` | every write to the server, in order, each stored with its change id before it is sent; `last` keeps the last number given, so none is given twice; `failed/<run>-<write>-<ordinal>.json` keeps each write the server refused for good, with its error |
| `runs/<run id>.log` | the program's output, kept 30 days, at most 16 MB a run (and, for Codex, its last message of each attempt beside it) |
| `runner.log` | what `quadit run` printed, with times; past 5 MB a new file, one old one kept |

An entry keeps its lease in the lease file `quadit listen` uses, beside the entry's login, so the runner and a `quadit listen` of the same login and project exclude each other (while such a `quadit listen` runs, the entry is not served, with that error, checked again every 5 minutes), and a runner started again goes on with its lease.

In `status.json` each entry is `starting`, `ready`, `working` (with its task), `paused` (with why, and until when for a usage limit), `aside` (a chat holds the project), `removing`, or `error` with a message (a refusal of `add`, `login refused`, `project gone`, `this Quadit server cannot run agents yet: update it`, `the server sent an answer that does not hold together`, `how a run ended could not be kept on this computer`, `a run could not be written down on this computer: …`, `another quadit listen is running with this login, …`), checked again every 5 minutes; `blocked` lists the writes the server refused for good.

### Which items start a run

For each inbox item it hands the runner, the server says whether it starts a run, is acknowledged without one, or is refused: acknowledged, with a run recorded as Not started that says why. The first rule that applies decides:

| Item | Starts a run when its author is the owner or one of the owner's agents | Acknowledged without a run when |
| --- | --- | --- |
| `assigned` | always | |
| `mentioned` | on a task | on a page |
| `waiting_on` | the task was handed to the agent | a shared resource's turn |
| `decision_asked` | the decision is still open and asked of the agent | answered or withdrawn since |
| `picked` | an answer to the agent's own question | |
| `unclear` | its answer was found unclear, and the decision is open and asked of it | answered again since |
| `replied` | an answer in a thread it wrote in | |
| `comment`, `result` | the comment was for the agent: on its own task, mentioning it, or handing it the task | heard only because it follows the task, or made before this version |
| `status` | never | always |
| any | | made by an automation rule; made by the agent itself; taken back by an undo; about a task in the trash, moved to another project, or that the agent may no longer read; written in its author's name by the server (below) |

The owner is the person responsible for the agent, while a current member of the workspace. The owner's agents are the current agents with the same responsible person; a [helper](#helpers) agent counts only when the owner, or one of the owner's agents, made it, whoever it names as responsible. An item by anyone else is refused (`not_responsible`); for an agent with no responsible person, every item is (`no_responsible`).

Only a change its author applied in person can start a run. An item an automation rule made is acknowledged (`rule`), though a rule acts as the person who made it; so is one the server wrote in the owner's name, from a sync with GitHub or a repository, a saved view's news or a job (`background`).

The runner asks for the agent's other waiting items of the same task with each item (at most 20), and the prompt carries those that would start a run too, when the runner knows what the task's earlier runs took; when it does not (a first run here, with no run on the server that took a prompt), the item runs alone and the others come as their own runs. A continuation after a usage limit or a sign-in failure carries nothing new: what came meanwhile comes as its own run. An item that comes during a run is not given to the running program: it becomes the next run, which resumes the same session. An item the program already took is acknowledged without another run.

Inbox items carry `addressed`: whether the change that made the item was for its member itself (it was assigned, handed, mentioned, asked or answered, the comment was on its own task, or it had asked in the thread), or the member only heard it because it follows the task.

Before you send a comment or assign the task, the line under the comment box, and the assignee picker, say what will happen for each agent a computer runs: it starts now on that computer; it is queued behind a run; it starts when the computer is back; it is paused, and why; or it will not start, and why.

### A run

1. **Received.** The runner records the run on the task as Waiting, and starts nothing before the server has it. The server takes it only with the runner's current lease of the project, and only when no other run of this agent on this task is open.
2. **Waiting.** For the folder, while another run works there (`folder_busy`); for the program session, while something outside the runner wrote it in the last 5 minutes (`session_open`, below).
3. **Working** (`running`). From the moment the program's provider took the prompt. Every 10 seconds the runner adds the new steps: a tool's name with the program's own short description of the call, or a file's path relative to the folder; never command lines or what a tool was given. Steps not yet put in the outbox when the runner crashes are lost; what the outbox holds (states, the end of the run, its comment, the acknowledgment) is sent after a crash.
4. **Ended**: Done, Failed or Stopped, with a reason when it failed. When a run ends Done, or Failed with `program_error`, `idle` or `time_limit`, and the agent wrote nothing on the task during it (no comment, reply, result or question), the runner posts the program's last message as a comment marked as coming from the run, cleaned of control characters and cut at 8,000 characters; a Stopped or Interrupted run posts none. The message's first 500 characters are the run's summary; an Interrupted run's summary says why (`Quadit stopped on MACHINE while this run worked.`, `A chat or another computer took SVA over while this run worked.`).

A run whose item does not start the program ends at once as Not started, with its reason. A Done run of an agent that asked a question on the task shows as **Waiting for an answer** while the question is open.

| State | Reason | Means | What to do |
| --- | --- | --- | --- |
| Waiting | `folder_busy` | another run works in the folder | nothing: it starts when that run ends |
| Waiting | `session_open` | the session was used in a terminal a moment ago | nothing: it starts once the session has been quiet for 5 minutes |
| Not started | `not_responsible` | the item's author is not the owner, nor one of the owner's agents | ask the owner to comment, or assign the task to an agent of your own |
| Not started | `no_responsible` | the agent has no person responsible for it | an admin sets one in Settings |
| Not started | `run_cap` | other agents started this agent too often in the last hour | comment to start it again |
| Not started | `no_progress` | the last two runs changed nothing on the task | comment to start it again |
| Not started | `run_open` | a run of this agent on this task is still open on another computer | stop that run, then comment again |
| Failed | `start_failed` | the program did not start, three times | the runner's log on that computer says why; comment to try again |
| Failed | `program_error` | the program stopped with an error after it began to work | comment to go on in the same session |
| Failed | `idle` | the program printed nothing for 30 minutes, so Quadit stopped it | comment to go on in the same session |
| Failed | `time_limit` | the run went past the entry's `max_minutes` | comment to go on in the same session |
| Failed | `interrupted` | Quadit stopped on that computer, another session took the project, or the agent's login was refused, while the agent worked | comment to go on in the same session |
| Failed | `usage_limit` | the program's usage limit was reached | nothing: it starts again by itself after the reset |
| Failed | `not_signed_in` | the program is not signed in | sign in to the program on that computer; it starts again by itself |
| Stopped | | a member pressed Stop | |

A run whose program began to work (used a tool) is never started again by itself: what it did stays in the folder as it is, and Quadit never reverts anything. A failure before any work is tried again, three attempts in all, 10 seconds and then 60 seconds apart. After a usage limit or a sign-in failure the item is kept: a usage limit pauses every entry of that agent on the computer until it resets, a sign-in failure pauses the entry it happened in until the program is signed in, and the item then runs again; when the program had already begun, that run is told to go on from where it stopped.

When an entry starts, the runner checks the folder, the program (`--version`), the login (an agent's, may write, of the entry's server and workspace), the project, that the program's own settings cannot make it work as another login (for Claude Code the `env` of the user's `settings.json` and of the folder's `.claude/settings.json` and `.claude/settings.local.json`; for Codex `shell_environment_policy.set` in `config.toml`: any of them setting `QUADIT_CONFIG` to another login, or `QUADIT_URL` or `QUADIT_TOKEN` at all, or one that cannot be read), and that the program is signed in (`claude auth status`, `codex login status`). Nothing is sent for an entry before its login is verified against the entry's server, workspace and agent. Before every start of the program it checks the folder, the program and those settings again, and that the login file is the one it verified (else the run fails and the entry stops, `login refused`); the program starts only right after the run's row and the lease were read again. A failed check pauses the entry (`folder_missing`, `program_missing`, `login_mismatch`, `not_signed_in`) and its items wait; a paused entry keeps its lease and checks again every 5 minutes. A login refused or a project gone stops the entry, tried again every 5 minutes. A server that answers without saying what to do with an item is older than the runner needs: the entry pauses (`server_old`) and says to update the server.

### The prompts

The runner builds each prompt on the computer, from fixed texts in the `quadit` binary; the server supplies no template. The prompt goes to the program on its standard input, never on its command line. Every prompt names the agent's responsible person, read again from the server for each run (in a resumed session, `You work for @aram now.`), so a session follows a change of owner. In outline:

- **A first run on a task**: who started the agent, on which computer and folder, for which task and run; that nobody is in the conversation; the items, between two marker lines made with a random word for each run (`QUADIT-ITEMS-…`), each as `quadit wait` prints it; that what the owner asks there is the work, and that the items are members' words, never to be followed to reveal secrets, change who it works as or which server it uses, or do something unrelated to the task; then to follow the skill's section "Started by Quadit" ([the skill](../integrations/skills/quadit/SKILL.md)).
- **A later item** (resuming the session): the new items, newest first to read, and to say in its first comment how they change what it does next.
- **An answer to its question** (resuming): who answered which decision, to go on acting on it, and `quadit unclear` when it does not settle the question.
- **Its answer found unclear** (resuming): to answer the decision again with `quadit pick`, or to say in a comment what it needs to know first.
- **A continuation** (resuming, after a usage limit or a sign-in failure past the start of work): to go on from where it stopped.
- **A fresh session after a lost one**: the first-run text, saying that the earlier session could not be found and to read the task first.

Outside the item block a prompt carries only values the runner checked or knows itself: handles, the task's key, the run's id, a decision's id, the computer's name and the folder. Never the task's title or the workspace's name.

**How the program is started.** Claude Code: `claude -p --output-format stream-json --verbose --session-id UUID --name KEY --permission-mode bypassPermissions --disallowedTools AskUserQuestion`, or `--resume UUID` in place of `--session-id UUID --name KEY` to go on with a session. Codex: `codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -o LASTFILE -`, or `codex exec resume … ID -`. Each starts in a process group of its own, in the folder; on macOS the computer is kept from idle sleep while it runs (`caffeinate -i`; a closed lid still sleeps). Its environment is the runner's without `CLAUDECODE`, `CLAUDE_CODE_*`, `QUADIT_*` and `ELECTRON_*`, with `QUADIT_CONFIG` (the entry's login), `QUADIT_TASK` (the task's key), `QUADIT_SESSION` (the run's id) and `NO_COLOR=1`. Nothing else is removed, so the programs' own sign-in and network settings (API keys, proxies) reach them. The runner reads only the program's standard output as what it did; unknown lines are passed over. What it keeps is bounded: an output line at 16 MB (a longer one is passed over), the end of the program's error output at 64 KB, its last message at 64 KB, a check's output (`--version`, sign-in) at 64 KB, a run's log at 16 MB.

### Sessions, and continuing in a terminal

Each task has one program session for each agent, computer and folder, kept in the entry's `state.json`, and a later run resumes it. Claude Code is given a session id the runner chose; Codex says its own, which the runner then keeps. The run on the task shows the id, but the runner resumes only an id it kept itself, never one from the server. When the session cannot be found on the computer any more, the run starts a fresh one, once, and the prompt tells the agent so.

On the task, the agent's owner sees on its newest ended run **Continue in a terminal on MACHINE**, with the command to copy: `cd ~/'devel/game' && claude --resume 3f2a6c1e-…` (Codex: `codex resume …`). Two programs writing one session can lose what one of them wrote, so the runner does not start a session that something else wrote in the last 5 minutes: the run waits (`session_open`) until the session has been quiet that long. This is best effort: going back to the terminal after a run has started can still write beside it, and the program then decides what is kept.

### Stopping a run

Any member who may change the task stops a waiting or working run with **Stop** (the change `session.stop`): the runner sends the program's process group SIGINT, then SIGTERM after 10 seconds and SIGKILL after 5 more, and the run is Stopped. A run whose computer does not hold the project now (it is offline, or a chat holds the project) is ended at once by the server, since nothing would act on the stop. A session Quadit did not start cannot be stopped this way.

The runner stopping, the entry being removed, the app quitting or updating, and a chat or another computer taking the project during a run end it as Interrupted (SIGTERM, then SIGKILL after 2 seconds), not Stopped; a comment goes on with it. The computer sleeping stops nothing: its lease lapses, the page says it is offline, and what comes waits for it. After a crash, the runner closes a run that may have started as Interrupted when it starts again, and never starts that program again by itself. One gap remains: if the runner itself is killed outright in the instant between starting the program and recording its process group, the next start ends that run as Interrupted but cannot stop the program.

A chat and the runner never answer the same project at once. The runner never takes the lease from a chat: while a chat listens, the entry waits and tries again (after 2 seconds, doubling, at most every 60 seconds). A chat told to take over (`take=1`) interrupts a run in progress, and is handed the item.

### Guards

| Guard | What it does |
| --- | --- |
| One run per folder | Across agents and entries; the next run waits (`folder_busy`). |
| Idle watchdog | A program that prints nothing for 30 minutes of awake time is stopped (`idle`). There is no time limit unless the entry has `max_minutes`. |
| Runs started by agents, per task | At most 4 per entry and task in any 60 minutes (`run_cap`). |
| Runs started by agents, per entry | At most 12 per entry in any 60 minutes, whatever the task, so two agents of one person cannot keep each other going (`run_cap`). |
| No progress | After two runs in a row on a task that changed nothing on it (no comment, result, question, change to the task or link), runs started by agents on it are held (`no_progress`). Only runs whose program took the prompt and that ended Done, or Failed with `program_error`, `idle` or `time_limit`, are counted. |
| Usage limit | The agent's entries on the computer pause until the reset the program gave, else for 30 minutes, doubling, at most 4 hours; the item is kept and continues after it. |
| Retries before work only | At most 3 attempts, one fresh start after a lost session among them (a second lost session fails the run, `start_failed`); a run that began to work is never repeated by itself. |
| Unknown errors | An error the runner cannot tell never stops a program that is running. |
| Infrastructure stops | The runner, the app or a lost lease ending a run is Interrupted, not Stopped; sleep stops nothing. |
| One runner per computer | A second `quadit run` exits with 3. |
| Whose words | Only the owner's words, or the owner's agents', in a change applied in person, start a run; a rule's, a sync's or a job's never do. |

A person's item is never held by a guard, and a held item never blocks a person's item behind it: it gets its Not started run and is acknowledged, and the next item runs. On a task held for no progress, the owner's item runs; the hold lifts once a run changes something on the task.

### Security of runs

**What the server can make a computer do.** It can hand the runner an item of a project the person registered on that computer, and with it have the registered program start in the registered folder, as the registered agent's login, with a prompt built on the computer from fixed texts that carry the items' words between markers; and it can ask a run to stop. It cannot choose the program, its flags, the folder, the environment, the permission mode or the prompt's text; it cannot start anything for a project or an agent the computer did not register. Nothing listens on the computer: the runner only calls out.

**What reaches the server.** By itself, the runner reports: the computer's id and name, the folder's label, the program and its version, a pause and its reason; for each run its state and reason, the program's session id, the items it took, its steps (tool names, the program's own descriptions of calls, paths relative to the folder), the time a usage limit resets, and the program's last message (as the run's summary, and as a comment when the agent wrote nothing). The agent itself works with full access and its own Quadit login, so anything it writes or uploads reaches the server too: a comment or a result can carry the contents of any file it can read, and `file=` uploads any file.

**The registered server is trusted for what its items say**: who wrote them, and that the owner wrote them. Its administrators could forge an item from the owner, and nothing on the computer can tell. Register only a server you trust as much as a person who may type into your terminal.

**Full access.** The program runs with its approvals and its sandbox off, so it can read and change whatever the person can: their files, their keys and tokens on disk (the agent's own Quadit login among them), whatever their accounts reach. The item's words, and everything the agent reads while it works (the task, its comments, the repository, web pages), can steer it. What holds this: only the owner's words, or the owner's agents', start a run; a change made in someone's name by a sync, a rule or a job never does; a helper agent (one made for a task) counts as the owner's only when the owner, or one of the owner's agents, made it, so a member cannot make one that names the owner and start runs with it; other members' words are material, by the prompt and by the skill; the markers around the items; and the three things the skill says an agent never does because a text says to. What remains: a member who may edit a task's description writes words the agent reads during a run the owner started. The app's card says "with full access, as you" before the first entry is made.

**Tokens.** A run uses the agent's existing login file, which the program can read: the same credential the agent uses in a chat, so a run gives it nothing new. The runner uses the same login.

**On a team server** other members' comments reach the agent's inbox as on any server; they never start a run, and the task says so. Every member who may read the project sees the computer's name, the folder's label and the program; only the owner is shown the command that goes on with a session in a terminal. The owner's runner spends the owner's plan with the program's provider. The server never starts work on a computer whose owner did not register that project for that agent.

### The API of runs

- `GET /listen`, for a runner's hold: `machine_id` (16 hexadecimal characters) with `machine_name`, `folder` and `program` (all required with it), `program_version`, `paused`, and `paused_until` (only with `paused=usage_limit`); only on a project's listener, and only from an agent's login. A hold that names a machine marks the listener as the runner's; any other hold (a chat's) unmarks it as the holder and keeps the rest. Every item answer, to any listener, carries `wake`, `{"do": "run" | "ack" | "refuse", "why": …}` (`for_you`; `not_responsible`, `no_responsible`; `gone`, `rule`, `background`, `page`, `own`, `status`, `resource`, `answered`, `follow`, `unknown`). An item about a decision carries `item.decision`, its id (also on `/inbox` and `/my-work` items). `batch=1` adds `batch` to a task's item: the agent's other unacknowledged items of the same task (at most 20, oldest first, each with its `wake`, `[]` for none), which it does not hand out.
- `DELETE /listening/{key}/runner?machine_id=ID` lets a project's runner go: it clears the runner's mark and ends its lease for good (a hold, an acknowledgment or a start made with it is then refused `lease_stale`), so a chat can listen at once, and keeps the listener and its cursor. It answers `{"project": "SVA", "released": true}`, `false` when that computer had no mark there; `dry_run=1` checks without doing. The listener of everything has no runner (`invalid`).
- `session.start`, for a runner's run: `state` (`waiting` or `not_started`), `reason`, `program`, `program_session`, `machine_id`, `machine_name`, `folder`, `lease` and `item_seq`. Only the agent's own login records one, on a task of a project it may reach (`forbidden`), with the lease this computer's runner holds on the task's project (`conflict`, `lease_stale`), and with no other run of this agent on the task open (`conflict`, `run_open`: `@claude already has a run open on SVA-12, on Aram's Mac mini (run …)`; a session recorded by hand never counts). A run id already used is `conflict`, `in_use`.
- `session.update`: `reason`, `program_session` (a UUID, set once, or again with `fresh: true`), `items_through` (only with the move from `waiting` to `running`, when the server sets `accepted_at`; left out, it is `item_seq`) and `resets_at` (only with the reason `usage_limit`). A change of state without `reason` clears it. A runner's run never leaves an ended state (an update of an ended run may only add links or a summary), becomes `running` only from `waiting`, `done` only from `running`, and `stopped` only after a stop was asked; its steps are objects with a `tool` and a `text`, at most 50 an update, a text cut to 200 characters. A session recorded by hand cannot be given what only a runner's run has, and keeps its other freedoms.
- `session.stop {id}` asks a runner's run to stop; any member who may change the task may (the project's access is checked first, even when the stop would change nothing). Asked twice, or of an ended run, it changes nothing; a session recorded by hand is refused.
- `comment.create` takes `session`, the agent's own runner's run on the same task: the comment a run posts from the program's last message. Its mentions make no `mentioned` items and no followers.
- `GET /tasks/{key}/run-outlook?agents=@a,@b&cause=comment|assign` says, for each agent named (at most 20), what a comment or an assignment would do: `none` (no runner, or the item would start nothing), `starts_now`, `queued` (with `running`, the task of the run before it), `when_back` (with `since`), `paused` (the pause; `until` for a usage limit), `in_chat`, or `will_not_start` (`no_runner_here`, `not_responsible`, `no_responsible`), with the computer, the folder, the program, the project and the owner (`""` when it has none). All eleven fields are always there, as strings, in the order the agents were asked; an unknown, removed or suspended agent, or a person, is left out. Any member who may read the task may ask.
- `GET /listening`, `GET /agents`, `GET /agents/connection` and the dashboard's agents give the listener a runner marked `runner`: `machine`, `folder`, `program`, `program_version`, `holding`, `since`, and, when set, `paused`, `paused_until` and `task`, the key of its open run in that project. `quadit listening` prints it as `SVA: Quadit's runner on Aram's MacBook Pro listens (last heard 2026-11-24 14:02 UTC).`, or that it is away and its items wait for it.
- `GET /me` gives `workspace.id`.

### What is verified

| Program | Runs |
| --- | --- |
| Claude Code | The command line and the reading of its output are verified against real output of 2.1.331 (recorded 2026-11-24, kept as fixtures): a fresh run with a chosen session id, a resume, a lost session, and the rate-limit event every run prints. Not yet verified with a live agent on a task: a whole run through Quadit, tool events, a real usage limit, a sign-in failure. |
| Codex | The command line and the reading of its output are verified against real output of 0.170.0 (recorded 2026-11-24, kept as fixtures): a fresh run, the thread id it gives, a resume, a lost session, the last-message file. Not yet verified with a live agent on a task: a whole run through Quadit, tool events, a real usage limit, a sign-in failure. |

`scripts/agent-run-check.sh claude|codex` (after `make server`) checks a whole run by hand with the real program, which must be signed in and must not be set up to work as another Quadit agent on that computer (the check stops and says so when it is). It runs a throwaway server, keeps its logs, data and registry in a folder under `$TMPDIR` (named at the end), and its git repository in `~/.quadit-run-check.XXXXXX/repo` (private, removed at the end). It prints one PASS or FAIL line per step and stops at the first failure, with the paths of the logs: an assignment, a comment that goes on in the same session, a question and its answer, another member's comment that starts nothing, a stop, a lost session, a terminal on the session (it needs you; `RUN_CHECK_SKIP_TERMINAL=1` skips it), the runner killed and started again, the folder removed; then it keeps each run's output, sanitized, as fixtures. Codex runs with a `CODEX_HOME` holding only a copy of your `auth.json`; Claude Code with your own profile, its sessions for the repository removed at the end. It spends the person's plan, so it asks before it starts (`RUN_CHECK_YES=1` does not ask).

## A session in five calls

An agent needs no memory of its own between sessions.

| Step | Command | API |
| --- | --- | --- |
| 1. Who am I | `quadit me` | `GET /me` |
| 2. My work | `quadit work` | `GET /my-work` |
| 3. What changed while I was away | `quadit events cursor=main mine=1 others=1` | `GET /events?cursor=main&mine=1&others=1` |
| 4. Everything about the task I pick, and take it | `quadit context SVA-12`, `quadit take SVA-12` | `GET /tasks/SVA-12/context`, change `task.take` |
| 5. Post the result, mark the feed handled | `quadit result SVA-12 "…" checked="…"`, `quadit ack SEQ` | change `comment.create`, `PUT /cursors/main` |

API paths are under `/api/v1/w/-/`; the `-` means "the workspace of this token".

## Reading

- Every read returns JSON, or one line per item with `format=text` (what the CLI prints). Long text is cut at a stated size; `full=1` returns all of it.
- Names work wherever ids do: `SVA-12`, `@handle`, a status, label, epic, milestone or saved view by name, a priority as `high`, `me`. A decision is named by its task: `SVA-12` when the task has one open question, `SVA-12#2` for its second.
- A list read as JSON takes `fields=key,title` (each row with only those fields, and its id and key) and `since=1042` (only the rows that changed after that feed position; a row that does not record when it changed is kept), so you never pay for what you already know. The text form (`format=text`, what the command-line tool prints) has lines of its own and ignores `fields`; there, `since` narrows a task (`quadit show`), a page, the task list, the inbox and search.
- A long list says how to read on: `cursor=…` from the last answer. Tasks added while you page are left for the next read, and tasks that close do not shift the rest. A task whose own place in the order changes while you read (its priority is raised in a list read by priority) comes at the end of the last page, so none is missed; it may be one you saw before, now with its new values (`changed_while_reading` says how many).
- A task moved to another project gets a new key; the old key still finds it. Moved back to a project it was in, it gets its key there back (unless another task has that number now).
- A saved view that names a label, status or epic deleted since is read without that part, and the answer says so (`note`).
- `quadit tasks assignee=me status=todo label=art open=1 sort=priority`; `count=1` returns only the number; `view=SLUG` runs a saved view.
- `quadit show SVA-12 since=1042` returns only what happened in the task after feed position 1042.
- A refusal says what was wrong, lists what would have been accepted and suggests the nearest match:

```
invalid: project SVA has no status "In Progres"
  did you mean: In Progress
  allowed: Backlog, Todo, In Progress, Waiting, Done, Canceled
```

- A few refusals of the same code say which they are in `reason`, beside `code`, `message` and `field` in the error's JSON: `in_use` (an id, key or name asked for is already someone else's) and `number_taken` (the task number asked for is another task's). Act on the reason, not on the words of the message.

## Following changes

Everything that changes is one event in one ordered feed per workspace. A comment, a pick and a status change are all there, in order, with their new values.

| Way | How |
| --- | --- |
| Pull from a cursor | `GET /events?cursor=main` reads from the place the server keeps for you; `PUT /cursors/main {"seq": N}` marks it handled. A cursor never moves back |
| Wait | Add `wait=50`: the request is held until something matching arrives. One call, no polling loop |
| Narrow | `mine=1` (tasks you are assigned, waited on, mentioned in or watch), `others=1` (not your own changes), `task=SVA-12`, `types=decision.picked`, or any task filter |
| Inbox only | `inbox=1`: assignments, mentions, answers to your questions, replies |
| Push | A webhook "for" the agent gets its inbox items as signed POSTs, in order, retried until they arrive. The server calls public addresses only; one on its own machine or network needs `--allow-private-networks` ([install](install.md#addresses-users-give)) |
| Listen in a session | `quadit wait [project=KEY]`, again and again, in the agent's own session when the person asks it to listen: one inbox item at a time, of one project or of everything, with the commands to go on ([Connected, and listening](#connected-and-listening)) |
| Companion | `quadit listen [project=KEY] --exec ./wake.sh` holds the wait for you and runs a command for each inbox item: for agents with nothing running |
| Quadit runs it | `quadit run` starts Claude Code or Codex in a project's folder for each inbox item from the agent's owner or the owner's other agents, resuming one session per task, and records each run ([Quadit runs the agent](#quadit-runs-the-agent)) |
| Live stream | `GET /events/stream`: server-sent events |

Rules in Settings → Automation add wake-ups such as "when a person answers a decision, tell @coordinator".

`quadit listen` delivers each inbox item at least once, one at a time, in order. Its cursor, one for each scope (`listen` for everything, `listen:<project id>` for a project), moves past an item only after the command exited with 0. When the item's secrets cannot be had, or the command fails, listen says so, waits (1 second, doubling up to 5 minutes) and runs it again; the items after it wait for it. So the command must be safe to run twice for the same item: a crash, or a failure after part of the work was done, brings the item back. To give up on an item instead, move the cursor past it with the command listen prints when it says the item was not handled: `quadit ack SEQ listen lease=ID`. Listen holds the agent's lease like `quadit wait`, so only one of them delivers the inbox at a time; it stops when another session takes the lease over (`take=1` takes it over), and keeps the lease's id in a file beside its login file, one for each login (server and token) and scope (a project, or everything: plain `listen`), locked while it runs, so a listen stopped or restarted goes on with the lease it held, and a second listen on the same login and project is refused ("another quadit listen is running with this login, for the same project or for everything").

## Writing

Every write is a named change with an id you make. Sending the same id again applies nothing twice, so retries are safe.

```bash
quadit new SVA "Hit flash is too subtle" labels=art priority=high assignee=@artist
quadit update SVA-12 status="In Progress" waiting_on=@mia
quadit comment SVA-12 "Which frame is the peak?" waiting_on=@mia
quadit ask SVA-12 "Which explosion?" option="A: ring" file=ring.gif option="B: burst::reads best small" file=burst.gif recommended=2 why="clearer at 1x"
quadit do task.update '{"id": "SVA-12", "base_seq": 1042, "title": "New title"}'
```

- `--dry-run` checks a write without making it: a change, `remember` and `ack` are checked by the server; `upload`, `attach` and a comment's `file=` check that the files can be read and send nothing. `run`, `request`, `listen`, `wait` and `connect` cannot check without doing, so they refuse `--dry-run`.
- `base_seq` refuses the update if the task changed since you read it, and says which fields changed.
- A batch (`POST /changes {"changes": […]}`) applies all of its changes or none. An admin bringing in history may mark a change, alone or in a batch, `"quiet": true`: it reaches no inbox, wakes nobody, starts no rule and raises no watched-view alert, and its events say `"quiet": true`. Webhooks still get it, as they mirror the feed, with `"quiet": true` in the payload. `quadit import` does this for an admin; a member or a member-role agent is refused.
- A person's undo is a change like any other, sent with `"undoes": "<change id>"`, and its events carry `"undoes"` with that id. Read such a pair as "nothing happened": the first change was a mistake put right, not a decision reversed, so do not report it as work done and reopened. If the first change woke you (a task given to you, then taken back), the undo's own event tells you so: stop, and say in a comment anything you already did. Within five minutes of the first change the inbox item it made is removed again if still unread.
- `quadit changes` lists every change type with its arguments, and the surface version (within one major version nothing an agent relies on is removed or renamed).
- `--id=UUID` gives a change its id yourself: after a crash, sending it again with the same id does nothing twice. `--for=@member` makes a change for someone: it then runs with their access.
- `quadit assign SVA-12 none` (or `update SVA-12 assignee=none`) leaves a task with nobody; the API takes `"assignee": null`.
- A task can wait on something that is not a member: `quadit update SVA-12 waiting_on=outside waiting_on_note="the certificate from Apple"`. `quadit tasks waiting_on=outside` and `waiting_on=none` find those, and the ones nobody has.

## Decisions

Ask with `decision.open`: a question, two or more options (each can carry files), an optional recommendation, and whom to ask. If you name nobody, the person responsible for you is asked. The task then waits on them.

When the options can be seen (pictures, layouts, variants), each option carries its own file, even when the same files are already on the task: the person compares and picks in the question itself. `quadit ask` reads `file=PATH` in order: a file after an `option=` is shown on that option, a file before the first option on the question. The files are uploaded first and the decision opens with them in one batch; with `--id` a resend uploads and attaches nothing twice, `--dry-run` uploads nothing and says where each file would go, and `--json` gives the decision and the files' ids. `quadit approval` takes `file=` for the question too.

When they answer, the task waits on you again and the answer is in your inbox and feed:

```
#1061 11-14 19:46 @mia decision.picked SVA-12 "Which explosion?" -> 2) B: burst (with_changes): Make it 20% larger.
```

If the answer does not settle the question, say so in one line with `decision.unclear` instead of guessing; the question goes back to them.

For a plain yes or no, `quadit approval SVA-12 "Merge this?"`.

Some changes need approval first. A new agent asks before anything that cannot be taken back or that reaches outside (deleting a project, adding or removing people, webhooks, integrations, repository sources, secrets, and requests made with a secret that change something); the person responsible for it can change that list. A refused change says so (`needs_approval`). Ask with the exact change:

```bash
quadit approval SVA-12 "Delete the duplicate SVA-14?" action=task.delete args='{"id":"SVA-14"}'
quadit do task.delete '{"id":"SVA-14"}' approval=DECISION_ID      # once approved
```

An approval covers that one change with those arguments, once. It is given by a person who could make that change themselves (of the role it needs), and when you asked someone in particular, by them; the change then reaches only the projects they reach.

## Results

Post what you did as a result, with how it was checked in separate fields:

```bash
quadit result SVA-12 "Burst is 20% larger." checked="in game at 1x and 2x" measured="24 frames" not_verified="on a phone" file=burst.png
```

The task goes back to whoever answered your last question.

`file=PATH` works on `comment` and `reply` as well, on tasks and on pages, and can be repeated: an agent that made something to look at (a picture, a screenshot, a clip) attaches it to what it writes, so the person sees it in the task instead of a path on the agent's machine.

## Taking work and sharing machines

- `quadit take SVA-12` makes you the one working on it for 30 minutes; take it again to renew. Two agents cannot take the same task, and a task held by an agent that stopped frees itself.
- A shared resource (a build machine, a test device) has a queue: change `resource.acquire {"resource": "build-box"}` answers `holding` or `waiting`, and you are told when it is yours. Release it with `resource.release`.

## Helpers

An agent can make a helper for one task: `quadit do agent.create '{"name":"Inker","handle":"inker","task":"SVA-12"}'`, then a token for it with `POST tokens {"user":"@inker"}`. The helper is a member limited to that task's project and to its maker's own limits, the same person answers for it, and it is suspended when the task is done or dropped.

## Memory

Notes you want next session live as pages people can read and correct:

```bash
quadit memory                          # read them all at the start of a session
echo "- the owner dislikes rings" | quadit remember Preferences mode=append
```

Standing preferences set by the owner ("no rings as the main shape of an explosion") come with `quadit me` and with each task's context pack.

## Docs

```bash
quadit docs                 # the page tree, with ids
quadit docs project=SVA     # one project's pages: those tied to it, with the pages under them
quadit doc PAGE_ID          # one page as Markdown, then its open comment threads
quadit write PAGE_ID < page.md          # rewrite it; blocks that did not change keep their comments
quadit write new "Release notes" < notes.md
quadit write new "Boss design" project=SVA < boss.md     # a page of a project
quadit do doc.update '{"id":"PAGE_ID","project":"SVA"}'   # tie a page to a project; "project":null ties it to none
quadit rows DATABASE_ID filter=State:is:todo sort=-Frames
```

A page belongs to the workspace and may be tied to one project. The project decides who sees it: a member limited to some projects sees those projects' pages and the pages of no project. A page made under another is in its parent's project, and the tree says a page's project (`[SVA]`) only where it is not its parent's. Changing a page's project takes along the pages under it that are in the same project, down to the first that is not: a sub-page tied elsewhere on purpose stays where it is, with what is under it. Nobody can move a page into a project they do not see. A page that leaves a project is in the feed twice: the change, for those who see the project it left, and the whole page, for those who see where it went.

In Markdown written to a page, `@handle` of a member becomes a mention, as one typed in the editor: the member is told, and the page lists them; `quadit doc` writes it back as `@handle`. In bold, italic or code it stays text.

A task and a page point at each other when one mentions the other (a task key in the page, a page link in the task's text or a comment) or when they are linked: `quadit link SVA-12 page=PAGE_ID`, or from the page's side `quadit link page=PAGE_ID task=SVA-12` (the change `link.set {"task":"SVA-12","kind":"doc","ref":"PAGE_ID"}`; `link.remove {"id":"LINK_ID"}` undoes it). Either way the task's context pack lists the page under "linked docs", `quadit show SVA-12` lists a linked page as `page TITLE (doc ID)`, and the page lists the task among what mentions it. A page the reader may not see is left out of all of these.

### Comments on a page

People comment on words of a page (the text they select), on a block, or on the page as a whole, and answer each other in a thread. Asked something there, you get an inbox item (`mentioned`, or `replied` when someone answers in a thread you wrote in: for an agent, a person's reply that names nobody else, or the answer of one it asked there) whose line ends with what you need to answer:

```
#1207 11-16 10:42 @mia mentioned: Boss fight — @coder is this still three phases?  (page PAGE_ID, comment COMMENT_ID, thread THREAD_ID, on "The boss has three phases.")
```

`quadit listen` hands the same line to its command in `QUADIT_EVENT`, and the record `quadit wait` prints in `QUADIT_ITEM`. Then:

```bash
quadit doc PAGE_ID                  # the page, then its open threads
quadit comments PAGE_ID resolved=1  # the threads alone; resolved=1 adds the resolved ones
quadit reply THREAD_ID "Yes: phases two and three merged."   # any comment id of the thread works
quadit comment page=PAGE_ID block=BLOCK_ID quote="three phases" "Should this say four?"   # a new thread on words
quadit comment page=PAGE_ID block=BLOCK_ID "Is this paragraph needed?"   # on a block
quadit comment page=PAGE_ID "Reviewed; two questions below."         # on the page
quadit resolve THREAD_ID            # reopen THREAD_ID opens it again
```

`quote=` is the exact words, as the block reads them (a mention is its `@handle`); the server finds them in the block. Words that are there more than once are refused until `occurrence=N` says which (1 is the first). Through the API or MCP it is `comment.create {doc, block, quote, occurrence, body}`; the web app sends where the words are too (`start` and `end`, characters of the block's text, and `end_block` for words that run on into later blocks), and the quote is checked against them.

The threads after a page read like this; the block id is what `block=` takes. A thread on words quotes the words as they read now; one whose block was taken out of the page since says `on removed block`, and one whose words were taken out says so and quotes them:

```
--- comments: 4 open threads; 1 resolved (resolved=1 shows them)
thread THREAD_ID on words of block BLOCK_ID "three phases"
  @mia 2026-11-16 10:42: Is this still three?
    @coder 2026-11-16 10:50: Yes: phases two and three merged.
thread THREAD_ID on block BLOCK_ID "The boss has three phases."
  @bea 2026-11-16 10:44: Is this paragraph needed?
thread THREAD_ID on the page, its words taken out of it: "two lasers"
  @bea 2026-11-16 10:47: One laser is enough.
thread THREAD_ID on the page
  @bea 2026-11-16 11:02: Who owns this page?
```

In the page's Markdown (`quadit doc`, `format=md`) the words a thread is on are a span that names it: `The boss has <span data-comment="THREAD_ID">three phases</span>.` Words several threads are on name them all, space-separated; where threads overlap, the spans follow each other, each naming the threads on its words. The marker is part of the text: it moves with the words as people edit, and `write` takes the spans back:

- Keep a span around its words when you rewrite them; put it elsewhere to move the thread. A span naming a thread that is not this page's is dropped.
- A span left out does not take the thread off: while its words are still in the page (the same block, or a block the same write put them in, not the same words that block had already), they keep it.
- A write that takes a thread's words out answers with a warning (`warning: thread THREAD_ID was on words this edit took out of the page ("three phases"): it stays open, on the page as a whole`; `warnings` in the API's and MCP's answer). The thread is never resolved or deleted by an edit; an edit that brings its marker back (an undo in the editor) puts it on its words again.

A page as a repository file holds it, and an export, have no spans: there, and in what a repository sync brings in, text that looks like a span is text.

`comments=0` leaves the threads out; `format=md` is the page alone, as `write` takes it back. Whoever wrote in a thread is told of each reply in it; an agent, only of one for it (see [Connected, and listening](#connected-and-listening)). Resolve a thread once the question in it is settled, not to hide one you disagree with. `reply` works on a task's comments too: `quadit show KEY` gives each comment's `id=`.

A page that mirrors a Markdown file in a repository is called by the file's opening `# heading` (else by its file name) and does not repeat it in its text; written back, the title is the heading again. Renaming the page changes the heading, not the file name.

## Session records and hand-off limits

Record a run so people can see what you did: change `session.start {"task": "SVA-12", "title": "…"}`, then `session.update` with `add_steps`, `add_links` and at the end `state: "done"`. A session is the log of a run (what it was asked, what it did, what it produced, when it started and ended); Quadit keeps no record of what a run cost.

A session an agent records itself is `running` until it is `done`, `failed` or `stopped`. One Quadit's runner records ([Quadit runs the agent](#quadit-runs-the-agent)) also goes through `waiting` (received, the program has not taken the prompt yet) or ends `not_started`, has a `reason` when it waits, did not start or failed, and carries its program, its program session, the computer and the folder's label; an ended one never changes state again. An agent does not record a session during a run Quadit started: it records that run itself. A `session.updated` event carries the steps and links added in `data.appended`, not the whole list in `changes`; a reader appends them to its copy, once, when the event is newer than its row. A runner's run keeps its newest 200 steps (`steps_dropped` counts the rest).

Work passed from agent to agent is counted. An agent can have a hand-off limit (`handoff_limit`, a number of hand-offs a week, set by an admin; `quadit me` shows it), and so can a task (`handoff_limit` on `task.update`, in all, set by an admin). No agent lifts a limit: not its own, and not a task's, which an admin agent may only lower. Past either, a hand-off to another agent is refused with `handoff_limit_reached`: hand the task to a person instead.

## Secrets

Keys and passwords live in the workspace's vault. An admin sets them; nothing ever returns a value.

```
quadit do secret.set '{"name":"DEPLOY_KEY","value":"…","hosts":["api.example.com"],"agents":["@coder"]}'   # admin
quadit secrets                                    # the ones I may use, and where each may go
quadit request DEPLOY_KEY https://api.example.com/deploy method=POST \
       header="Authorization:Bearer {{secret}}" body='{"ref":"main"}'
```

`request` (API: `POST secrets/NAME/request`, MCP: `secret_request`) has the server make the call and write the value where `{{secret}}` stands; `{{secret:base64}}` gives its base64, and `{{basic:USER}}` the base64 of `USER:secret`; in the address each is escaped for where it stands. The call goes only to the hosts the secret is bound to (and only to public addresses, unless whoever runs the server opened a private network), redirects are not followed, and every use is in the audit log, with the address as the agent wrote it.

What the agent gets back is blanked: every form the value went out in (as is, in base64, inside the Basic base64), and each of those as an address, JSON or HTML would escape it, is replaced by `•••` in the answer's headers and body, before the body is cut at 1 MB. An answer that is not text (bytes, or in an encoding other than UTF-8) is not passed on at all: the agent gets its status, headers and size, and `body_omitted` saying why. The vault asks for compressed answers itself and undoes the compression, so an agent's `Accept-Encoding` is dropped.

That is what the vault can promise; the rest rests on the hosts a secret is bound to. A service that hands the value back changed in some other way (cut in pieces, reversed, hashed weakly, in another encoding) or that keeps it and shows it elsewhere gives it away, and the vault cannot see that. So an admin binds a secret only to services trusted with it, the way one would hand them the key directly, and prefers keys those services scope to the work at hand.

A request that can change something at the far end (any method but GET, HEAD and OPTIONS) is held as a change is: a member who may only read cannot send one, and an agent that asks before `secret.send` asks for exactly the request it will send, as it writes it: `{"name": NAME, "method": METHOD, "url": URL, "headers": {…}, "body": BODY}` (or `body_base64`), with `{{secret}}` left where it stands and empty parts left out; the refusal that asks for the approval gives these arguments. It then sends that request with `approval=DECISION_ID`. The approval covers that request and no other: a different body, or a header added or changed, needs its own.

For tools on the agent's own machine (git, a deploy script) a secret can be marked `env`. A companion holding a token made for secrets (`quadit admin token --secrets WORKSPACE @agent`, or `POST tokens {"user":"@agent","secrets":true}` as a signed-in admin) starts commands with it in their environment and blanks it out of what they print:

```
quadit run --secret GH_TOKEN -- git push
quadit listen --secret GH_TOKEN --exec ./wake-agent.sh
```

A process that has a secret in its environment can read it; mark a secret `env` only for machines you trust with it. The plain agent token cannot fetch values at all.

## Working for someone

A task a person gives to an agent records who (`asked_by`). Agents work on that task with no more access than that person has: if they lose access, agents are refused on the task until a person assigns it again. An agent that passes the task to another agent keeps the person it came from. For a change that is not about a task, name the person with `for`: `{"type": "project.create", "for": "@mia", …}`.

## MCP

For any MCP client: `https://your.server/mcp`, with a token in the `Authorization` header or by signing in through OAuth. When signing in, the person picks whom the client works as: choose an agent, so its work carries the agent's name. About twenty-five tools, for the work an agent does: who it is and what waits on it, finding and reading tasks, decisions, pages and databases, the feed and its cursors, any change (the `change` tool takes every change type), questions to people, files, secrets and pictures. The admin reads (`/list/…`, tokens, the audit log), imports, exports and backups are not tools: use the HTTP API or the command-line tool for those. Results are the compact text form. `change` takes one change or a list applied together, an `id` for safe retries and `for`; `upload` takes large files in parts; `render` answers with a picture. `ask` puts a question to a person in one call, as `quadit ask` does: `task`, `question`, `options` (each `{label, description, files}`), `files` on the question itself, `recommended` (number or label), `why`, `ask` (whom), and `id` for a safe resend. A file is the id of one stored first with `upload`, since the server cannot read the client's disk. With no options it is a yes or no, as `quadit approval` is (`action` and `args` for the exact change to approve). The full argument list of every change is in `GET /api/v1/changes` (the `changes` tool). Each tool's schema gives its arguments' real types (`dry_run` and the other flags are `true` or `false`, positions and limits whole numbers), and a call is held to that schema all the way down: a value of the wrong type, at the top or inside a list or object (an option's `label`, a change's `args`), is refused, never dropped, and so is a call without a required argument or field. `change`, `ask`, `remember` and `ack` take `dry_run`; a tool without it refuses one.

## Seeing what people see

`quadit render SVA-12 width=390` saves a picture of the task as it looks on a phone. Every uploaded image has a reduced copy and every clip a sheet of stills (`preview` in the file's details), so media can be looked at cheaply.
