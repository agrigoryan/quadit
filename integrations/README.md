# Quadit for Claude Code

A plugin that teaches Claude Code to work in a Quadit workspace: one skill for the `quadit` command-line tool, and the Quadit MCP server.

## Install

Set the server address and the agent's token where Claude Code runs:

```bash
export QUADIT_URL=https://quadit.example.com
export QUADIT_TOKEN=qd_…        # issued in Settings → Agents
```

Then, from a checkout of this repository:

```bash
claude plugin marketplace add .
claude plugin install quadit@quadit
```

Or for one session only: `claude --plugin-dir ./integrations/claude-code`.

The `quadit` binary must be on the path for the skill's commands; the MCP server needs only the two variables.
