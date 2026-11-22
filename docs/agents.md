# Connecting agents

An agent is a member of the workspace with its own account, role and token. People assign it tasks and mention it like anyone else. This page is what an agent, or the person setting one up, needs.

## Set up

1. In Settings → Agents, create the agent: name, handle, role (member or admin), the person responsible for it, and optionally which projects it may touch, which changes need approval, and how many times a week it may pass work on to another agent.
2. Issue it a token (an admin, or the person responsible for the agent). It is shown once.
3. Give the agent `QUADIT_URL` and `QUADIT_TOKEN`, or run `quadit login URL TOKEN` (`-` for the token reads it from standard input). Or let the desktop app do steps 2 to 4: see [Connect from the desktop app](#connect-from-the-desktop-app).
4. Teach the agent Quadit: `quadit skill install` (see [Your agent](#your-agent)).
5. Prove it reaches Quadit from inside its tool: on the agent's page in Settings, make a connect code and say the line it gives in the tool (`Connect to Quadit K7PQ2M`). See [Connected, and listening](#connected-and-listening).

## Your agent

Any coding agent works: Quadit needs nothing made for one in particular. An agent reaches Quadit in one of two ways, and one is enough:

- **The skill and the `quadit` command.** The skill (`integrations/skills/quadit/SKILL.md`, carried by the binary) teaches the agent the `quadit` commands this page describes; the agent runs them in its shell. `quadit skill install` writes it to `~/.agents/skills/quadit/`, where Codex, Cursor, Gemini CLI, GitHub Copilot, opencode and pi look, to `~/.gemini/config/skills/quadit/` on a computer that has Antigravity CLI, and to `~/.claude/skills/quadit/`, where Claude Code looks. Run it again after updating Quadit. `quadit skill install DIR` writes it into another skills folder instead, such as a project's `.agents/skills`.
- **MCP**, for an agent without a shell, or one that should not have the `quadit` command: the server at `https://your.server/mcp`, with the token as a bearer header (see [MCP](#mcp)). The agent's own settings say where the server is, and, for work nobody watches, that its tools may run without asking each time.

To wake an agent when something needs it, run `quadit listen --exec COMMAND`, with the agent's command that runs one prompt and exits; the inbox item is in `QUADIT_EVENT`:

```bash
#!/bin/sh
# wake.sh: one inbox item for the agent
exec codex exec "Quadit woke you for this inbox item: $QUADIT_EVENT. Handle it with the quadit skill, answering where you were asked."
```

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

**Disconnect** puts back what Connect changed, except where a file has been changed since (it is left as it is, and said), and revokes the token. An MCP sign-in is ended in the agent itself.

Connect is a page of the app laid over the workspace window (File → Connect Agents…, the Agents page, the button under a task's comment box). A tool it set up shows the line to say in it, `Connect to Quadit K7PQ2M`, until the agent gives the code back; then whether it listens.

### Connected, and listening

Files written are not proof that an agent reaches Quadit, and an agent that does reach it sees what is written to it only when it looks. So an agent is in one of three states, shown on a task given to it, under the comment box, on the Agents page and in Settings → Agents:

- **Not connected yet**: it has never proven it reached Quadit from inside its tool.
- **Connected, not listening**: it works when the person asks it in its tool; what is written in Quadit waits until then.
- **Listening**: a session of it is waiting for its inbox right now (or a webhook pushes to it), and answers what comes in.

An agent is connected by the first of: a connect code given back, a change made with its own token, its listener's first wait. Reading proves nothing: `quadit login` and `quadit me` do not connect it. The member row and `GET /agents` carry `connected_at`; `GET /agents/connection` is the cheap read of all three, with the tool of the last code the agent gave back, which pages read again while they show it.

A person's comment on a task reaches the inbox of the task's assignee and of whoever the task waits on, whether or not they follow it, so the line under the comment box, "@codex is listening and will see this", holds for both. An agent's comment reaches only those who follow the task, those it mentions, and whom it hands the task to, so two agents on one task do not keep answering each other.

**Connect codes.** A person who may make the agent a token makes a code for it and the tool it runs in: Settings → the agent → Connect code, the desktop app's Connect, or `POST /connect-codes {"agent": "@codex", "tool": "Codex"}`, which answers `{id, code, …}` with the code this once. It is six characters with no look-alikes, good once for seven days; a new code for the same agent and tool replaces the open one, and `GET /connect-codes/{id}` tells its maker whether it was used. Said in the tool, `Connect to Quadit K7PQ2M` has the agent run:

```bash
quadit connect K7PQ2M    # with its own login: "Connected as @codex in Personal." and what to tell the person
quadit connect           # with no code: who this login is
```

A wrong, used or expired code is refused saying which (`reason`: `wrong`, `used`, `expired`), ten tries a minute per agent; a person's login is refused, since an agent connects with its own. The code is taken in any case and with spaces or a dash in it, and a code for a tool replaces the open one of the same tool however its name is written. Connecting starts no wait.

**Listening.** Only when the person in the tool asks ("listen to Quadit"), the agent runs `quadit wait` again and again. How depends on where it runs, and the skill tells it to find out first:

- **In a chat with a person, in a tool that wakes the agent for a background command** (its shell can run a command in the background and hands the result back to the agent by itself; Claude Code and Antigravity CLI do): the agent runs `quadit wait for=3600` in the background, says it is listening, and goes on talking with the person while it waits. When an item comes it handles it and starts the next wait in the background. The chat stays free. Told to stop, it ends the background command, and the lease goes within thirty seconds.
- **In a chat with a person, in a tool that cannot** (Codex today: a background command's result reaches the agent only when the person writes again): listening keeps the chat busy. The agent says so first ("Listening keeps this chat busy until you stop me; use another chat to talk to me meanwhile.") and then waits in the foreground.
- **With nobody there** (a one-prompt run, a companion): it waits in the foreground, a little under the longest the tool lets one command run.

Before the first wait, an agent in a chat first asks `quadit listening` whether something already listens as it (a companion, the Quadit app): if so, it tells the person that Quadit is already answered for it, and does not listen from the chat. An agent whose `quadit` commands each ask the person for approval says so, and how to allow them: in the Quadit app, Connect agents, the tool's More options, "Let it use Quadit without asking each time", or the tool's own allow rule. From a chat that cannot be woken, the agent offers the person the two real choices: keep this chat busy, or a companion run in a terminal (`quadit listen --exec …` with the tool's one-prompt command; Ctrl-C stops it). `quadit help listen` says all of it.

```bash
quadit wait for=3600     # in the background: up to an hour, renewing the server's holds and the lease inside itself
quadit wait for=110      # in the foreground: blocks until the next inbox item, at most for= seconds (50 when left out)
```

It prints one record: `ITEM #SEQ KIND TASK-OR-PAGE from @WHO: "…"` (`from @WHO (agent)` for another agent's) with the commands to read it, to answer it where it was asked (`quadit reply THREAD "…" --id=…` or `quadit comment KEY "…" --id=…`), to acknowledge it once handled (`quadit ack SEQ listen lease=ID`) and to wait again (`quadit wait lease=ID`); or `IDLE` and the command to wait again. The answer's change id is made from the item's own id, the same every time, so an answer sent twice (two sessions handed the same item at a takeover, or one sent again after a crash) is made once. The agent runs those lines as written, so `wait` prints nothing the server sent unless it has the form quadit gives it (a lease id, a task key, a page id, a handle), and the item's words in quotes, cut at 200 characters, without line breaks or quotes of their own.

The rule of the lease:

- One session of an agent delivers its inbox at a time: the one holding the agent's lease. It says what it is when it takes it (`quadit wait`: "a chat"; `quadit listen`: "a companion", or what `by=` says; the Quadit app: "the Quadit app"), and `quadit listening` (`GET /listening`) tells whether, what and since when something listens, without taking the lease. Only `GET /listen` takes it (`quadit wait`, and `quadit listen` whatever its cursor); the first wait takes it, and the commands it prints carry its id. Another session's wait is refused, "@codex is already listening from another session (last heard 14:02 UTC)", until the person has it take over with `quadit wait take=1`. A wait that slept through a takeover hands nothing over.
- The agent counts as listening while the lease lives: five minutes past the end of its holder's last wait whose answer went out, so it does not flicker while the agent handles an item; thirty seconds past a wait its client gave up on (the agent was stopped); and a lease taken by a wait whose answer did not go out, whose id nobody learned, ends at once.
- An acknowledgment that gives a lease (`PUT /cursors/listen {"seq", "lease"}`) is made only while that lease is the live one: one taken over since (`reason` `lease_stale`) or run out (`lease_ended`; the item comes again) is refused. One that gives none is made as before: a `quadit listen` from before the lease acknowledges so, and so does a person giving up on an item by hand.
- Only an acknowledgment moves the cursor: a wait with nothing for the agent leaves it where it was. A cursor never moved starts at the oldest unread item of the agent's whole inbox of the last day (whatever projects the waiting login is kept to), else at the present, so the comment written a minute before "listen to Quadit" is handled and weeks of history are not replayed; the first answer says how many older unread items were left alone (`quadit inbox` lists them).
- A `quadit listen` from before the lease keeps working: its waits on the feed with `cursor=listen` take no lease, and count as listening while they are held.

The API is `GET /listen?wait=50&lease=ID` (`take=1` to take over, `cursor=NAME` for another cursor), answering `{lease}` or `{lease, seq, item, line}`, and `skipped` the first time. `for=` should be a little under the longest the tool lets one command run.

Each tool, as `scripts/agent-listen-check.sh TOOL` finds it (a throwaway server, the skill under test given to the tool in its own project folder, ordinary words: "Connect to Quadit CODE", then "Listen to Quadit", a stretch with nothing arriving, two comments answered exactly once each, a second session refused, nothing answered after stop; and for a tool that can be woken, a chat with a person in which the wait runs in the background while the person's question is answered and a comment still is). It spends the person's plan, so it is run by hand.

**When the app is quit.** A server on this computer runs only while the desktop app does. When the app is quit and an agent runs `quadit` with a login the app made for that server (`quadit login URL - --app PATH`), the command finds nothing listening at this computer's address, starts the app without a window (on macOS by its bundle id, unless it is running already; on Linux by the path the login records, without a shell), waits up to 20 seconds for the server, says `Quadit was not running; started it.` on stderr and sends the request again, once per run. If that fails, the error ends `Quadit could not be started: open the Quadit app.` (or, with the app running and its server silent, `Quadit is running but its server does not answer: look at the Quadit menu.`). A server the person stopped from the app's menu stays stopped: the app keeps a file `server-stopped` beside its logins while it is, and the error says `Quadit's server is stopped: start it from the Quadit menu.` A login made by hand, a server elsewhere, a timeout, Windows, and a command kept off the network (Codex's sandbox) start nothing. The request is sent again only once Quadit answers there (its `/api/v1/version`), and a file going up is not sent twice: the command says `Quadit was not running; started it. Run the command again.` The app is started only from a login file of the person's own that nobody else may write, and on Linux only an app path that is a full path to a program only its owner may change; on macOS `open` and `lsappinfo` are run by their full paths.

| Tool | Connect and listen | Idle cost |
| --- | --- | --- |
| Claude Code | verified on 2026-11-21 with 2.1.330 | not reported by the tool |
| Codex | verified on 2026-11-21 with codex-cli 0.170.0 | not reported by the tool |
| Antigravity CLI | verified on 2026-11-21 with 1.5.14 | not reported by the tool |
| Gemini CLI | not verified yet | |
| Cursor | not verified yet | |
| GitHub Copilot CLI | not verified yet | |
| opencode | not verified yet | |
| pi | not verified yet | |

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
| Narrow | `mine=1` (tasks you are assigned, mentioned in or watch), `others=1` (not your own changes), `task=SVA-12`, `types=decision.picked`, or any task filter |
| Inbox only | `inbox=1`: assignments, mentions, answers to your questions, replies |
| Push | A webhook "for" the agent gets its inbox items as signed POSTs, in order, retried until they arrive. The server calls public addresses only; one on its own machine or network needs `--allow-private-networks` ([install](install.md#addresses-users-give)) |
| Listen in a session | `quadit wait`, again and again, in the agent's own session when the person asks it to listen: one inbox item at a time, with the commands to go on ([Connected, and listening](#connected-and-listening)) |
| Companion | `quadit listen --exec ./wake.sh` holds the wait for you and runs a command for each inbox item: for agents with nothing running |
| Live stream | `GET /events/stream`: server-sent events |

Rules in Settings → Automation add wake-ups such as "when a person answers a decision, tell @coordinator".

`quadit listen` delivers each inbox item at least once, one at a time, in order. Its cursor (`listen`, or the one named with `cursor=NAME`) moves past an item only after the command exited with 0. When the item's secrets cannot be had, or the command fails, listen says so, waits (1 second, doubling up to 5 minutes) and runs it again; the items after it wait for it. So the command must be safe to run twice for the same item: a crash, or a failure after part of the work was done, brings the item back. To give up on an item instead, move the cursor past it with the command listen prints when it says the item was not handled: `quadit ack SEQ listen lease=ID`. Listen holds the agent's lease like `quadit wait`, so only one of them delivers the inbox at a time; it stops when another session takes the lease over (`take=1` takes it over), and keeps the lease's id beside its login file, locked while it runs, so a listen stopped or restarted goes on with the lease it held, and a second listen on the same login is refused ("another quadit listen is running with this login").

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

People comment on words of a page (the text they select), on a block, or on the page as a whole, and answer each other in a thread. Asked something there, you get an inbox item (`mentioned`, or `replied` when someone answers in a thread you wrote in) whose line ends with what you need to answer:

```
#1207 11-16 10:42 @mia mentioned: Boss fight — @coder is this still three phases?  (page PAGE_ID, comment COMMENT_ID, thread THREAD_ID, on "The boss has three phases.")
```

`quadit listen` hands the same line to its command in `QUADIT_EVENT`. Then:

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

`comments=0` leaves the threads out; `format=md` is the page alone, as `write` takes it back. Whoever wrote in a thread is told of each reply in it. Resolve a thread once the question in it is settled, not to hide one you disagree with. `reply` works on a task's comments too: `quadit show KEY` gives each comment's `id=`.

A page that mirrors a Markdown file in a repository is called by the file's opening `# heading` (else by its file name) and does not repeat it in its text; written back, the title is the heading again. Renaming the page changes the heading, not the file name.

## Session records and hand-off limits

Record a run so people can see what you did: change `session.start {"task": "SVA-12", "title": "…"}`, then `session.update` with `add_steps`, `add_links` and at the end `state: "done"`. A session is the log of a run (what it was asked, what it did, what it produced, when it started and ended); Quadit keeps no record of what a run cost.

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
