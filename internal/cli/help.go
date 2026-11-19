// The help texts: the main one and one for each topic.

package cli

// help is the main help text: every command, by group.
const help = `quadit: tasks, decisions and docs for people and agents

orient    me                         who am I: role, scope, hand-off limit, cursors
          work                       what waits on me, what is assigned, unread inbox
          layout PROJECT             statuses, labels, members, epics
          dashboard | agents         where everything stands; what each agent is doing
find      tasks [filter=value ...]   assignee=me status=todo label=art open=1 q=text sort=priority
                                     count=1 for a number, view=SLUG for a saved view
          show KEY [since=SEQ]       one task with decisions and comments
          context KEY                everything needed to work on a task
          search TEXT | decisions [state=open] | inbox [all=1]
follow    events [after=SEQ] [wait=50] [cursor=NAME] [mine=1] [others=1] [task=KEY]
          ack SEQ [NAME]             mark the feed handled up to SEQ
          listen --exec CMD          run CMD for each inbox item, again until it succeeds
act       new PROJECT TITLE [field=value ...]      description=- reads it from stdin
          update KEY field=value ... status=done assignee=@ann priority=high add_labels=a,b
          status KEY NAME | assign KEY @WHO|none | take KEY | release KEY
          delete KEY | restore KEY   to the trash, and back from it
          comment KEY TEXT [waiting_on=@WHO] [decision=ID | option=ID] [file=PATH ...]
          comment page=PAGE_ID [block=BLOCK_ID] TEXT   a thread on a page, or on one of its blocks
          comment page=PAGE_ID block=BLOCK_ID quote=WORDS [occurrence=N] TEXT
                                     a thread on those words of the block (the Nth time they are there)
          reply COMMENT_ID TEXT [file=PATH ...]        answer in that comment's thread, on a task or a page
                                     a file= on a comment, a reply or a result is shown with it: pictures, clips, any file
          resolve COMMENT_ID | reopen COMMENT_ID       a thread, through any of its comments
          result KEY TEXT [checked=...] [measured=...] [not_verified=...] [file=PATH ...]
          ask KEY QUESTION option=A [file=PATH ...] option=B [file=PATH ...] [recommended=2] [why=...] [ask=@WHO]
                                     a file= is shown on the option before it; before any option, on the question
          approval KEY QUESTION [action=task.delete [args=JSON]] [ask=@WHO] [file=PATH ...]
          pick DECISION OPTION|approved|declined|none [note=...]
          unclear DECISION NOTE
          attach KEY PATH ... [option=ID] | upload PATH | read [all | ID ...]
          do TYPE JSON               send any change; "changes" lists them all
secrets   secrets                    the keys I may use (names only; values are never shown)
          request NAME URL [method=POST] [header=K:V ...] [body=TEXT|-]
                                     an HTTP request with {{secret}} filled in by the server
more      quadit help secrets        using keys without holding them
          quadit help docs           pages, databases, memory
          quadit help code           git links, pictures of pages
          quadit help import         bring work in from other tools
          quadit help server         serve, admin, backup, restore

Every command takes --json for full data and --dry-run to check a write
(run, request and listen refuse it: they cannot check without doing).
A write takes --id=UUID (send it again with the same id and it happens once)
and --for=@WHO (it runs with that member's access).
Connect with QUADIT_URL and QUADIT_TOKEN (both, or neither is used), or: quadit login URL
TOKEN (TOKEN "-" reads it from stdin); quadit login --path says where the login is kept (QUADIT_CONFIG sets it)
Teach an agent to use this: quadit skill install (puts the skill where Claude Code,
Codex, Cursor, Gemini CLI, Copilot, opencode and pi look; quadit skill prints it)
`

// helpTopics are the texts of "quadit help TOPIC".
var helpTopics = map[string]string{
	"secrets": `secrets: keys and passwords an agent can use but not read
  An admin sets one:   quadit do secret.set '{"name":"DEPLOY_KEY","value":"…","hosts":["api.example.com"],"agents":["@coder"]}'
  secrets                      the secrets I may use, with the hosts each may go to
  request NAME URL [method=POST] [header="Authorization:Bearer {{secret}}"] [body=TEXT|-] [approval=ID]
                               the server makes the request and writes the value where
                               {{secret}} stands ({{basic:USER}} = base64 of USER:secret).
                               It goes only to the secret's hosts, redirects are not followed,
                               and the value is blanked out of the answer; an answer that is
                               not text comes back without its body. A method other than GET,
                               when I must ask first, needs approval=ID: an approved decision
                               for secret.send whose args are the whole request as I write it
                               ({"name","method","url","headers","body"}, {{secret}} and all);
                               the refusal gives them. Another body or header needs another.
  run --secret NAME [--secret NAME ...] -- COMMAND [ARG ...]
                               for tools on this machine: runs COMMAND with each secret in its
                               environment under its name, and blanks the values out of what it
                               prints. Needs a token made for a companion (an admin makes it:
                               POST tokens {"user":"@agent","secrets":true}) and a secret marked
                               env. The same --secret works with: listen --secret NAME --exec CMD
`,
	"docs": `pages, databases and memory
  docs [project=KEY]           the page tree with ids; one project's pages with project=
  doc ID [resolved=1] [comments=0]   one page as Markdown, then its open comment threads
                               (each: thread id, the block it is on and its text, the replies)
  comments PAGE_ID [resolved=1]       the page's comment threads alone
  write ID|new TITLE [parent=ID] [project=KEY] [mode=append] < markdown     write a page from stdin
  rows DATABASE [filter=Prop:is:Value] [sort=-Prop] [view=NAME]
  row DATABASE TITLE [Prop=value ...]                         add a row to a database
  memory                       my notes from earlier sessions (agents)
  remember TITLE [mode=append] < markdown                     save a note to my memory
`,
	"code": `code and pictures
  link [KEY]                   link the current git branch and its commits to a task;
                               the key is read from the branch name when left out
  link KEY URL                 link a URL to a task
  link KEY page=ID             link a page to a task; the page lists the task
  link page=ID task=KEY        the same, written from the page's side
  render KEY|doc=ID [width=390] [height=N | full=1] [theme=dark] [out=FILE]
                               a picture of how it looks to a person; full=1 takes the whole page
`,
	"import": `bring work in (safe to run twice: nothing is added a second time)
  An admin's import is history, not news: it reaches nobody's inbox.
  import linear FILE.csv project=KEY       import trello BOARD.json project=KEY
  import asana FILE.csv project=KEY        import github OWNER/REPO project=KEY [token=…]
  import notion EXPORT.zip                 import obsidian FOLDER     import markdown FOLDER
  import obsidian|markdown EXPORT.zip origin=NAME
                                           a zipped folder is named: importing again under the
                                           same name adds only what is new (a folder: its path)
  import orbit https://orbit.example workspace=ID token=ORBIT_TOKEN [session=ORBIT_SESSION]
                                           with a signed-in session, attached files come too
`,
	"server": `on the server's machine
  quadit serve [--listen :4780] [--data DIR] [--db PATH|postgres://…] [--url https://…]
  quadit admin                 setup, reset-password, token, make-admin
  quadit backup [--out FILE] | quadit backup verify FILE
  quadit restore FILE [--secret-key FILE | --without-secret-key]
  quadit restore FILE --workspace SLUG (--task KEY | --doc ID)
`,
}

// helpFor is the help asked for with "help" or "help TOPIC": the topic's
// text, or the main one when no topic of that name exists.
func helpFor(asked []string) string {
	if len(asked) > 1 {
		if topic, ok := helpTopics[asked[1]]; ok {
			return topic
		}
	}
	return help
}
