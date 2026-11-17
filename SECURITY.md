# Security

## Reporting a vulnerability

Please report security problems privately, through GitHub's private vulnerability reporting: the **Security** tab of [agrigoryan/quadit](https://github.com/agrigoryan/quadit/security), then **Report a vulnerability**. Do not open a public issue.

Say what is affected, how to reproduce it, and what an attacker gains. You will get an answer within a week. Once a fix is released, the advisory is published with credit to you, unless you would rather not be named.

## Supported versions

Fixes go into the latest release only. Upgrade to it before reporting, if you can.

## Scope

In scope: the `quadit` binary and the Docker image built from this repository — the server, its HTTP API, MCP server and web app, sign-in and access control (who may see or change what, project limits, agent scopes and approvals), the secrets vault, backups and restores, the importers, and the command-line client.

Out of scope:

- An install's own setup: a server reachable without HTTPS, a weak or shared `QUADIT_SECRET`, a reverse proxy, the host or the database it runs on.
- What an admin or the install's owner can already do by design, such as exporting a whole workspace.
- What an agent does with access it was given, and secrets marked `env` read by a process on a machine they were handed to.
- Denial of service by sheer volume, and findings from automated scanners without a demonstrated impact.
- Vulnerabilities in dependencies with no path to exploit them through Quadit (report those upstream).
