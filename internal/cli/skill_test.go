package cli

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/agrigoryan/quadit/integrations"
)

// TestTheSkillIsPrinted: `quadit skill` needs no server: it prints the skill
// this binary was built with.
func TestTheSkillIsPrinted(t *testing.T) {
	var out, errs bytes.Buffer
	if code := Run([]string{"skill"}, &out, &errs); code != 0 {
		t.Fatalf("exit %d: %s", code, errs.String())
	}
	if out.String() != integrations.Skill || !strings.HasPrefix(out.String(), "---\nname: quadit\n") {
		t.Errorf("printed something other than the skill:\n%.200s", out.String())
	}
}

// TestTheSkillIsInstalledWhereAgentsLook: by default into ~/.agents/skills,
// which every agent but Claude Code reads, and ~/.claude/skills, which
// Claude Code reads; or into the skill folders named.
func TestTheSkillIsInstalledWhereAgentsLook(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	var out, errs bytes.Buffer
	if code := Run([]string{"skill", "install"}, &out, &errs); code != 0 {
		t.Fatalf("exit %d: %s", code, errs.String())
	}
	for _, dir := range []string{".agents/skills", ".claude/skills"} {
		path := filepath.Join(home, dir, "quadit", "SKILL.md")
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if string(raw) != integrations.Skill {
			t.Errorf("%s is not the skill", path)
		}
		if !strings.Contains(out.String(), path) {
			t.Errorf("the output does not say %s:\n%s", path, out.String())
		}
	}

	// Named folders instead, and an older copy is replaced.
	mine := filepath.Join(t.TempDir(), "skills")
	old := filepath.Join(mine, "quadit", "SKILL.md")
	if err := os.MkdirAll(filepath.Dir(old), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(old, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	out.Reset()
	if code := Run([]string{"skill", "install", mine}, &out, &errs); code != 0 {
		t.Fatalf("exit %d: %s", code, errs.String())
	}
	if raw, _ := os.ReadFile(old); string(raw) != integrations.Skill {
		t.Errorf("the older copy was not replaced")
	}
	if strings.Contains(out.String(), home) {
		t.Errorf("named folders were given, but the default ones were written too:\n%s", out.String())
	}
}
