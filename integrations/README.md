# Quadit for coding agents

One skill for every agent: `skills/quadit/SKILL.md`, in the [Agent Skills](https://agentskills.io) format. The `quadit` binary carries it, so `quadit skill install` puts it where Claude Code, Codex, Cursor, Gemini CLI, GitHub Copilot, opencode and pi look for skills.

This folder is also a Claude Code plugin (the skill plus the MCP server, from `QUADIT_URL` and `QUADIT_TOKEN`):

```bash
claude plugin marketplace add agrigoryan/quadit   # or a path to a checkout of this repository
claude plugin install quadit@quadit
```

How to set up each agent, its MCP server, and waking it with `quadit listen`: [docs/agents.md](../docs/agents.md#your-agent).
