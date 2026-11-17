// Package integrations holds what agents are given to work with Quadit: the
// skill (skills/quadit/SKILL.md, in the Agent Skills format every coding
// agent reads) and, around it, the Claude Code plugin. The binary carries
// the skill, so `quadit skill install` can put it where agents look; see
// docs/agents.md for each agent.
package integrations

import _ "embed"

// Skill is the text of skills/quadit/SKILL.md.
//
//go:embed skills/quadit/SKILL.md
var Skill string
