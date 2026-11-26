// What Quadit's runner says of itself, held to its forms the same way where
// it is said: on each hold of its listener (the server's GET /listen) and on
// each run it starts (session.start).

package engine

import (
	"regexp"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/agrigoryan/quadit/internal/core"
)

// Runner is the machine a runner works on, the label of its folder (the
// path stays on the machine) and the program it starts.
type Runner struct {
	MachineID   string // 16 lower-case hex, made once per machine
	MachineName string // what a person calls the machine: 1 to 64 characters
	Folder      string // the folder's label: 1 to 200 characters, a path from /, ~, a drive (C:\) or \\
	Program     string // one of core.Programs
}

var machineIDForm = regexp.MustCompile(`^[0-9a-f]{16}$`)

// folderLabelStart is how a folder's label starts, as the runner writes it
// on each system: from the root (/) or the home folder (~, then / or \\),
// or on Windows from a drive (C:\) or a network share (\\server\share).
var folderLabelStart = regexp.MustCompile(`^(/|~|[A-Za-z]:\\|\\\\)`)

// CheckMachineID refuses what is not a runner's machine id.
func CheckMachineID(machineID string) error {
	if !machineIDForm.MatchString(machineID) {
		return invalid("machine_id", "machine_id is the runner's machine id: 16 lower-case hexadecimal characters")
	}
	return nil
}

// Check holds what the runner said to its forms, the machine's name trimmed
// first, and names the argument at fault. Every value shows on pages, so
// none may carry a control character.
func (r *Runner) Check() error {
	r.MachineName = strings.TrimSpace(r.MachineName)
	if err := CheckMachineID(r.MachineID); err != nil {
		return err
	}
	switch {
	case !plainText(r.MachineName, 64):
		return invalid("machine_name", "machine_name is the machine's name: 1 to 64 characters, none of them a control character")
	case !plainText(r.Folder, 200) || !folderLabelStart.MatchString(r.Folder):
		return invalid("folder", `folder is the folder's label: 1 to 200 characters starting with /, ~, a drive (C:\) or \\, none of them a control character`)
	case !slices.Contains(core.Programs, r.Program):
		return oneOf("program", "program", r.Program, core.Programs)
	}
	return nil
}

// plainText reports whether s is 1 to n characters with no control
// character among them.
func plainText(s string, n int) bool {
	return s != "" && utf8.RuneCountInString(s) <= n && utf8.ValidString(s) && !strings.ContainsFunc(s, unicode.IsControl)
}
