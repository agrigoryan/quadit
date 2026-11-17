// The skill command: the skill this binary carries, printed or put where
// agents look for skills.

package cli

import (
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/agrigoryan/quadit/integrations"
)

// skill prints the skill, or with install writes it as quadit/SKILL.md into
// each skill folder named, by default ~/.agents/skills (read by Codex,
// Cursor, Gemini CLI, Copilot, opencode and pi) and ~/.claude/skills (read
// by Claude Code). A copy already there is replaced, so installing again
// after an update brings the skill up to the binary.
func skill(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprint(stdout, integrations.Skill)
		return 0
	}
	if args[0] != "install" {
		fmt.Fprintln(stderr, "usage: quadit skill [install [SKILLS_DIR ...]]")
		return 2
	}
	dirs := args[1:]
	if len(dirs) == 0 {
		home, err := os.UserHomeDir()
		if err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
		dirs = []string{filepath.Join(home, ".agents", "skills"), filepath.Join(home, ".claude", "skills")}
	}
	for _, dir := range dirs {
		path := filepath.Join(dir, "quadit", "SKILL.md")
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
		if err := os.WriteFile(path, []byte(integrations.Skill), 0o644); err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
		fmt.Fprintln(stdout, "installed", path)
	}
	return 0
}
