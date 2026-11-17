# Ideas not built yet

Ideas talked through and kept for later. None of them is decided; each says what would decide it.

## Agents run by Quadit

*Raised 2026-11-16. The owner is thinking it over.*

Today every agent runs in a program Quadit does not start: Claude Code, Codex, Cursor, Gemini CLI, Copilot, opencode, pi or anything else. It reads the feed or is woken by `quadit listen` or a webhook, does the work and reports back (see [agents.md](agents.md#your-agent)). Quadit sees every change it makes, but not what the run cost: tokens, money and time are known only to the program running the model, and an agent's word about them cannot be checked. So on 2026-11-16 budgets and usage reporting were taken out altogether; what is shown is only what the server sees happen (hand-offs between agents, who holds a task and since when).

A second mode would have Quadit start the run itself. An inbox item (a mention, an assignment, a comment, an answered decision) becomes a job; Quadit starts the run, watches it, can stop it, and records what it used. Usage is then reported by something other than the model doing the work, so it can be shown and limited.

| | A. Quadit calls the model API | B. A runner on your machine | C. A hosted sandbox |
| --- | --- | --- | --- |
| How | The server runs its own agent loop over a model API. Its tools are Quadit's own (read, comment, change, ask); no shell | `quadit runner` runs on a laptop, a small server or a VPS, like a GitHub self-hosted runner: it registers with the server, takes jobs, starts a coding agent (`claude -p`, `codex exec`, `opencode run`, `pi -p`) in a fresh checkout and streams its progress to the task | Quadit starts runs on a vendor's hosted agent service, or a CI workflow such as the Claude GitHub action |
| Good for | Work inside Quadit: triage, answering page comments, summaries, specs, splitting tasks | Code: branches, tests, pull requests; anything that needs the machine's tools or logins | Code, without a machine of one's own |
| Usage | Exact: every API answer carries its token counts | The coding agent's own end-of-run report (tokens, and cost where it bills per token), read by the runner, not by the model; time measured by the runner | What the service reports |
| Limits | Stop mid-run at the limit | The runner stops the run at the limit | As the service allows |
| Weight and risk | Small: no code runs on the server | The runner runs code, so each job needs an isolated checkout (a container or a separate user); the server stays clean | Tied to a vendor, a cloud bill, the code leaves your machines |

Recommended start: B, which matches how the GitHub integrations of coding agents work and reuses the wake-up path already tested with Codex, opencode and pi; then A for agents that only work inside Quadit. C can be one more kind of runner later.

A coding agent signed in with a subscription (Claude Max, a ChatGPT plan) has no cost in money per run, only tokens and time; limits in money need API keys.

To decide:

1. What these agents mostly do: code in repositories (B), work inside Quadit (A), or both.
2. Where runs happen: the laptop, a small server, a VPS.
3. API keys or subscriptions, which decides whether limits can be in money.
4. Whether an agent's mode is fixed (run by Quadit, or external), so that its numbers always mean the same thing. The recommendation is fixed: an agent driven by hand as well would mix measured and unmeasured work.
