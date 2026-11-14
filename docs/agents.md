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
- Names work wherever ids do: `SVA-12`, `@handle`, a status or label by name, `me`.
- `quadit tasks assignee=me status=todo label=art open=1 sort=priority`; `count=1` returns only the number; `view=SLUG` runs a saved view.
- `quadit show SVA-12 since=1042` returns only what happened in the task after feed position 1042.
- A refusal says what was wrong, lists what would have been accepted and suggests the nearest match:

```
invalid: project SVA has no status "In Progres"
  did you mean: In Progress
  allowed: Backlog, Todo, In Progress, Waiting, Done, Canceled
```

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
quadit ask SVA-12 "Which explosion?" option="A: ring" option="B: burst::reads best small" recommended=2 why="clearer at 1x"
quadit attach SVA-12 ring.png option=OPTION_ID
quadit do task.update '{"id": "SVA-12", "base_seq": 1042, "title": "New title"}'
```

- `--dry-run` checks a change without making it.
- `base_seq` refuses the update if the task changed since you read it, and says which fields changed.
- A batch (`POST /changes {"changes": […]}`) applies all of its changes or none.
- `quadit changes` lists every change type with its arguments.

## Decisions

Ask with `decision.open`: a question, two or more options (each can carry files), an optional recommendation, and whom to ask. If you name nobody, the person responsible for you is asked. The task then waits on them.

When they answer, the task waits on you again and the answer is in your inbox and feed:

```
#1061 11-14 19:46 @aram decision.picked SVA-12 "Which explosion?" -> 2) B: burst (with_changes): Make it 20% larger.
```

If the answer does not settle the question, say so in one line with `decision.unclear` instead of guessing; the question goes back to them.

For a plain yes or no, `quadit approval SVA-12 "Merge this?"`. If your scope says a change needs approval (say `task.delete`), ask with `action=task.delete` and send the change with `approval=DECISION_ID` once it is approved.

## Results

Post what you did as a result, with how it was checked in separate fields:

```bash
quadit result SVA-12 "Burst is 20% larger." checked="in game at 1x and 2x" measured="24 frames" not_verified="on a phone" file=burst.png
```

The task goes back to whoever answered your last question.

## Taking work and sharing machines

- `quadit take SVA-12` makes you the one working on it for 30 minutes; take it again to renew. Two agents cannot take the same task, and a task held by an agent that stopped frees itself.
- A shared resource (a build machine, a test device) has a queue: change `resource.acquire {"resource": "minipc"}` answers `holding` or `waiting`, and you are told when it is yours. Release it with `resource.release`.

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
quadit doc PAGE_ID          # one page as Markdown
quadit write PAGE_ID < page.md          # rewrite it; blocks that did not change keep their comments
quadit write new "Release notes" < notes.md
quadit rows DATABASE_ID filter=State:is:todo sort=-Frames
```

## Session records and budgets

Record a run so people can see what you did: change `session.start {"task": "SVA-12", "title": "…"}`, then `session.update` with `add_steps`, `add_links`, `cost_micros` and at the end `state: "done"`. Cost counts against your weekly budget; `quadit me` says what is left, and new work is refused once it is used up.

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

The same surface, for any MCP client: `https://your.server/mcp`, with a token in the `Authorization` header or by signing in through OAuth. About twenty tools; results are the compact text form.

## Seeing what people see

`quadit render SVA-12 width=390` saves a picture of the task as it looks on a phone. Every uploaded image has a reduced copy and every clip a sheet of stills (`preview` in the file's details), so media can be looked at cheaply.
