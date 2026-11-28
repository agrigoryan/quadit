package cli

import "testing"

// TestTiesAreFoundInWindowsPaths: on Windows a tie is found in any case,
// at a drive's folders and a share's, and a path in its long form is the
// plain one.
func TestTiesAreFoundInWindowsPaths(t *testing.T) {
	idx := connectionIndex{Folders: []folderTie{
		{Folder: `C:\Users\Aram\devel\Site`, WorkspaceID: acme.ID},
		{Folder: `\\nas\work\game`, WorkspaceID: personal.ID},
	}}
	for dir, want := range map[string]string{
		`c:\users\aram\devel\site`:        acme.ID,
		`C:\USERS\ARAM\DEVEL\SITE\src\ui`: acme.ID,
		`\\NAS\work\game\assets`:          personal.ID,
		`C:\Users\Aram\devel\Sites`:       "",
		`D:\Users\Aram\devel\Site`:        "",
		`C:\`:                             "",
	} {
		tie, ok := idx.tieAt(dir)
		if got := map[bool]string{true: tie.WorkspaceID}[ok]; got != want {
			t.Errorf("the tie at %s is %q, want %q", dir, got, want)
		}
	}
	for long, plain := range map[string]string{`\\?\C:\Users\Aram`: `C:\Users\Aram`, `\\?\UNC\nas\work`: `\\nas\work`, `C:\x`: `C:\x`} {
		if got := plainPath(long); got != plain {
			t.Errorf("plainPath(%s) = %s, want %s", long, got, plain)
		}
	}
	if !samePath(`C:\Users\Aram\quadit\claude.json`, `c:\users\aram\QUADIT\Claude.json`) {
		t.Error("two spellings of one login file are not the same path")
	}
}
