package engine

import (
	"strings"
	"testing"
)

// TestAFolderLabelIsAPathAsTheRunnersSystemWritesIt: a runner's folder is
// labeled from the root or the home folder on every system, and on
// Windows from a drive or a network share too; anything else, or a label
// too long or with a control character, is refused.
func TestAFolderLabelIsAPathAsTheRunnersSystemWritesIt(t *testing.T) {
	runner := func(folder string) Runner {
		return Runner{MachineID: "0123456789abcdef", MachineName: "Studio", Folder: folder, Program: "claude"}
	}
	for _, folder := range []string{"/srv/game", "~", "~/devel/game", `~\devel\game`, `C:\Users\lou\game`, `d:\a\quadit\game`, `\\server\share\game`} {
		if r := runner(folder); r.Check() != nil {
			t.Errorf("%q is refused: %v", folder, r.Check())
		}
	}
	for _, folder := range []string{"", "devel/game", "C:", "C:game", "C:/Users/lou", `\game`, "~/a\tb", "/" + strings.Repeat("a", 200)} {
		if r := runner(folder); r.Check() == nil {
			t.Errorf("%q is taken", folder)
		}
	}
}
