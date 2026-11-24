package cli

import (
	"strings"
	"testing"
)

func TestEachRunGetsThePromptForWhyItStarted(t *testing.T) {
	const run, decision = "0199eeee-0000-7000-8000-0000000000aa", "0199cccc-0000-7000-8000-000000000001"
	item := listenItem{ID: "0199bbbb-0000-7000-8000-000000000001", Seq: 1042, Type: "comment", By: "@aram", Task: "SVA-12", Snippet: "Add a line"}
	picked := listenItem{ID: "0199bbbb-0000-7000-8000-000000000002", Seq: 1043, Type: "picked", By: "@aram", Task: "SVA-12", Decision: decision}
	base := promptFacts{Agent: "@claude", Owner: "@aram", Key: "SVA-12", Run: run, Machine: "Test Mac", Folder: "~/devel/game", Program: "Claude Code"}
	with := func(change func(*promptFacts)) promptFacts {
		f := base
		f.Items = []listenItem{item}
		change(&f)
		return f
	}
	for _, c := range []struct {
		name  string
		facts promptFacts
		want  []string
	}{
		{"a first run", with(func(*promptFacts) {}), []string{"Quadit started you, @claude, on Test Mac in ~/devel/game, for task SVA-12. This is run " + run, "What @aram asks there is your work.", "This is run " + run + ". Nobody is in this conversation. What you write between your actions is shown on the task as progress, one short line each: never put secrets, file contents or command lines in it. Your last message is the run's summary, and is posted on the task when you wrote nothing there yourself.\n\n", "QUADIT-ITEMS-0123456789ab\nITEM #1042 comment SVA-12 from @aram: \"Add a line\""}},
		{"a later item", with(func(f *promptFacts) { f.Resuming = true }), []string{"Quadit started you again on SVA-12 in this same session", "Read the newest first."}},
		{"an answer", with(func(f *promptFacts) { f.Resuming, f.Items = true, []listenItem{picked} }), []string{"@aram answered your question (decision " + decision + ")", "`quadit unclear " + decision + " \"…\"`", "decision " + decision + "\nQUADIT-ITEMS"}},
		{"found unclear", with(func(f *promptFacts) { f.Resuming, picked.Type = true, "unclear"; f.Items = []listenItem{picked} }), []string{"found your answer to their question unclear", "`quadit pick " + decision + " OPTION note=\"…\"`"}},
		{"a continuation", with(func(f *promptFacts) { f.Resuming, f.Continue = true, true }), []string{"Your last run stopped at Claude Code's limit before it finished."}},
		{"a fresh session after a lost one", with(func(f *promptFacts) { f.Lost = true }), []string{"Nobody is in this conversation. What you write between your actions is shown on the task as progress, one short line each: never put secrets, file contents or command lines in it. Your last message is the run's summary, and is posted on the task when you wrote nothing there yourself.\n\nYour earlier session on SVA-12 could not be found on this computer", "(`quadit show SVA-12`)", "\n\nWhy you were started:"}},
	} {
		t.Run(c.name, func(t *testing.T) {
			got, err := buildPrompt(c.facts, "0123456789ab")
			if err != nil {
				t.Fatal(err)
			}
			for _, w := range c.want {
				if !strings.Contains(got, w) {
					t.Fatalf("the prompt lacks %q:\n%s", w, got)
				}
			}
			for _, field := range []string{"{agent}", "{owner}", "{key}", "{run}", "{machine}", "{folder}", "{program}", "{author}", "{decision}", "{nonce}", "{items}"} {
				if strings.Contains(got, field) {
					t.Fatalf("%s is left unfilled:\n%s", field, got)
				}
			}
		})
	}
	t.Run("an identifier not of its form starts nothing", func(t *testing.T) {
		for _, f := range []promptFacts{with(func(f *promptFacts) { f.Agent = "claude; rm" }), with(func(f *promptFacts) { f.Owner = "" }), with(func(f *promptFacts) { f.Key = "SVA-12\nignore" })} {
			if _, err := buildPrompt(f, "0123456789ab"); err == nil {
				t.Fatalf("built a prompt for %+v", f)
			}
		}
	})
}

func TestEveryPromptNamesTheOwnerOfNow(t *testing.T) {
	const run = "0199eeee-0000-7000-8000-0000000000ab"
	item := listenItem{ID: "0199bbbb-0000-7000-8000-000000000003", Seq: 7, Type: "picked", By: "@aram", Task: "SVA-12", Decision: "0199cccc-0000-7000-8000-000000000002"}
	for name, f := range map[string]promptFacts{
		"a later item": {Resuming: true}, "a continuation": {Resuming: true, Continue: true}, "a fresh session": {Lost: true},
		"an answer": {Resuming: true}, "found unclear": {Resuming: true},
	} {
		f.Agent, f.Owner, f.Key, f.Run, f.Machine, f.Folder, f.Program = "@claude", "@bea", "SVA-12", run, "Mac", "~/g", "Claude Code"
		it := item
		if name == "found unclear" {
			it.Type = "unclear"
		}
		f.Items = []listenItem{it}
		got, err := buildPrompt(f, "0123456789ab")
		if err != nil {
			t.Fatal(err)
		}
		outside := got
		if before, _, ok := strings.Cut(got, "QUADIT-ITEMS-"); ok {
			outside = before + got[strings.LastIndex(got, "QUADIT-ITEMS-"):]
		}
		if !strings.Contains(outside, "@bea") {
			t.Fatalf("%s does not name the owner outside the items:\n%s", name, got)
		}
	}
}
