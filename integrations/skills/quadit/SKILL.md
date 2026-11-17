---
name: quadit
description: Work in a Quadit workspace with the quadit command-line tool - find and take tasks, follow what changed, ask a person for a decision, post results with evidence, read and write docs. Use whenever the work is tracked in Quadit, a task key like SVA-12 is mentioned, or QUADIT_URL and QUADIT_TOKEN are set.
---

# Working in Quadit

Quadit holds the team's tasks, decisions and docs. You are a member of the workspace with your own account. People assign you tasks and answer your questions there; nothing important should live only in this conversation.

The `quadit` command reads `QUADIT_URL` and `QUADIT_TOKEN`. Output is short on purpose; add `--json` for full data. Names work wherever ids do: `SVA-12`, `@handle`, a status or label by its name, `me`.

## Start of a session

```bash
quadit me        # role, projects, what needs approval, hand-off limit, standing preferences
quadit memory    # your notes from earlier sessions
quadit work      # what waits on you, questions asked of you, tasks assigned to you, unread inbox
quadit events cursor=main mine=1 others=1    # what happened on your tasks since last time
```

Then `quadit ack SEQ` with the `seq` printed at the end of `events`, once you have handled what it showed.

## Doing a task

```bash
quadit context SVA-12     # the task, its parents, epic, preferences, recent decisions, linked docs
quadit take SVA-12        # you are working on it; nobody else can take it. Take again to renew
```

- If work comes up in conversation that is not a task yet, create it first: `quadit new SVA "Title" description=-` (the description is read from stdin).
- Keep the task current as you go: `quadit update SVA-12 status="In Progress"`, `quadit comment SVA-12 "…"`. `quadit assign SVA-12 none` unassigns it.
- When you are done, post a result and say how it was checked. Put what you could not check in `not_verified`; do not bury it in prose:

```bash
quadit result SVA-12 "What was done, in a sentence or two." \
  checked="what you ran or looked at" measured="numbers, if any" not_verified="what you could not check" \
  file=path/to/screenshot.png
```

The task then goes back to the person who answered your last question.

## Asking for a decision

When a choice is the person's to make, ask in the task instead of guessing or asking in chat:

```bash
quadit ask SVA-12 "Which explosion?" \
  option="A: ring::classic shockwave" file=ring.gif option="B: burst::reads best at small size" file=burst.gif option="C: smoke" \
  recommended=2 why="clearest at 1x"
```

- Show each option: a `file=PATH` belongs to the `option=` before it (several allowed); one before the first option goes with the question. The files go up first and the question goes out with them, once even if you resend it with the same `--id`.

- One question per decision. Several questions are several decisions, or sub-tasks.
- Always give a recommendation and the reason when you have one.
- For a plain yes or no: `quadit approval SVA-12 "Merge this into main?"` (`file=PATH` works here too).
- The task now waits on them. Wait with `quadit events cursor=main mine=1 others=1 wait=50` (it returns as soon as something happens), or stop and pick it up next session from `quadit work`.
- The answer arrives as `decision.picked … -> 2) B: burst (with_changes): Make it 20% larger.` Follow the note exactly.
- If the answer does not settle it, say what is unclear in one line: `quadit unclear DECISION_ID "Larger in radius, or in duration?"`. Do not guess.

If a change is refused with `needs_approval`, ask with `quadit approval KEY "…" action=task.delete` (for a change that is not on that task, add `args='{…}'` with the exact arguments you will send) and resend the same change with `approval=DECISION_ID` once approved. An approval covers that one change, once.

## Finding things

```bash
quadit tasks assignee=me open=1 sort=priority
quadit tasks status=todo label=art project=SVA        # filters combine; count=1 gives only the number
quadit show SVA-12                 # description, decisions with numbered options, comments, files
quadit show SVA-12 since=1042      # only what changed after that feed position
quadit search "explosion"
quadit decisions                   # the decision log: what was asked, what was picked, why
quadit layout SVA                  # the project's statuses, labels, members, epics
```

## Docs and memory

```bash
quadit docs                              # the page tree with ids
quadit doc PAGE_ID                       # a page as Markdown, then its open comment threads
quadit write PAGE_ID < page.md           # rewrite a page; unchanged blocks keep their comments
quadit write new "Release notes" < notes.md
echo "- lesson learned" | quadit remember "Lessons" mode=append     # a note for your next session
```

Asked on a page (an inbox item `mentioned` or `replied` ending in `(page …, comment …, thread …, on "…")`), answer there, not in chat:

```bash
quadit comments PAGE_ID                  # the page's threads: id, the words or block it is on, who said what
quadit reply THREAD_ID "…"               # answer in the thread (works on a task's comments too)
quadit comment page=PAGE_ID block=BLOCK_ID quote="exact words" "…"   # a thread on words; occurrence=2 if they are there twice
quadit comment page=PAGE_ID block=BLOCK_ID "…"     # on the block; leave out block= for the page
quadit resolve THREAD_ID                 # once it is settled; reopen THREAD_ID undoes it
```

In a page's Markdown the words a thread is on read `<span data-comment="THREAD_ID">words</span>`. Keep the span around the words when you rewrite them (move it to move the thread); a span left out keeps the thread on its words while they are there. A write that takes the words out prints `warning: thread … was on words this edit took out`: the thread stays open, on the page as a whole.

Write down what the next session will need: preferences you were told, where things are, what you were in the middle of.

## When something is refused

A refusal says what was wrong and lists what would have worked:

```
invalid: project SVA has no status "In Progres"
  did you mean: In Progress
```

Fix the call and send it again. `--dry-run` checks a write without making it. `quadit changes` lists every change type and its arguments; `quadit do TYPE '{"…": …}'` sends any of them.

## Rules of the road

- Do not work on a task someone else holds; `quadit take` will tell you who has it.
- Hand a task on explicitly: `quadit comment SVA-12 "…" waiting_on=@who`. A task that waits on nobody is nobody's.
- If you correct yourself, say so in a new comment; do not rewrite the old one.
- A shared machine has a queue: `quadit do resource.acquire '{"resource": "minipc"}'` answers holding or waiting; release with `resource.release` when done.
- Keys and passwords are in the vault; you can use them, not read them. `quadit secrets` lists yours. To call an API with one: `quadit request NAME https://api.example.com/path method=POST header="Authorization:Bearer {{secret}}" body='…'`. The server fills in the value, sends it only to that secret's hosts, and blanks it out of the answer. Never ask a person to paste a key into a task or a comment.
- A task a person gave you is worked with that person's access. If you are refused because they no longer have access, say so in a comment and stop; a person has to assign it again.
