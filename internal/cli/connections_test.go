package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/agrigoryan/quadit/internal/testdb"
)

// chatWorkspace is one workspace of the two-workspace test: a real server
// with SVA-12 assigned to @claude, the owner's token, the agent's, and the
// folder whose chat works in it.
type chatWorkspace struct {
	q             *realQuadit
	owner, agent  string
	id, slug      string
	folder, words string // the chat's folder, and what the owner says there
}

// newChatWorkspace starts a server whose workspace is name (slug slug),
// with projects SVA's first twelve tasks, the last assigned to @claude.
func newChatWorkspace(t *testing.T, name, slug, folder, words string) *chatWorkspace {
	t.Helper()
	q := startRealQuaditOf(t, testdb.SQLite(t), name, slug)
	w := &chatWorkspace{q: q, owner: q.token(q.owner, "me"), slug: slug, folder: folder, words: words}
	q.change(w.owner, "project.create", map[string]any{"key": "SVA", "name": "Samurai vs Aliens"})
	q.change(w.owner, "agent.create", map[string]any{"name": "claude", "handle": "claude"})
	w.agent = q.token(q.owner, "@claude")
	for n := 1; n <= 12; n++ {
		args := map[string]any{"project": "SVA", "title": fmt.Sprintf("Task %d", n)}
		if n == 12 {
			args["assignee"] = "@claude"
		}
		q.change(w.owner, "task.create", args)
	}
	var me struct{ Workspace workspaceRef }
	q.call(nil, w.agent, "GET", q.w+"/me", nil, 200, &me)
	w.id = me.Workspace.ID
	if err := os.MkdirAll(folder, 0o700); err != nil {
		t.Fatal(err)
	}
	return w
}

// listening reports whether a chat holds the agent's listener of SVA.
func (w *chatWorkspace) listening() bool {
	var answer struct {
		Listeners []struct {
			Project string
			Live    bool
		}
	}
	w.q.call(nil, w.agent, "GET", w.q.w+"/listening", nil, 200, &answer)
	return slices.ContainsFunc(answer.Listeners, func(l struct {
		Project string
		Live    bool
	}) bool {
		return l.Project == "SVA" && l.Live
	})
}

// task is SVA-12 as JSON, comments and all.
func (w *chatWorkspace) task() string {
	var raw json.RawMessage
	w.q.call(nil, w.owner, "GET", w.q.w+"/tasks/SVA-12", nil, 200, &raw)
	return string(raw)
}

// quaditIn runs the quadit command (this test binary, playing it) in
// folder, as a chat's shell would: logins from config alone, none of the
// test's own QUADIT_ variables.
func quaditIn(t *testing.T, config, folder, stdin string, args ...string) (int, string) {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(exe, append([]string{testCommandMark, "quadit"}, args...)...)
	cmd.Dir = folder
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(strings.ToUpper(kv), "QUADIT_") {
			cmd.Env = append(cmd.Env, kv)
		}
	}
	cmd.Env = append(cmd.Env, "QUADIT_CONFIG="+config, "GORACE=atexit_sleep_ms=0")
	cmd.Stdin = strings.NewReader(stdin)
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	err = cmd.Run()
	code := 0
	if err != nil {
		code = cmd.ProcessState.ExitCode()
	}
	return code, out.String()
}

// printedLine is the command a record printed on the line marked with the
// comment mark, as arguments after "quadit", with words in place of "…".
func printedLine(t *testing.T, record, mark, words string) []string {
	t.Helper()
	for line := range strings.SplitSeq(record, "\n") {
		command, comment, ok := strings.Cut(line, "   # ")
		if !ok || !strings.HasPrefix(comment, mark) {
			continue
		}
		args := strings.Fields(command)[1:]
		if i := slices.Index(args, `"…"`); i >= 0 {
			args[i] = words
		}
		return args
	}
	t.Fatalf("no line marked %q in:\n%s", mark, record)
	return nil
}

// TestTwoChatsWorkInTwoWorkspacesAtOnce is the case the design is for:
// one tool, Claude Code, connected to two workspaces on two servers, both
// of which have SVA-12; a chat in a folder tied to each listens to SVA at
// the same time, and each hears, answers and acknowledges only its own
// workspace's comment. Taking one workspace away leaves the other's chat
// working, and the lines the other was printed stop instead of acting
// elsewhere.
func TestTwoChatsWorkInTwoWorkspacesAtOnce(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	config := filepath.Join(root, "quadit", "claude.json")
	games := newChatWorkspace(t, "Games", "games", filepath.Join(root, "devel", "game"), "Game: the boss needs a second phase")
	acmeW := newChatWorkspace(t, "Acme", "acme", filepath.Join(root, "devel", "site"), "Site: the header overlaps the menu")
	both := []*chatWorkspace{games, acmeW}

	// Connect: a login in each, the second beside the first; tie each folder.
	for _, w := range both {
		if code, said := quaditIn(t, config, root, w.agent, "login", w.q.url, "-"); code != 0 {
			t.Fatalf("login to %s: %s", w.slug, said)
		}
	}
	t.Setenv("QUADIT_CONFIG", config)
	for _, w := range both {
		var out bytes.Buffer
		if code := useWith(context.Background(), folderRules{home: root}, []string{w.slug, "project=SVA", "folder=" + w.folder}, switches{}, &out, &out); code != 0 {
			t.Fatalf("use %s: %s", w.slug, out.String())
		}
	}
	if code, said := quaditIn(t, config, root, "", "comment", "SVA-12", "from nowhere"); code != 2 || !strings.Contains(said, "This folder is tied to no Quadit workspace, and this tool works in 2:") {
		t.Fatalf("a command in an untied folder: %d %s", code, said)
	}

	// Both chats listen at once; the owner of each comments on its SVA-12.
	records := make([]chan string, len(both))
	for i, w := range both {
		records[i] = make(chan string, 1)
		go func() {
			_, said := quaditIn(t, config, w.folder, "", "wait", "project=SVA", "for=30")
			records[i] <- said
		}()
	}
	deadline := time.Now().Add(20 * time.Second)
	for !games.listening() || !acmeW.listening() {
		if time.Now().After(deadline) {
			t.Fatal("the two chats never both listened")
		}
		time.Sleep(50 * time.Millisecond)
	}
	for _, w := range both {
		w.q.change(w.owner, "comment.create", map[string]any{"task": "SVA-12", "body": w.words})
	}
	next := map[*chatWorkspace][]string{}
	for i, w := range both {
		record := <-records[i]
		other := both[1-i]
		if !strings.Contains(record, w.words) || strings.Contains(record, other.words) || !strings.Contains(record, "--workspace="+w.id) || strings.Contains(record, other.id) {
			t.Fatalf("the chat in %s heard:\n%s", w.slug, record)
		}
		if code, said := quaditIn(t, config, w.folder, "", printedLine(t, record, "answer", "Answered in "+w.slug)...); code != 0 {
			t.Fatalf("the answer in %s: %s", w.slug, said)
		}
		if code, said := quaditIn(t, config, w.folder, "", printedLine(t, record, "once it is handled", "")...); code != 0 {
			t.Fatalf("the ack in %s: %s", w.slug, said)
		}
		next[w] = printedLine(t, record, "then go on listening", "")
	}
	for i, w := range both {
		task := w.task()
		if !strings.Contains(task, "Answered in "+w.slug) || strings.Contains(task, "Answered in "+both[1-i].slug) {
			t.Fatalf("%s's SVA-12 has the answers: %s", w.slug, task)
		}
	}
	// What was acknowledged does not come again: each wait now is idle.
	for _, w := range both {
		args := slices.Clone(next[w])
		args[slices.IndexFunc(args, func(a string) bool { return strings.HasPrefix(a, "for=") })] = "for=1"
		if code, said := quaditIn(t, config, w.folder, "", args...); code != 0 || !strings.HasPrefix(said, "IDLE\n") {
			t.Fatalf("the next wait in %s: %d %s", w.slug, code, said)
		}
	}
	// A plain command in a tied folder acts in its folder's workspace.
	if code, said := quaditIn(t, config, acmeW.folder, "", "comment", "SVA-12", "Said in the site folder"); code != 0 {
		t.Fatal(said)
	}
	if !strings.Contains(acmeW.task(), "Said in the site folder") || strings.Contains(games.task(), "Said in the site folder") {
		t.Fatal("a comment in the site folder did not land on Acme's SVA-12 alone")
	}

	// Acme is taken away; the game chat goes on, and Acme's printed line stops.
	if code, said := quaditIn(t, config, root, "", "logout", "--workspace=acme"); code != 0 {
		t.Fatalf("logout: %s", said)
	}
	if code, said := quaditIn(t, config, acmeW.folder, "", next[acmeW]...); code != 2 || !strings.Contains(said, "this tool is not connected to a workspace named \""+acmeW.id+"\"") {
		t.Fatalf("Acme's printed wait after logout: %d %s", code, said)
	}
	waited := make(chan string, 1)
	go func() {
		_, said := quaditIn(t, config, games.folder, "", next[games]...)
		waited <- said
	}()
	for deadline := time.Now().Add(20 * time.Second); !games.listening(); time.Sleep(50 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("the game chat no longer listens")
		}
	}
	games.q.change(games.owner, "comment.create", map[string]any{"task": "SVA-12", "body": "Game: and a third"})
	record := <-waited
	if !strings.Contains(record, "Game: and a third") {
		t.Fatalf("the game chat heard:\n%s", record)
	}
	for _, mark := range []string{"answer", "once it is handled"} {
		if code, said := quaditIn(t, config, games.folder, "", printedLine(t, record, mark, "Still here")...); code != 0 {
			t.Fatalf("%s after Acme was taken away: %s", mark, said)
		}
	}
	if !strings.Contains(games.task(), "Still here") {
		t.Fatal("the game chat's answer did not land")
	}
}

// TestALogoutEndsAWaitAlreadyRunningInThatWorkspace: a chat's wait that
// started before `quadit logout --workspace=acme` stops listening there at
// its next hold, saying why, instead of holding Acme's lease until its for=
// ends; and so does a companion.
func TestALogoutEndsAWaitAlreadyRunningInThatWorkspace(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	config := filepath.Join(root, "quadit", "claude.json")
	games := newChatWorkspace(t, "Games", "games", filepath.Join(root, "devel", "game"), "")
	acmeW := newChatWorkspace(t, "Acme", "acme", filepath.Join(root, "devel", "site"), "")
	for _, w := range []*chatWorkspace{games, acmeW} {
		if code, said := quaditIn(t, config, root, w.agent, "login", w.q.url, "-"); code != 0 {
			t.Fatalf("login to %s: %s", w.slug, said)
		}
	}
	t.Setenv("QUADIT_CONFIG", config)
	c, _, err := openLogin(context.Background(), workspaceAsk{named: "acme"})
	if err != nil {
		t.Fatal(err)
	}
	r := &runner{ctx: context.Background(), c: c, out: &syncBuffer{}}
	ended := make(chan error, 1)
	go func() {
		// A wait of 150 seconds, in holds of one: the server's are 50.
		ended <- r.waitFor(waitSpan{total: 150 * time.Second, hold: time.Second}, listenAsk{project: "SVA", by: "a chat"}, " for=150")
	}()
	for deadline := time.Now().Add(20 * time.Second); !acmeW.listening(); time.Sleep(50 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("the wait never listened")
		}
	}
	if code, out, errs := runCLI(t, "logout", "--workspace=acme"); code != 0 {
		t.Fatalf("logout: %s%s", out, errs)
	}
	select {
	case err := <-ended:
		if err == nil || err.Error() != "this tool is not connected to Acme any more (quadit logout): it stopped listening there" {
			t.Fatalf("the wait ended with %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("10 s after the logout the wait still holds Acme's lease")
	}
}

// TestALogoutEndsACompanionInThatWorkspace: a companion whose login file
// is taken away stops at its next hold, saying why.
func TestALogoutEndsACompanionInThatWorkspace(t *testing.T) {
	w := newToolWorld(t)
	inbox := &inboxServer{}
	srv := httptest.NewServer(inbox)
	t.Cleanup(srv.Close)
	login := filepath.Join(w.dir, "claude-acme.json")
	writeJSON(t, login, map[string]string{"url": srv.URL, "token": "t"})
	conn := connection{Tool: w.base, Login: login, Server: srv.URL, WorkspaceID: acme.ID, Workspace: acme.Slug, WorkspaceName: acme.Name}
	if err := (connectionIndex{Connections: []connection{conn}}).write(w.dir); err != nil {
		t.Fatal(err)
	}
	c, err := connectionClient(conn)
	if err != nil {
		t.Fatal(err)
	}
	r := &runner{ctx: context.Background(), c: c, out: &syncBuffer{}}
	ended := make(chan error, 1)
	go func() { ended <- r.listenWith(listenArgs([]string{"--exec", "true"}), time.Minute) }()
	for deadline := time.Now().Add(10 * time.Second); ; time.Sleep(20 * time.Millisecond) {
		inbox.mu.Lock()
		held := len(inbox.leases) > 0
		inbox.mu.Unlock()
		if held {
			break
		}
		select {
		case err := <-ended:
			t.Fatalf("the companion ended before it listened: %v", err)
		default:
		}
		if time.Now().After(deadline) {
			t.Fatal("the companion never listened")
		}
	}
	if err := os.Remove(login); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-ended:
		if err == nil || !strings.HasPrefix(err.Error(), "this tool is not connected to Acme any more") {
			t.Fatalf("the companion ended with %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the companion goes on without its login")
	}
}
