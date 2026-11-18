package core

import "testing"

func TestNoteHeadlineNamesTheActorWhatHappenedAndTheTitle(t *testing.T) {
	for _, c := range []struct{ noteType, who, title, want string }{
		{NoteAssigned, "Bea", "SVA-5 Jump feels floaty", "Bea assigned you SVA-5 Jump feels floaty"},
		{NoteAsked, "Bea", "SVA-5 Jump", "Bea asked you a question in SVA-5 Jump"},
		{NoteMentioned, "", "Design notes", "mentioned you in Design notes"},
		{"a-type-from-later", "Bea", "SVA-5", "Bea commented on SVA-5"},
	} {
		if got := NoteHeadline(c.noteType, c.who, c.title); got != c.want {
			t.Errorf("%s by %q: %q, want %q", c.noteType, c.who, got, c.want)
		}
	}
}
