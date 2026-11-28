// The table of commands: each name, what it needs and what runs.

package cli

import (
	"slices"
	"sort"
)

// command is one command of the tool. Adding one means writing what it
// does (in the cmd_*.go file of its group, or a file of its own) and naming
// it in commands below.
type command struct {
	// names are what it is called by: its name, then any aliases.
	names []string
	// args is how many arguments it needs at least, field=value ones not
	// counted. Given fewer, it does nothing and says its usage.
	args int
	// usage is what it says it takes, when given too few arguments.
	usage string
	// noDryRun marks a command that cannot check without doing: it runs a
	// program or sends a request elsewhere. --dry-run is refused for it,
	// never ignored.
	noDryRun bool
	run      func(r *runner, in input) error
}

// commands is every command that talks to a server, in the order the help
// gives them. (help, login, logout, use, skill and the runner's forms of
// run are not here: they are answered before a login is chosen.)
var commands = []command{
	// orient (cmd_read.go)
	{names: []string{"me", "whoami"}, run: (*runner).me},
	{names: []string{"work"}, run: readCommand("/my-work")},
	{names: []string{"layout"}, args: 1, usage: "layout PROJECT", run: readCommand("/projects/%s/layout")},
	{names: []string{"dashboard"}, run: readsWithFilters("/dashboard")},
	{names: []string{"agents"}, run: readCommand("/agents")},
	{names: []string{"connect"}, noDryRun: true, run: (*runner).connect}, // connect.go

	// find (cmd_read.go)
	{names: []string{"tasks", "ls"}, run: readsWithFilters("/tasks")},
	{names: []string{"show"}, args: 1, usage: "show KEY", run: readsWithFilters("/tasks/%s")},
	{names: []string{"context"}, args: 1, usage: "context KEY", run: readsWithFilters("/tasks/%s/context")},
	{names: []string{"search"}, args: 1, usage: "search TEXT", run: (*runner).search},
	{names: []string{"decisions"}, run: readsWithFilters("/decisions")},
	{names: []string{"inbox"}, run: readsWithFilters("/inbox")},

	// follow (cmd_follow.go, listen.go)
	{names: []string{"events"}, run: readsWithFilters("/events")},
	{names: []string{"ack"}, args: 1, usage: "ack SEQ [NAME] [lease=ID]", run: (*runner).ack},
	{names: []string{"listen"}, noDryRun: true, run: (*runner).listen},
	{names: []string{"wait"}, noDryRun: true, run: (*runner).wait},
	{names: []string{"listening"}, run: (*runner).listening},
	{names: []string{"read"}, run: (*runner).markRead},

	// act on tasks (cmd_task.go)
	{names: []string{"new", "create"}, args: 2, usage: "new PROJECT TITLE [field=value ...]", run: (*runner).newTask},
	{names: []string{"update"}, args: 1, usage: "update KEY field=value ...", run: (*runner).update},
	{names: []string{"status"}, args: 2, usage: "status KEY NAME", run: (*runner).status},
	{names: []string{"assign"}, args: 2, usage: "assign KEY @WHO|none", run: (*runner).assign},
	{names: []string{"take"}, args: 1, usage: "take KEY", run: (*runner).changeNamed},
	{names: []string{"release"}, args: 1, usage: "release KEY", run: (*runner).changeNamed},
	{names: []string{"delete"}, args: 1, usage: "delete KEY", run: (*runner).changeNamed},
	{names: []string{"restore"}, args: 1, usage: "restore KEY", run: (*runner).changeNamed},

	// comment on tasks and pages (cmd_comments.go)
	{names: []string{"comment"}, args: 1, usage: "comment KEY TEXT [file=PATH ...] | comment page=PAGE_ID [block=BLOCK_ID [quote=WORDS [occurrence=N]]] TEXT [file=PATH ...]", run: (*runner).comment},
	{names: []string{"result"}, args: 2, usage: "result KEY TEXT", run: (*runner).comment},
	{names: []string{"reply"}, args: 2, usage: "reply COMMENT_ID TEXT [file=PATH ...]", run: (*runner).reply},
	{names: []string{"resolve"}, args: 1, usage: "resolve COMMENT_ID", run: (*runner).resolve},
	{names: []string{"reopen"}, args: 1, usage: "reopen COMMENT_ID", run: (*runner).resolve},

	// act on decisions (cmd_decision.go)
	{names: []string{"ask"}, args: 2, usage: "ask KEY QUESTION ...", run: (*runner).ask},
	{names: []string{"approval"}, args: 2, usage: "approval KEY QUESTION ...", run: (*runner).ask},
	{names: []string{"pick"}, args: 2, usage: "pick DECISION OPTION|approved|declined|none [note=...]", run: (*runner).pick},
	{names: []string{"unclear"}, args: 2, usage: "unclear DECISION NOTE", run: (*runner).unclear},
	{names: []string{"close"}, args: 1, usage: "close DECISION [NOTE]", run: (*runner).closeQuestion},

	// files (cmd_files.go)
	{names: []string{"attach"}, args: 2, usage: "attach KEY PATH ...", run: (*runner).attach},
	{names: []string{"upload"}, args: 1, usage: "upload PATH", run: (*runner).upload},

	// any change (cmd_do.go)
	{names: []string{"do"}, args: 1, usage: "do TYPE [JSON]", run: (*runner).do},
	{names: []string{"changes"}, run: readCommand("/api/v1/changes")},

	// secrets (cmd_secrets.go)
	{names: []string{"secrets"}, run: readCommand("/secrets")},
	{names: []string{"request"}, args: 2, noDryRun: true, usage: "request NAME URL [method=POST] [header=K:V ...] [body=TEXT|-] [approval=DECISION_ID]", run: (*runner).request},
	{names: []string{"run"}, noDryRun: true, run: (*runner).runWithSecrets}, // quadit run --secret …; its other forms are run.go's

	// docs (cmd_docs.go)
	{names: []string{"docs"}, run: readsWithFilters("/docs")},
	{names: []string{"doc"}, args: 1, usage: "doc ID", run: readsWithFilters("/docs/%s")},
	{names: []string{"comments"}, args: 1, usage: "comments PAGE_ID", run: readsWithFilters("/docs/%s/comments")},
	{names: []string{"write"}, args: 1, usage: "write ID|new [TITLE] < markdown", run: (*runner).write},
	{names: []string{"rows"}, args: 1, usage: "rows DATABASE", run: readsWithFilters("/docs/%s/rows")},
	{names: []string{"row"}, args: 2, usage: "row DATABASE TITLE [Prop=value ...]", run: (*runner).row},
	{names: []string{"memory"}, run: readsWithFilters("/memory")},
	{names: []string{"remember"}, args: 1, usage: "remember TITLE < markdown", run: (*runner).remember},

	// code (link.go, render.go)
	{names: []string{"link"}, run: (*runner).link},
	{names: []string{"render"}, run: (*runner).render},

	// import (import.go)
	{names: []string{"import"}, args: 2, usage: "import KIND SOURCE [project=KEY]", run: (*runner).importFrom},
}

// findCommand gives the command a name or an alias stands for.
func findCommand(name string) (command, bool) {
	for _, c := range commands {
		if slices.Contains(c.names, name) {
			return c, true
		}
	}
	return command{}, false
}

// Commands lists every name a command answers to, aliases too, sorted.
func Commands() []string {
	var out []string
	for _, c := range commands {
		out = append(out, c.names...)
	}
	sort.Strings(out)
	return out
}
