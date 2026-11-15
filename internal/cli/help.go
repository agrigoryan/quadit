package cli

const help = `quadit: tasks, decisions and docs for people and agents

orient    me                         who am I: role, scope, budget, cursors
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
          listen --exec CMD          wait for inbox items and run CMD for each
act       new PROJECT TITLE [field=value ...]      description=- reads it from stdin
          update KEY field=value ... status=done assignee=@ann priority=high add_labels=a,b
          status KEY NAME | assign KEY @WHO|none | take KEY | release KEY
          delete KEY | restore KEY   to the trash, and back from it
          comment KEY TEXT [waiting_on=@WHO] [decision=ID | option=ID]
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

Every command takes --json for full data and --dry-run to check a write.
A write takes --id=UUID (send it again with the same id and it happens once)
and --for=@WHO (it runs with that member's access).
Connect with QUADIT_URL and QUADIT_TOKEN, or: quadit login URL TOKEN
`

var helpTopics = map[string]string{
	"secrets": `secrets: keys and passwords an agent can use but not read
  An admin sets one:   quadit do secret.set '{"name":"DEPLOY_KEY","value":"…","hosts":["api.example.com"],"agents":["@coder"]}'
  secrets                      the secrets I may use, with the hosts each may go to
  request NAME URL [method=POST] [header="Authorization:Bearer {{secret}}"] [body=TEXT|-]
                               the server makes the request and writes the value where
                               {{secret}} stands ({{basic:USER}} = base64 of USER:secret).
                               It goes only to the secret's hosts, redirects are not followed,
                               and the value is blanked out of the answer.
  run --secret NAME [--secret NAME ...] -- COMMAND [ARG ...]
                               for tools on this machine: runs COMMAND with each secret in its
                               environment under its name, and blanks the values out of what it
                               prints. Needs a token made for a companion (an admin makes it:
                               POST tokens {"user":"@agent","secrets":true}) and a secret marked
                               env. The same --secret works with: listen --secret NAME --exec CMD
`,
	"docs": `pages, databases and memory
  docs                         the page tree with ids
  doc ID                       one page as Markdown
  write ID|new TITLE [parent=ID] [mode=append] < markdown     write a page from stdin
  rows DATABASE [filter=Prop:is:Value] [sort=-Prop] [view=NAME]
  row DATABASE TITLE [Prop=value ...]                         add a row to a database
  memory                       my notes from earlier sessions (agents)
  remember TITLE [mode=append] < markdown                     save a note to my memory
`,
	"code": `code and pictures
  link [KEY]                   link the current git branch and its commits to a task;
                               the key is read from the branch name when left out
  link KEY URL                 link a URL to a task
  render KEY|doc=ID [width=390] [height=N | full=1] [theme=dark] [out=FILE]
                               a picture of how it looks to a person; full=1 takes the whole page
`,
	"import": `bring work in (safe to run twice: nothing is added a second time)
  An admin's import is history, not news: it reaches nobody's inbox.
  import linear FILE.csv project=KEY       import trello BOARD.json project=KEY
  import asana FILE.csv project=KEY        import github OWNER/REPO project=KEY [token=…]
  import notion EXPORT.zip                 import obsidian FOLDER     import markdown FOLDER
  import orbit https://orbit.example workspace=ID token=ORBIT_TOKEN [session=ORBIT_SESSION]
                                           with a signed-in session, attached files come too
`,
	"server": `on the server's machine
  quadit serve [--listen :4780] [--data DIR] [--db PATH|postgres://…] [--url https://…]
  quadit admin                 setup, reset-password, token, make-admin
  quadit backup [--out FILE] | quadit backup verify FILE
  quadit restore FILE [--workspace SLUG --task KEY | --doc ID]
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
