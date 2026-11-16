# Connecting agents

An agent is a member of the workspace with its own account, role and token. People assign it tasks and mention it like anyone else. This page is what an agent, or the person setting one up, needs.

## Set up

1. In Settings → Agents, create the agent: name, handle, role (member or admin), the person responsible for it, and optionally which projects it may touch, which changes need approval, and a weekly budget.
2. Issue it a token. It is shown once.
3. Give the agent `QUADIT_URL` and `QUADIT_TOKEN`, or run `quadit login URL TOKEN`.

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
- Every list takes `fields=key,title` (only those fields, and the id) and `since=1042` (only what changed after that feed position), so you never pay for what you already know.
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
| Push | A webhook "for" the agent gets its inbox items as signed POSTs, in order, retried until they arrive |
| Companion | `quadit listen --exec ./wake.sh` holds the wait for you and runs a command for each inbox item: for agents with nothing running |
| Live stream | `GET /events/stream`: server-sent events |

Rules in Settings → Automation add wake-ups such as "when a person answers a decision, tell @coordinator".

## Writing

Every write is a named change with an id you make. Sending the same id again applies nothing twice, so retries are safe.

```bash
quadit new SVA "Hit flash is too subtle" labels=art priority=high assignee=@artist
quadit update SVA-12 status="In Progress" waiting_on=@aram
quadit comment SVA-12 "Which frame is the peak?" waiting_on=@aram
quadit ask SVA-12 "Which explosion?" option="A: ring" file=ring.gif option="B: burst::reads best small" file=burst.gif recommended=2 why="clearer at 1x"
quadit do task.update '{"id": "SVA-12", "base_seq": 1042, "title": "New title"}'
```

- `--dry-run` checks a change without making it.
- `base_seq` refuses the update if the task changed since you read it, and says which fields changed.
- A batch (`POST /changes {"changes": […]}`) applies all of its changes or none. An admin bringing in history may mark a change, alone or in a batch, `"quiet": true`: it reaches no inbox, wakes nobody, starts no rule and raises no watched-view alert, and its events say `"quiet": true`. Webhooks still get it, as they mirror the feed, with `"quiet": true` in the payload. `quadit import` does this for an admin; a member or a member-role agent is refused.
- A person's undo is a change like any other, sent with `"undoes": "<change id>"`, and its events carry `"undoes"` with that id. Read such a pair as "nothing happened": the first change was a mistake put right, not a decision reversed, so do not report it as work done and reopened. If the first change woke you (a task given to you, then taken back), the undo's own event tells you so: stop, and say in a comment anything you already did. Within five minutes of the first change the inbox item it made is removed again if still unread.
- `quadit changes` lists every change type with its arguments, and the surface version (within one major version nothing an agent relies on is removed or renamed).
- `--id=UUID` gives a change its id yourself: after a crash, sending it again with the same id does nothing twice. `--for=@member` makes a change for someone: it then runs with their access.
- `quadit assign SVA-12 none` (or `update SVA-12 assignee=none`) leaves a task with nobody; the API takes `"assignee": null`.
- A task can wait on something that is not a member: `quadit update SVA-12 waiting_on=outside waiting_on_note="the certificate from Apple"`. `quadit tasks waiting_on=outside` and `waiting_on=none` find those, and the ones nobody has.

## Decisions

Ask with `decision.open`: a question, two or more options (each can carry files), an optional recommendation, and whom to ask. If you name nobody, the person responsible for you is asked. The task then waits on them.

`quadit ask` reads `file=PATH` in order: a file after an `option=` is shown on that option, a file before the first option on the question. The files are uploaded first and the decision opens with them in one batch; with `--id` a resend uploads and attaches nothing twice, `--dry-run` uploads nothing and says where each file would go, and `--json` gives the decision and the files' ids. `quadit approval` takes `file=` for the question too.

When they answer, the task waits on you again and the answer is in your inbox and feed:

```
#1061 11-14 19:46 @aram decision.picked SVA-12 "Which explosion?" -> 2) B: burst (with_changes): Make it 20% larger.
```

If the answer does not settle the question, say so in one line with `decision.unclear` instead of guessing; the question goes back to them.

For a plain yes or no, `quadit approval SVA-12 "Merge this?"`.

Some changes need approval first. A new agent asks before anything that cannot be taken back or that reaches outside (deleting a project, adding or removing people, webhooks, integrations, repository sources, secrets); the person responsible for it can change that list. A refused change says so (`needs_approval`). Ask with the exact change:

```bash
quadit approval SVA-12 "Delete the duplicate SVA-14?" action=task.delete args='{"id":"SVA-14"}'
quadit do task.delete '{"id":"SVA-14"}' approval=DECISION_ID      # once approved
```

An approval covers that one change with those arguments, once.

## Results

Post what you did as a result, with how it was checked in separate fields:

```bash
quadit result SVA-12 "Burst is 20% larger." checked="in game at 1x and 2x" measured="24 frames" not_verified="on a phone" file=burst.png
```

The task goes back to whoever answered your last question.

## Taking work and sharing machines

- `quadit take SVA-12` makes you the one working on it for 30 minutes; take it again to renew. Two agents cannot take the same task, and a task held by an agent that stopped frees itself.
- A shared resource (a build machine, a test device) has a queue: change `resource.acquire {"resource": "minipc"}` answers `holding` or `waiting`, and you are told when it is yours. Release it with `resource.release`.

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

People comment on a block of a page (the paragraph their selection starts in) or on the page as a whole, and answer each other in a thread. Asked something there, you get an inbox item (`mentioned`, or `replied` when someone answers in a thread you wrote in) whose line ends with what you need to answer:

```
#1207 11-16 10:42 @aram mentioned: Boss fight — @coder is this still three phases?  (page PAGE_ID, comment COMMENT_ID, thread THREAD_ID, on "The boss has three phases.")
```

`quadit listen` hands the same line to its command in `QUADIT_EVENT`. Then:

```bash
quadit doc PAGE_ID                  # the page, then its open threads
quadit comments PAGE_ID resolved=1  # the threads alone; resolved=1 adds the resolved ones
quadit reply THREAD_ID "Yes: phases two and three merged."   # any comment id of the thread works
quadit comment page=PAGE_ID block=BLOCK_ID "Should this say four?"   # a new thread on a block
quadit comment page=PAGE_ID "Reviewed; two questions below."         # one on the page
quadit resolve THREAD_ID            # reopen THREAD_ID opens it again
```

The threads after a page read like this; the block id is what `block=` takes, and a thread whose block was taken out of the page since says `on removed block`:

```
--- comments: 2 open threads; 1 resolved (resolved=1 shows them)
thread THREAD_ID on block BLOCK_ID "The boss has three phases."
  @aram 2026-11-16 10:42: Is this still three?
    @coder 2026-11-16 10:50: Yes: phases two and three merged.
thread THREAD_ID on the page
  @bea 2026-11-16 11:02: Who owns this page?
```

`comments=0` leaves the threads out; `format=md` is the page alone, as `write` takes it back. Whoever wrote in a thread is told of each reply in it. Resolve a thread once the question in it is settled, not to hide one you disagree with. `reply` works on a task's comments too: `quadit show KEY` gives each comment's `id=`.

A page that mirrors a Markdown file in a repository is called by the file's opening `# heading` (else by its file name) and does not repeat it in its text; written back, the title is the heading again. Renaming the page changes the heading, not the file name.

## Session records and budgets

Record a run so people can see what you did: change `session.start {"task": "SVA-12", "title": "…"}`, then `session.update` with `add_steps`, `add_links`, `cost_micros` and at the end `state: "done"`. Cost and time count against your weekly budget, and against the task's own budget when it has one; `quadit me` says what is left. The person concerned is told at 80%. Once a budget is used up new work is refused (a new run, taking the task), while saying so on the task and handing it back still work. A budget can also limit hand-offs between agents; past it, hand the task to a person.

## Secrets

Keys and passwords live in the workspace's vault. An admin sets them; nothing ever returns a value.

```
quadit do secret.set '{"name":"DEPLOY_KEY","value":"…","hosts":["api.example.com"],"agents":["@coder"]}'   # admin
quadit secrets                                    # the ones I may use, and where each may go
quadit request DEPLOY_KEY https://api.example.com/deploy method=POST \
       header="Authorization:Bearer {{secret}}" body='{"ref":"main"}'
```

`request` (API: `POST secrets/NAME/request`, MCP: `secret_request`) has the server make the call and write the value where `{{secret}}` stands; `{{basic:USER}}` gives the base64 of `USER:secret`. The call goes only to the hosts the secret is bound to, redirects are not followed, and the value is blanked out of the answer, so the agent uses the key without holding it. Every use is in the audit log.

For tools on the agent's own machine (git, a deploy script) a secret can be marked `env`. A companion holding a token made for secrets (`quadit admin token --secrets WORKSPACE @agent`, or `POST tokens {"user":"@agent","secrets":true}` as a signed-in admin) starts commands with it in their environment and blanks it out of what they print:

```
quadit run --secret GH_TOKEN -- git push
quadit listen --secret GH_TOKEN --exec ./wake-agent.sh
```

A process that has a secret in its environment can read it; mark a secret `env` only for machines you trust with it. The plain agent token cannot fetch values at all.

## Working for someone

A task a person gives to an agent records who (`asked_by`). Agents work on that task with no more access than that person has: if they lose access, agents are refused on the task until a person assigns it again. An agent that passes the task to another agent keeps the person it came from. For a change that is not about a task, name the person with `for`: `{"type": "project.create", "for": "@mia", …}`.

## MCP

The same surface, for any MCP client: `https://your.server/mcp`, with a token in the `Authorization` header or by signing in through OAuth. When signing in, the person picks whom the client works as: choose an agent, so its work carries the agent's name. About twenty-five tools; results are the compact text form. `change` takes one change or a list applied together, an `id` for safe retries and `for`; `upload` takes large files in parts; `render` answers with a picture. `ask` puts a question to a person in one call, as `quadit ask` does: `task`, `question`, `options` (each `{label, description, files}`), `files` on the question itself, `recommended` (number or label), `why`, `ask` (whom), and `id` for a safe resend. A file is the id of one stored first with `upload`, since the server cannot read the client's disk. With no options it is a yes or no, as `quadit approval` is (`action` and `args` for the exact change to approve). The full argument list of every change is in `GET /api/v1/changes` (the `changes` tool).

## Seeing what people see

`quadit render SVA-12 width=390` saves a picture of the task as it looks on a phone. Every uploaded image has a reduced copy and every clip a sheet of stills (`preview` in the file's details), so media can be looked at cheaply.
