package server_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// pageWithThreads is a page with comment threads on it, as an agent finds
// them: one on a block with a reply, one on the page itself, one resolved,
// and one on a block taken out of the page since.
type pageWithThreads struct {
	s                               *site
	agent                           string // the agent's token
	doc                             string
	ringBlock, goneBlock            string
	onBlock, reply, onPage, settled string // comment ids
	onGone                          string
}

func newPageWithThreads(t *testing.T, st store.Store) pageWithThreads {
	t.Helper()
	s := newSite(t, st)
	p := pageWithThreads{s: s, agent: s.agentToken(t, "writer")}
	p.doc = s.change(t, s.owner, "", "doc.create", M{"title": "Art notes", "markdown": "The ring is thin.\n\nThe smoke is grey.\n\nCut this line.\n"})["ref"].(string)
	var page struct {
		Blocks []struct {
			ID      string          `json:"id"`
			Content json.RawMessage `json:"content"`
		} `json:"blocks"`
	}
	s.call(t, s.owner, "", "GET", w+"/docs/"+p.doc, nil, 200, &page)
	for _, b := range page.Blocks {
		switch {
		case strings.Contains(string(b.Content), "ring"):
			p.ringBlock = b.ID
		case strings.Contains(string(b.Content), "Cut"):
			p.goneBlock = b.ID
		}
	}
	comment := func(args M) string { return s.change(t, s.owner, "", "comment.create", args)["ref"].(string) }
	p.onBlock = comment(M{"doc": p.doc, "block": p.ringBlock, "body": "Is it thick enough?\nIt reads thin at 1x."})
	p.reply = s.change(t, nil, p.agent, "comment.create", M{"parent": p.onBlock, "body": "Thicker by two pixels."})["ref"].(string)
	p.onPage = comment(M{"doc": p.doc, "body": "Who owns this page?"})
	p.settled = comment(M{"doc": p.doc, "body": "Settled already."})
	s.change(t, s.owner, "", "comment.update", M{"id": p.settled, "resolved": true})
	p.onGone = comment(M{"doc": p.doc, "block": p.goneBlock, "body": "Why cut this?"})
	s.change(t, s.owner, "", "doc.edit", M{"doc": p.doc, "ops": []M{{"op": "delete", "id": p.goneBlock}}})
	return p
}

// TestAPageReadShowsItsThreads: the page as text, which agents read, ends
// with its open threads: each with its id, what it is on, and its comments
// by whom and when, replies under the comment they answer.
func TestAPageReadShowsItsThreads(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		p := newPageWithThreads(t, st)
		s := p.s
		read := func(query string) string {
			t.Helper()
			return s.call(t, nil, p.agent, "GET", "/api/v1/w/-/docs/"+p.doc+query, nil, 200, nil)
		}

		t.Run("open threads follow the page text", func(t *testing.T) {
			text := read("?format=text")
			page, threads, ok := strings.Cut(text, "\n--- comments")
			if !ok || !strings.Contains(page, "The ring is thin.") {
				t.Fatalf("no comments part after the page text:\n%s", text)
			}
			for _, want := range []string{
				"thread " + p.onBlock + " on block " + p.ringBlock + ` "The ring is thin."`,
				"  @aram ",
				": Is it thick enough?\n      It reads thin at 1x.",
				"    @writer ",
				": Thicker by two pixels.",
				"thread " + p.onPage + " on the page",
				"thread " + p.onGone + " on removed block " + p.goneBlock + ` "Cut this line."`,
			} {
				if !strings.Contains(threads, want) {
					t.Errorf("the threads lack %q:\n%s", want, threads)
				}
			}
			if strings.Contains(threads, "Settled already.") {
				t.Errorf("a resolved thread is shown without resolved=1:\n%s", threads)
			}
			if !strings.Contains(threads, "1 resolved (resolved=1 shows") {
				t.Errorf("the threads do not say a resolved one is left out:\n%s", threads)
			}
		})

		t.Run("resolved=1 shows the resolved threads too", func(t *testing.T) {
			if text := read("?format=text&resolved=1"); !strings.Contains(text, "thread "+p.settled+" (resolved) on the page") {
				t.Errorf("the resolved thread is not shown:\n%s", text)
			}
		})

		t.Run("comments=0 leaves them out", func(t *testing.T) {
			if text := read("?format=text&comments=0"); strings.Contains(text, "--- comments") {
				t.Errorf("comments shown:\n%s", text)
			}
		})

		t.Run("Markdown is the page alone unless comments=1", func(t *testing.T) {
			if md := read("?format=md"); strings.Contains(md, "--- comments") {
				t.Errorf("the page's Markdown, which is written back, carries the comments:\n%s", md)
			}
			if md := read("?format=md&comments=1"); !strings.Contains(md, "thread "+p.onPage+" on the page") {
				t.Errorf("comments=1 does not add the threads to the Markdown:\n%s", md)
			}
		})

		t.Run("the comments read is the threads alone", func(t *testing.T) {
			text := s.call(t, nil, p.agent, "GET", "/api/v1/w/-/docs/"+p.doc+"/comments?format=text", nil, 200, nil)
			if strings.Contains(text, "The smoke is grey.") || !strings.Contains(text, "thread "+p.onBlock+" on block") {
				t.Errorf("the comments read is not the threads alone:\n%s", text)
			}
			var out struct {
				Threads []struct {
					ID       string `json:"id"`
					Block    string `json:"block"`
					Quote    string `json:"quote"`
					Comments []struct {
						ID, By, Body string
					} `json:"comments"`
				} `json:"threads"`
			}
			s.call(t, nil, p.agent, "GET", "/api/v1/w/-/docs/"+p.doc+"/comments", nil, 200, &out) // all of them, the resolved one too
			if len(out.Threads) != 4 || out.Threads[0].ID != p.onBlock || out.Threads[0].Quote != "The ring is thin." ||
				len(out.Threads[0].Comments) != 2 || out.Threads[0].Comments[1].By != "@writer" {
				t.Errorf("threads as JSON: %+v", out.Threads)
			}
		})

		t.Run("a page without comments reads as before", func(t *testing.T) {
			bare := s.change(t, s.owner, "", "doc.create", M{"title": "Bare", "markdown": "Nothing to say.\n"})["ref"].(string)
			if text := s.call(t, nil, p.agent, "GET", "/api/v1/w/-/docs/"+bare+"?format=text", nil, 200, nil); strings.Contains(text, "comments") {
				t.Errorf("a page without comments mentions them:\n%s", text)
			}
		})
	})
}

// TestAnAgentWorksAPageThreadFromTheCommandLine: asked about a page, an
// agent reads its threads, answers in one, starts one on a block and on
// the page, and resolves one, all with the quadit command.
func TestAnAgentWorksAPageThreadFromTheCommandLine(t *testing.T) {
	// Not in parallel: the command line it runs reads the process's environment (t.Setenv).
	testdb.Each(t, func(t *testing.T, st store.Store) {
		p := newPageWithThreads(t, st)
		s := p.s
		run := func(args ...string) string {
			t.Helper()
			out, code := s.quadit(t, p.agent, args...)
			if code != 0 {
				t.Fatalf("quadit %s: exit %d: %s", strings.Join(args, " "), code, out)
			}
			return out
		}
		threads := func() string {
			t.Helper()
			return s.call(t, nil, p.agent, "GET", "/api/v1/w/-/docs/"+p.doc+"/comments?format=text&resolved=1", nil, 200, nil)
		}

		t.Run("doc shows the threads, and the options say which", func(t *testing.T) {
			if out := run("doc", p.doc); !strings.Contains(out, "The ring is thin.") || !strings.Contains(out, "thread "+p.onBlock) {
				t.Errorf("quadit doc:\n%s", out)
			}
			if out := run("doc", p.doc, "resolved=1"); !strings.Contains(out, "Settled already.") {
				t.Errorf("quadit doc resolved=1:\n%s", out)
			}
			if out := run("doc", p.doc, "comments=0"); strings.Contains(out, "--- comments") {
				t.Errorf("quadit doc comments=0:\n%s", out)
			}
			if out := run("comments", p.doc); strings.Contains(out, "The smoke is grey.") || !strings.Contains(out, "thread "+p.onPage) {
				t.Errorf("quadit comments:\n%s", out)
			}
		})

		t.Run("reply answers in the thread", func(t *testing.T) {
			run("reply", p.reply, "Done: four pixels now.")
			if text := threads(); !strings.Contains(text, "    @writer ") || !strings.Contains(text, ": Done: four pixels now.") {
				t.Errorf("the reply is not in the thread:\n%s", text)
			}
		})

		t.Run("comment starts a thread on a block or on the page", func(t *testing.T) {
			run("comment", "page="+p.doc, "block="+p.ringBlock, "Or make it glow?")
			run("comment", "page="+p.doc, "Reviewed the whole page.")
			text := threads()
			for _, want := range []string{`on block ` + p.ringBlock + ` "The ring is thin."` + "\n  @writer ", ": Or make it glow?", ": Reviewed the whole page."} {
				if !strings.Contains(text, want) {
					t.Errorf("the threads lack %q:\n%s", want, text)
				}
			}
		})

		t.Run("resolve and reopen a thread", func(t *testing.T) {
			run("resolve", p.onPage)
			if text := threads(); !strings.Contains(text, "thread "+p.onPage+" (resolved)") {
				t.Errorf("not resolved:\n%s", text)
			}
			run("reopen", p.onPage)
			if text := threads(); strings.Contains(text, "thread "+p.onPage+" (resolved)") {
				t.Errorf("not open again:\n%s", text)
			}
		})

		t.Run("reply works on a task's comments too", func(t *testing.T) {
			s.change(t, s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
			s.change(t, s.owner, "", "task.create", M{"project": "SVA", "title": "Explosion"})
			asked := s.change(t, s.owner, "", "comment.create", M{"task": "SVA-1", "body": "@writer which frame?"})["ref"].(string)
			if out := run("show", "SVA-1"); !strings.Contains(out, "id="+asked) {
				t.Errorf("quadit show does not give the comment's id to reply to:\n%s", out)
			}
			run("reply", asked, "Frame six.")
			var task struct {
				Comments []struct {
					ReplyTo string `json:"reply_to"`
					Body    string `json:"body"`
				} `json:"comments"`
			}
			s.call(t, nil, p.agent, "GET", "/api/v1/w/-/tasks/SVA-1", nil, 200, &task)
			if len(task.Comments) != 2 || task.Comments[1].ReplyTo != asked || task.Comments[1].Body != "Frame six." {
				t.Errorf("task comments: %+v", task.Comments)
			}
		})
	})
}

// TestAnAgentAskedOnAPageHasWhatItNeedsToAnswer: the inbox item an agent
// gets for a mention in a page comment, as the inbox and the listener show
// it, names the page, the comment, its thread and the text it is on; the
// agent's answer reaches the one who asked as a reply.
func TestAnAgentAskedOnAPageHasWhatItNeedsToAnswer(t *testing.T) {
	// Not in parallel: the command line it runs reads the process's environment (t.Setenv).
	testdb.Each(t, func(t *testing.T, st store.Store) {
		p := newPageWithThreads(t, st)
		s := p.s
		asked := s.change(t, s.owner, "", "comment.create", M{"parent": p.onBlock, "body": "@writer can you check it again?"})["ref"].(string)
		wants := []string{"Art notes", "page " + p.doc, "comment " + asked, "thread " + p.onBlock, `on "The ring is thin."`, "@writer can you check it again?"}

		t.Run("the inbox", func(t *testing.T) {
			out, _ := s.quadit(t, p.agent, "inbox")
			var line string
			for l := range strings.SplitSeq(out, "\n") {
				if strings.Contains(l, "mentioned") {
					line = l
				}
			}
			for _, want := range wants {
				if !strings.Contains(line, want) {
					t.Errorf("the inbox item lacks %q: %s", want, line)
				}
			}
		})

		t.Run("what listen hands its command", func(t *testing.T) {
			var page struct {
				Events []string `json:"events"`
			}
			s.call(t, nil, p.agent, "GET", "/api/v1/w/-/events?inbox=1&types=notification.created&compact=1&limit=100", nil, 200, &page)
			var line string
			for _, l := range page.Events {
				if strings.Contains(l, "mentioned") {
					line = l
				}
			}
			for _, want := range wants {
				if !strings.Contains(line, want) {
					t.Errorf("the event line lacks %q: %s", want, line)
				}
			}
		})

		t.Run("the answer reaches the one who asked as a reply", func(t *testing.T) {
			if out, code := s.quadit(t, p.agent, "reply", asked, "Checked: it is fine now."); code != 0 {
				t.Fatalf("reply: %s", out)
			}
			inbox := s.call(t, s.owner, "", "GET", w+"/inbox?format=text", nil, 200, nil)
			if !strings.Contains(inbox, "@writer replied: Art notes — Checked: it is fine now.") {
				t.Errorf("the owner's inbox has no reply item:\n%s", inbox)
			}
		})
	})
}

// TestAnAgentWorksAThreadOnWords: an agent starts a thread on words with
// the quadit command, finds them in the page's Markdown as a span with the
// thread's id, keeps them marked when it writes the page back without the
// span, and is told when a write takes the words out.
func TestAnAgentWorksAThreadOnWords(t *testing.T) {
	// Not in parallel: the command line it runs reads the process's environment (t.Setenv).
	testdb.Each(t, func(t *testing.T, st store.Store) {
		p := newPageWithThreads(t, st)
		s := p.s
		run := func(args ...string) string {
			t.Helper()
			out, code := s.quadit(t, p.agent, args...)
			if code != 0 {
				t.Fatalf("quadit %s: exit %d: %s", strings.Join(args, " "), code, out)
			}
			return out
		}
		markdown := func() string {
			t.Helper()
			return s.call(t, nil, p.agent, "GET", "/api/v1/w/-/docs/"+p.doc+"?format=md", nil, 200, nil)
		}

		out := run("--json", "comment", "page="+p.doc, "block="+p.ringBlock, "quote=thin", "Thicker?")
		var made struct {
			Ref string `json:"ref"`
		}
		if err := json.Unmarshal([]byte(out), &made); err != nil || made.Ref == "" {
			t.Fatalf("quadit comment quote=: %s", out)
		}
		span := `The ring is <span data-comment="` + made.Ref + `">thin</span>.`

		t.Run("the page's Markdown has the span", func(t *testing.T) {
			if md := markdown(); !strings.Contains(md, span) {
				t.Errorf("no span for the thread:\n%s", md)
			}
			text := s.call(t, nil, p.agent, "GET", "/api/v1/w/-/docs/"+p.doc+"/comments?format=text", nil, 200, nil)
			if want := "thread " + made.Ref + " on words of block " + p.ringBlock + ` "thin"`; !strings.Contains(text, want) {
				t.Errorf("the threads lack %q:\n%s", want, text)
			}
		})
		t.Run("words that are there twice need which", func(t *testing.T) {
			twice := s.change(t, s.owner, "", "doc.create", M{"title": "Twice", "markdown": "A thin ring, a thin line.\n"})["ref"].(string)
			var page struct {
				Blocks []struct {
					ID string `json:"id"`
				} `json:"blocks"`
			}
			s.call(t, s.owner, "", "GET", w+"/docs/"+twice, nil, 200, &page)
			out, code := s.quadit(t, p.agent, "comment", "page="+twice, "block="+page.Blocks[0].ID, "quote=thin", "Which?")
			if code == 0 || !strings.Contains(out, "occurrence") {
				t.Errorf("quote= of words there twice: exit %d: %s", code, out)
			}
			run("comment", "page="+twice, "block="+page.Blocks[0].ID, "quote=thin", "occurrence=2", "The line one.")
			if md := s.call(t, nil, p.agent, "GET", "/api/v1/w/-/docs/"+twice+"?format=md", nil, 200, nil); !strings.Contains(md, `a <span data-comment="`) || !strings.Contains(md, `">thin</span> line`) {
				t.Errorf("the second one is not marked:\n%s", md)
			}
		})
		t.Run("written back without the span, the words keep it", func(t *testing.T) {
			res := s.change(t, nil, p.agent, "doc.write", M{"doc": p.doc, "markdown": "The ring is thin.\n\nThe smoke is grey and slow.\n"})
			if res["warnings"] != nil {
				t.Errorf("warnings for a write that keeps the words: %v", res["warnings"])
			}
			if md := markdown(); !strings.Contains(md, span) {
				t.Errorf("the span is gone:\n%s", md)
			}
		})
		t.Run("a write that takes the words out says so, and the thread stays on the page", func(t *testing.T) {
			out := run("do", "doc.write", `{"doc":"`+p.doc+`","markdown":"The ring is gone.\n"}`)
			if !strings.Contains(out, "warning: thread "+made.Ref) || !strings.Contains(out, `"thin"`) {
				t.Errorf("no warning naming the thread:\n%s", out)
			}
			text := s.call(t, nil, p.agent, "GET", "/api/v1/w/-/docs/"+p.doc+"/comments?format=text", nil, 200, nil)
			if want := "thread " + made.Ref + ` on the page, its words taken out of it: "thin"`; !strings.Contains(text, want) {
				t.Errorf("the threads lack %q:\n%s", want, text)
			}
		})
	})
}

// TestAnInboxItemQuotesOnlyItsOwnPage: a thread said to be on a block of
// another page (a row written before such a comment was refused) quotes
// nothing in an inbox item: the block's text may be of a page the reader
// cannot see.
func TestAnInboxItemQuotesOnlyItsOwnPage(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		p := newPageWithThreads(t, st)
		s := p.s
		secret := s.change(t, s.owner, "", "doc.create", M{"title": "Salaries", "markdown": "Bea earns a lot.\n", "private": true})["ref"].(string)
		var page struct {
			Blocks []struct{ ID string } `json:"blocks"`
		}
		s.call(t, s.owner, "", "GET", w+"/docs/"+secret, nil, 200, &page)
		db := st.In(siteWorkspaceID(t, st))
		if _, err := db.Update(context.Background(), "comments", map[string]any{"subject_type": "doc_block", "subject_id": page.Blocks[0].ID}, store.Eq("id", p.onPage)); err != nil {
			t.Fatal(err)
		}
		s.change(t, nil, p.agent, "comment.create", M{"parent": p.onPage, "body": "Me?"})
		s.change(t, s.owner, "", "comment.create", M{"parent": p.onPage, "body": "You."})
		inbox := s.call(t, nil, p.agent, "GET", w+"/inbox?format=text", nil, 200, nil)
		if !strings.Contains(inbox, "You.") {
			t.Fatalf("the agent was not told of the answer:\n%s", inbox)
		}
		if strings.Contains(inbox, "Bea earns") {
			t.Errorf("an inbox item quotes a page its reader cannot see:\n%s", inbox)
		}
	})
}
