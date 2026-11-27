# Changelog

What changed in each release of Quadit, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Quadit follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Each [GitHub release](https://github.com/agrigoryan/quadit/releases) also lists its commits.

## [Unreleased]

## [0.9.0] - 2026-11-27

The server upgrades its database when it starts (migrations 0031 and 0032), copying it first; `quadit upgrade --undo` goes back ([upgrades](docs/install.md#upgrades)). It changes the feed's older events: an estimate cleared, or set where there was none, said that none as 0, and now says it as `null`, as the feed does from this version on. And a comment deleted before no longer mentions what its text named: a task stops listing a page only that comment named.

### Added

- Estimates as Linear has them. A project that estimates picks a scale in its settings: Fibonacci (1, 2, 3, 5, 8), Exponential (1, 2, 4, 8, 16), Linear (1 to 5), T-shirt sizes (XS, S, M, L, XL, which count 1, 2, 3, 5 and 8 points) or any whole number; the extended scale adds two more values (13 and 21, 32 and 64, 6 and 7, XXL and XXXL). Turning estimates on starts on Fibonacci. A task's estimate is then one of the scale's values, and anything else is refused with the values in the project's words ("this project estimates in 1, 2, 3, 5 or 8 points"); estimates already stored stay when the scale changes. The project settings are `estimate_scale`, `estimate_extended`, `estimate_zero` and `estimate_ignore_unestimated`.
- Zero estimates: where a project allows them, 0 is an estimate of its own, apart from none (`"estimate": 0` on the task; no `estimate` is none, and `null` clears it). Elsewhere a 0 sent clears the estimate, as before. On `task.create`, an estimate left out is the template's, applied as it is (a template may keep an explicit 0), or none without one; `null` is none, whatever the template says.
- An estimate may be given as a T-shirt size in any change (`"estimate": "M"`, `quadit update SVA-12 estimate=M`); it stands for its number of points on every project, and answers always carry the number. A number written as text is digits only (`"5"`, not `"+5"`). `quadit … estimate=none` clears one.
- Tasks are asked for by estimate: `estimate=5,8`, `estimate=M` or `estimate=none`, in the task list, the feed, saved views, `quadit tasks` and the MCP `tasks` tool.
- `quadit layout KEY` (and `GET /projects/{key}/layout`) says what estimates the project takes and what a 0 does there, and the text for agents says a task's estimate with its unit: `estimate: 3 points`, `estimate: M (3 points)` on a T-shirt project, and `estimate: 0 points` for a zero estimate.
- A page is linked in a comment, a description, a result or a decision as `[Title](doc:PAGE_ID)`, and the web app shows it, like `doc:PAGE_ID`, `[[Title]]` and a link to the page's address, as the page: its icon and its title as it is now, opening it in one click; one the reader may not see, or in the trash, stays its written words. Typing `[[` in any box that offers `@` offers the pages by title, and writes the link. `quadit write new` prints the link to the page it made, and the text agents read follows a page named by id with its title (`doc:ID ("Title")`).
- `quadit show KEY` lists every page the task and a page point at each other through, each once, as the context pack does: one linked, one mentioned in the task's text or comments, one that mentions the task. The task's JSON has them as `pages`.
- The Linear import reads an estimate that is a T-shirt size, and an import keeps every estimate as it was there, on the project's scale or not (`task.create`'s `keep_estimate`, for admins, who alone import).

### Changed

- Every date in the web app (a task's due date, a cycle's, an epic's and a milestone's, the audit log's and a database's) is picked in a date picker of the app's own, in place of the browser's: type a day in words ("fri", "next week", "in 3 days", "dec 5"), pick one of the days offered (today, tomorrow, the end of the week, next week, in two weeks, and the end of the cycle or the epic's target where there is one), or pick it in the month, where today and the current cycle's days are marked.
- Points follow Linear's rule everywhere they are added up (a cycle's chart, an epic's progress): a task counts its estimate, and a task without one counts 1 point, or 0 where the project's settings say so. In a project that already had estimates on, its tasks without an estimate now count 1 each, so its cycles' and epics' points go up. A project that does not estimate counts each task as 1. An epic's progress has `points` and `points_done`, 0 included, when one of its tasks is in a project that estimates, and neither otherwise.

### Fixed

- A comment on a private page told a member it mentioned, or one who followed the page, of the comment and the page's title, even when the page was not shared with them. Only those who may see the page are told now.
- A deleted comment went on mentioning what its text named: a task listed a page only that comment named, and a page listed the task. Deleting a comment takes its mentions away, and the upgrade takes away those of comments deleted before.
- A task's `links` (`quadit show KEY --json`, the MCP `task` tool) named a linked page that was in the trash, with its title; it is left out now, as it is of the task's pages.

## [0.8.0] - 2026-11-26

Windows support is new in this release. It was checked by automated tests on Windows: the server's and the command's tests, the desktop app's, and the app end to end (set up on this computer, Connect, and a run Quadit starts), with stand-in agents. Nobody has run it on a person's own Windows computer yet, the real Claude Code and Codex were not run on Windows, and the Windows installer is not signed, so SmartScreen warns when it is opened.

### Added

- The server and the `quadit` command run on Windows 10 and 11. Each release has `quadit_windows_amd64.zip` and `quadit_windows_arm64.zip`, with `quadit.exe` inside; there is no install script, Homebrew or package for Windows. Login files are kept in `%APPDATA%\quadit\`, each kept to its owner by its access list. With the app quit, a login the app made starts it by the path the login records, as on Linux. Pictures of pages use Chrome where its installer puts it, else Edge.
- The desktop app does on Windows what it does on macOS and Linux. Set up on this computer runs the `quadit.exe` the app carries, with its data in `%APPDATA%\Quadit\server`. Connect puts `quadit` on the PATH by adding the folder of the app's `quadit.exe` to the person's own PATH (`HKEY_CURRENT_USER\Environment`), shown in the plan and taken out by Disconnect; a terminal opened afterwards finds it, and nothing needs an administrator. It offers Claude Code, Codex, Gemini CLI, Cursor, pi and GitHub Copilot CLI there, and allows Claude Code `PowerShell(quadit *)` besides `Bash(quadit:*)`. Run by Quadit and `quadit run` work there for Claude Code and Codex.
- What differs on Windows. Antigravity CLI and opencode are not offered yet, since where they keep their settings there is not confirmed; their cards say so. Only agents installed for Windows are found: an agent inside WSL is not, and someone who works inside WSL installs the Linux `quadit` there and runs everything inside WSL. Stop ends a run at once, with everything the program started, since Windows has no way to ask Claude Code or Codex to stop first. `quadit run` also refuses a whole drive (`D:\`) and Windows' system folders, refuses a program installed as a `.cmd` file (as npm installs Claude Code and Codex) in a network folder (`\\server\share\…`) and says what to do instead (the program's own `.exe`, or a drive letter mapped to the share), and does not start a `.cmd` program whose path, or the path of the runner's files, holds a `%`. The computer is kept from idle sleep during a run, as on macOS. Continue in a terminal on a run on Windows is a line for PowerShell.
- The skill gives a companion's command for PowerShell on Windows, which hands the item to the agent's program on its standard input, not in its arguments.

### Fixed

- When the disk was slow, the last lines a program wrote before its run ended could be lost; if one of them showed that the agent had begun work, the run could be started again from the beginning.
- In the desktop app's list of servers, the question that asks before a server is removed could vanish when the list was drawn again, and keyboard focus was lost then; both are kept now.
- Webhooks: a webhook with many events to receive held up the others, since each delivery was a write of its own; a batch of events handled again (after a wake-up could not be queued, or when the server stopped before it recorded how far it got) sent deliveries already made a second time. Both are fixed, and a webhook hears its events in order.
- The runner's `status.json` is no longer forced to the disk at every change.

## [0.7.0] - 2026-11-24

The server upgrades its database when it starts (migrations 0026 to 0030), copying it first; `quadit upgrade --undo` goes back ([upgrades](docs/install.md#upgrades)). What the upgrade changes in your data is said with each change below: agents' follows of tasks, epics and pages end, the inbox items of questions already answered or taken back are read, and the questions and waits left on done and canceled tasks are settled.

### Added

- Quadit runs the agent for a task, for Claude Code and Codex, on macOS and Linux. `quadit run` on a person's computer holds one agent's listener of one project for each entry of its registry (`runner.json`, beside the login files) and, for each inbox item from the agent's responsible person or that person's other agents, starts the program in the project's folder with full access, gives it the items on standard input, and records the run on the task. Later items of the task go on in the same program session, and each prompt names the agent's responsible person as the server has it then; an item that comes during a run becomes the next run; one run at a time in a folder. `quadit run add`, `remove`, `list` and `machine` keep the registry (`add` checks the login, the project, the folder and the program); `quadit run --secret …` is unchanged. A runner whose server does not answer yet, as when the app starts both, tries again within seconds and says the server is not answering.
- Guards for runs: one run per folder; a program that prints nothing for 30 minutes of awake time is stopped, and `max_minutes=` limits a run's time; at most 4 runs started by agents per task and 12 per entry in an hour; runs started by agents on a task held after two that changed nothing on it; a usage limit pauses every entry of the agent on the computer until it resets, and a signed-out program pauses its entry until it is signed in, and the item runs again after; a failure is tried again only before the program did any work. A run's states, its end, its comment and its acknowledgment are kept on the computer until the server takes them, so a crash or a server away loses none of them and starts nothing twice; steps not yet kept when the runner crashes are lost.
- The server decides which inbox items start a run: an assignment, a mention on a task, a hand-off, a question asked of the agent, an answer to its question, a reply in its thread, or a comment for it, when its author is the agent's responsible person or one of their agents. Only a change its author applied in person starts one: an item made by a rule, or written in someone's name by a sync with GitHub or a repository, a saved view's news or a job, never does, nor a status change, nor a comment the agent hears only because it follows the task. A helper agent counts as the owner's only when the owner, or one of the owner's agents, made it. Another member's item is recorded on the task as Not started, saying why. `GET /listen` gives each item's `wake` (`run`, `ack` or `refuse`, and why); inbox items carry `addressed`, and an item about a decision its id (`item.decision`, also on `/inbox` and `/my-work`).
- A task's Agent sessions show each run with its computer and its state (Waiting, Working, Done, Waiting for an answer, Failed, Stopped, Not started), and, for a run that waits, did not start or failed, why and what to do. An opened run says under Started by what started it as a person would (`@ann commented: "check this out"`) and under What it did: the agent's own short messages on the way, its tools with the program's description of each call, and commands that say nothing folded into one line ("Ran 5 commands"); never a command line, and never a step as JSON. Any member who may change the task can stop a run (`session.stop`), on the task or from the desktop app's menu-bar panel. On the newest ended run, the agent's responsible person can copy the command that continues its session in a terminal on that computer.
- Under the comment box, for each agent the draft reaches that a computer runs, the line says what will happen: it starts now on that computer, it comes next in the same session (the agent works on this task now), it is queued, it starts when the computer is back, it is paused and why, or it will not start and why. The assignee picker says it in a few words. `GET /tasks/{key}/run-outlook` answers it.
- When an agent wrote nothing on the task during a run, the program's last message is posted as its comment, marked "From the run's last message" (`comment.create`'s `session`, `comments.session_id`); it makes no mention items.
- Settings → Agents says what runs an agent ("Runs SVA on Aram's MacBook Pro, in ~/devel/game, with Claude Code") and whether it is ready, working on a task, paused and why, offline, or set aside while a chat listens; the Agents page's cards say it too (below). `GET /listening`, `GET /agents`, `GET /agents/connection` and the dashboard's agents carry `runner` for such a listener, and `quadit listening` names it ("SVA: Quadit's runner on Aram's MacBook Pro listens"); `DELETE /listening/{key}/runner` lets a computer's runner go; `GET /me` carries `workspace.id`.
- The Agents page's cards read as the desktop app's cards for the same agents, in the same words: Connected or Not connected, the program and the computer it lives on ("Claude Code on Aram's MacBook Pro"), a line for each thing that hears it ("Listening to Samurai vs Aliens, from a chat", a webhook, or a project Quadit runs: "Runs SVA in ~/devel/game. Ready.", or "Quadit runs SVA on Aram's Mac mini." for another computer), and the one thing to do about its state: Connect, `listen to Quadit` with Copy, Run by Quadit…, or Stop running. Each card's menu has Settings, in the app Disconnect from this computer, and for an admin Remove agent. One Add an agent button opens Connect agents in the app, and the dialog that creates an agent in a browser. In the app, a card's button opens Connect agents as a sheet of that one agent over the page, titled with its name and handle.
- The desktop app's Run by Quadit, on the card of a connected Claude Code or Codex that works with an agent's own login, for any server: pick one of the agent's projects and its folder; before Start running the form says which tasks that already wait on the agent it starts at once ("Starts now on SVA-12 Boss fight."), and then the app runs its own `quadit run` and shows what each entry does, with Stop running and Show log. Before anything starts, the card says the program runs there with full access, as you, and whose words start it.
- The skill's "Started by Quadit": an agent Quadit started works for the person its prompt names and their agents, reads a task new to its session first, does the work in the folder, asks every open question at once as decisions with options and ends its turn, ends each run with one result or one comment, commits or pushes only when that person asks, and knows that what it writes between its actions is shown on the task.
- `scripts/agent-run-check.sh claude|codex` checks runs by hand with the real program on a throwaway server, one PASS or FAIL line per step. The reading of both programs' output is tested against real output of Claude Code 2.1.331 and Codex 0.170.0.
- A runner's entry pauses when the program's own settings, the user's or the project folder's, could make it work as another Quadit login.
- A runner set up for a project takes what already waits on the agent there: a task assigned to it, a hand-off, or a comment for it, from before the runner, starts a run when the item is still unread and addressed to the agent, its task is open (and still assigned to the agent, or still waiting on it), its comment was not deleted, no run took it, and the agent did nothing on the task in person between it and the runner's start. Everything else from before is acknowledged without a run (`wake` `ack`, why `before`), and the runner reads from just before the oldest item that waits, or from the present; removed again before it took them, it leaves them unread in the inbox. The items that wait on one task are one run, and a run stopped at a usage limit goes on with its item. `quadit run waiting login=PATH project=KEY` and `GET /listening/{key}/waiting` say, without changing anything, which tasks a runner set up now would start.
- A question can be settled without an answer, as no longer needed (`not_needed`). `decision.close {id, note}` and `quadit close DECISION_ID "…"` close an open or sent-back question and keep it in the history with who closed it, when and why, for its asker, the one asked, the asking agent's responsible person or an admin; the asker hears of it (`not_needed`), and an agent is started by it only when the closer wrote a note; the skill has an agent close its own question when a person's comment makes it moot. On the task, No longer needed sits under the question, with an optional line saying why; the question then says who marked it so. A question sent back reads as waiting on its asker ("Waiting on @iris to ask again or carry on.").
- A task that waits on you, with no question on it asked of you, says so at its top: who handed it to you and what they said, with Looks good (it stops waiting on you, then offers to mark the task done), Reply (opens the comment box, set to hand the task back to whoever handed it to you) and Not waiting on me (it only stops waiting on you).
- The inbox has two tabs: Needs you, for what was meant for you (you were asked, assigned, handed the task, mentioned or replied to, or the comment was on your own task), and Updates, for what you hear because you follow something. Each tab has its own Mark all read, which marks the whole tab. The sidebar's number counts only the unread items that need you, with a dot for unread updates. A task or a page shown on screen for a second marks your unread items about it read; flipping through a list marks nothing. Inbox items made before this version, of the types made only for their member (assigned, mentioned, handed, asked, answered, found unclear, replied to), count as addressed.

### Changed

- Acting on something reads its inbox items. A comment, a reply, a result or an answer a member posts on a task marks read their own unread items of that task from before it, for people and agents alike (only a write made in person: not one a rule, a sync or a job makes in their name). A question answered or taken back marks read the items that asked it (`decision_asked`, `unclear`); the asker's item of the answer stays unread. The page hears it as it hears `notification.read`. Undoing the comment or the answer does not make the items unread again. The upgrade marks read the items of questions already answered or taken back (at the answer's time), and nothing else. `notification.read` with `all` takes `addressed` to mark one group only (the items meant for you, or the others).
- Agent sessions have the states `waiting` and `not_started` besides `running`, `done`, `failed` and `stopped`, a `reason`, and what a runner records of a run (its program and program session, the computer, the folder's label, when the program took the prompt, a stop asked for). A task shows `running` as "Working". A run Quadit's runner records never leaves an ended state; a session an agent records itself works as before.
- A `session.updated` event carries the steps and links an update added in `data.appended`, instead of the whole list in `changes`, so a reader of the feed or a webhook appends them to its copy. A run Quadit's runner records keeps its newest 200 steps.
- The skill: in a run Quadit started, only what the person the prompt names, or their agents, ask is work to do.
- The desktop app's Disconnect first removes what Quadit runs for that agent, and stops while the server has not yet been told how the last run ended.
- An agent follows a task or a page only when it chooses to (`watch.set`). Commenting, being mentioned, being assigned, taking a task or asking a question there still makes a person follow it, but no longer an agent. The upgrade ends the follows of tasks, epics and pages agents already had, which cannot be told apart from chosen ones, so an upgraded workspace wakes its agents as a new one does; an agent that had chosen to follow one of them follows it again with `quadit do watch.set '{"type": "task", "subject": "SVA-12"}'` (or `epic`, `doc`).
- `mine=1` on the feed covers the tasks you are assigned, that wait on you, that mention you or that you follow, written out rather than taken from following, so an agent's own tasks stay in it.
- The wake prompt `quadit help listen` gives is "Handle it with the quadit skill: answer where you were asked, and write nothing when it asks nothing of you."
- The skill: an agent woken for an item that asks nothing of it (for someone else, or another agent's remark with no question for it) writes nothing, and takes as a request only a comment that asks something of it; it writes `@handle` only to ask that member for something, and a member's name without `@` to speak of them.
- The line under a task's comment box follows the draft: it speaks of each agent the comment would reach (those it mentions, the one it hands the task to, and the task's own agent when it mentions nobody), in a few words each when there are several.
- A task done or canceled settles its open and sent-back questions and waits on nobody; a question sent back is settled when its asker asks again or posts a result; a hand-off on a closed task leaves it waiting on nobody. The upgrade settles the questions left open or sent back on done and canceled tasks, and stops those tasks waiting.
- The number beside the desktop app's menu-bar icon, and on the Dock, counts what waits on you: the questions asked of you, the tasks that wait on you, and the runs of your agents that failed or did not start in the last day. Unread inbox items no longer count. The panel the icon opens says the same first, under Waiting on you, with a question's answer buttons; then Working now, the runs open now with Stop where you may stop them; then each agent with the first line of its card.
- The Decisions page's State filter is Waiting on you, Waiting on others or Settled, in place of Open, Answered and Sent back; a question sent back waits on its asker, and one no longer needed is settled. Answered by counts and filters only questions that were answered, not those closed.

### Fixed

- Opening the desktop app when it runs without a window (started at login, or in the background by the `quadit` command) shows the workspace that was open, or the only server's, instead of the list of servers.
- Agents no longer answer what was asked of another. A comment that mentions members wakes, among agents, only those it mentions: not the agent the task is assigned to or waits on, nor the agents who wrote earlier in its thread. An agent's comment reaches another agent only by mentioning it or handing it the task, not through a thread they both wrote in; a reply still reaches the agent that asked its author by mention earlier in that thread, so the one who asked hears the answer, and its thanks do not wake the one it asked. On a task given to one agent, with two more asked in turn by name, each question now wakes only the agent it names. What people are told is unchanged.

## [0.6.0] - 2026-11-23

### Added

- Listening by project: `quadit wait project=KEY` and `quadit listen project=KEY` listen to one project, and the lines `wait` prints keep it. One session listens to each project at a time, and one to everything else; a project once listened to by itself keeps its items for its next listener instead of handing them to everything, until `quadit listening forget project=KEY` (`DELETE /listening/{key}`) gives them back. `quadit listening` says what listens to each project and what everything leaves out; against an older server, a wait with `project=` stops and says to listen without it.
- `GET /agents/connection`, `GET /agents` and the dashboard's agents carry `listeners` (`[{project_id, project, by, last_heard, live}]`), `listening_projects` and `listening_outside_projects`.
- The skill picks what a chat listens to: the project the person named, else the one the repository's instruction file for agents names, else everything when the agent has one project or none, else it asks once, with everything as a choice.

### Changed

- Where a place is about one project, listening means listening to that project: under a task's comment box an agent that listens only to other projects says so, with “listen to Quadit for KEY”, and a not-listening agent's line names the project when the agent may work in several (with one, plain “listen to Quadit” has it listen to everything); a task's assignee and waiting-on pickers mark who listens to its project. The Agents page, an agent's page in Settings and the app's cards say what each listener listens to and from what ("Listening to Samurai vs Aliens, from a chat"), a webhook that pushes, and, in Settings, a project whose listener stopped and whose items wait.
- A listening card in the app says how what listens stops (a chat when told, a companion with Ctrl-C) and how to add another project; the steps above the cards say the agent asks which project when it cannot tell.
- The desktop app no longer starts connected agents by itself to answer what comes in: an agent answers what is written in Quadit from a chat told to listen ("listen to Quadit"). Connect still proves the connection by itself, running the agent's program once to give its connect code back for the server on this computer; the plan says so where that run has its checks off.
- Connect agents and the first run's tools step say the two steps above the cards: connect an agent here, then write `listen to Quadit` in its chat, in your project's folder, the recommended way; without listening it sees what waits when asked in a chat ("check Quadit"). Connect agents also names the other ways: MCP (under More options), which cannot listen, a companion command, and a webhook.
- A connected card that is not listening shows the line to write, `listen to Quadit`, with Copy, as its main step, and how its chat listens: in the background for Claude Code and Antigravity CLI, keeping the chat busy for Codex. Listening, it says what the agent answers, that one chat listens to a project (or to everything) at a time, and how to stop it. An agent connected by MCP alone says it cannot listen.
- Under a task's comment box, in the Agents page and in Settings → Agents, an agent that is connected and not listening names the line that has it listen.
- What people read says the agent's name, or "agent", instead of "a tool"; "AI tools" is kept for the programs found on the computer. A connect code's field is "Runs in".
- The folded sidebar takes the page's colour and has no line between it and the page; the colour and the line fade with the width as it folds and opens.

## [0.5.0] - 2026-11-23

### Added

- A text file among a task's, a comment's or a question's files opens in the viewer instead of downloading, one after another with the pictures and videos: Markdown rendered by the renderer comments use (raw HTML in it shown as text, javascript: links emptied), with Rendered and Source, and as its source when it is over 100,000 characters; logs, JSON, CSV, YAML, XML, source code and anything served as text as written, wrapped; an HTML or SVG file as its source, never drawn. Up to the first 1 MB is shown, and the viewer says when it cut the rest; text is read as UTF-8, or as UTF-16 when it starts with its byte-order mark; a file whose bytes are not text says it cannot be shown. The viewer names the file and always has Download, pictures and videos included.
- `quadit listening` (`GET /listening`) says whether something listens as you, what, and when it was last heard, without taking the lease. A listener says what it is when it takes the lease ("a chat", "a companion", or what `quadit listen by=` says), and a session refused because another listens is told what does.
- `quadit listen` takes `limit=SECONDS` (a longer run is killed, with what it started), `tries=N` (an item whose runs keep failing is given up, and stays unread in the inbox) and `events=PATH` (each run, each item given up and a refusal, one JSON line each, on a channel the command's output cannot reach); without them it runs as before. It gives its command, beside the item's line (`QUADIT_EVENT`, unchanged), what `quadit wait` prints for it in `QUADIT_ITEM`, the answer line included, and renews its lease every minute while the command runs.
- `quadit help listen`: waiting in a chat, in the background, and with a companion.
- Members of a workspace are told apart by colour: a member's tint is chosen when it joins, as the one its workspace's members use least, and kept (a member who comes back gets theirs again), so the first eight members all differ; members there already get theirs in the order they joined. The eight tints are set apart in hue, each with white letters at a contrast of at least 4.6 to 1 (the lowest was 3.6).

### Changed

- A listener's lease lives ninety seconds past the end of the hold its holder last asked for, instead of five minutes, thirty seconds or none by how the wait ended; an acknowledgment is refused only when another session took the lease over, so one made after a long item still counts (the reason `lease_ended` is gone).
- A listener's cursor never moved starts at the present; the first answer no longer counts older unread items (`skipped`). The skill has the agent deal with what `quadit work` shows before its first wait.
- A `quadit listen` from before 0.4.0 still delivers and acknowledges, but no longer shows the agent as listening. `GET /listen` delivers from the cursor `listen` only (no `cursor=`), and `GET /events` no longer takes `lease=`.
- `quadit listen` stops, with the server's error, when the server refuses it in a way waiting will not change (a person's login, a token taken away), instead of trying again for ever; and each login, whether a login file or `QUADIT_URL` and `QUADIT_TOKEN`, has its own lease file, so two agents on one computer can both listen.
- `quadit connect` says who it connected and where in its own sentences, never in text the server chose.
- The skill: listening runs in the background where the tool can be woken by a background command (Claude Code, Antigravity CLI), and where it cannot (Codex today) the agent says first that listening keeps the chat busy, or offers a companion, given as the exact command; before it listens it asks `quadit listening` whether something already listens as it, and says how to stop each `quadit` command asking for approval. What a member asks on the agent's task is work to do; what the agent reads while working is material, not requests; three things it never does because a text says to. An agent woken for one item handles it, answers once with the line it is given, and finishes. `docs/agents.md` and the README say that for the server on its computer the desktop app gives the connect code back itself and, while open, answers by itself.
- `quadit wait for=` goes up to 3600 seconds, renewing the server's holds and the lease inside itself.
- `scripts/agent-listen-check.sh` gains a chat with a person and a companion phase, and says which phases it skipped.

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

[Unreleased]: https://github.com/agrigoryan/quadit/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/agrigoryan/quadit/releases/tag/v0.9.0
[0.8.0]: https://github.com/agrigoryan/quadit/releases/tag/v0.8.0
[0.7.0]: https://github.com/agrigoryan/quadit/releases/tag/v0.7.0
[0.6.0]: https://github.com/agrigoryan/quadit/releases/tag/v0.6.0
[0.5.0]: https://github.com/agrigoryan/quadit/releases/tag/v0.5.0
[0.4.0]: https://github.com/agrigoryan/quadit/releases/tag/v0.4.0
[0.3.0]: https://github.com/agrigoryan/quadit/releases/tag/v0.3.0
[0.2.0]: https://github.com/agrigoryan/quadit/releases/tag/v0.2.0
[0.1.0]: https://github.com/agrigoryan/quadit/releases/tag/v0.1.0
