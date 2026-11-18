# Running Quadit

One binary serves the web app, the API and the background work. By default it keeps one SQLite file and the uploaded files in a data directory. The [README](../README.md#install) lists the ways to install it: the install script, Homebrew, Docker, a release archive, or a build from source.

## Start

```bash
quadit serve --data /var/lib/quadit --url https://quadit.example.com
```

| Flag | Environment | Default | What |
| --- | --- | --- | --- |
| `--listen` | `QUADIT_LISTEN` | `:4780` | Address to listen on |
| `--data` | `QUADIT_DATA` | `./data` | Database, files, backups, the install secret |
| `--db` | `QUADIT_DB` | `quadit.sqlite` in the data directory | A SQLite path, or a `postgres://` URL |
| `--url` | `QUADIT_BASE_URL` | `http://localhost:4780` | The address people use. Links in mail, passkeys and file addresses need it right |
| | `QUADIT_SECRET` | a file made in the data directory | Encrypts stored secrets (mail password, storage keys, integration tokens). Keep it with your backups |
| `--log-json` | `QUADIT_LOG=json` | text | Structured logs |

Put it behind a reverse proxy for HTTPS. The proxy must not buffer responses (the live stream and held requests need that): for nginx, `proxy_buffering off`.

The first person to open the address creates the first account and workspace, and runs the install. Without a browser: `quadit admin setup --name … --email … --password … --workspace …`.

## Docker

The image `ghcr.io/agrigoryan/quadit` runs `quadit serve` on port 4780 with its data in the volume `/data`, as an ordinary user (uid 10001). It carries `git`, `ffmpeg` and Chromium, the optional programs below.

```bash
docker run -d --name quadit -p 4780:4780 -v quadit-data:/data \
  -e QUADIT_BASE_URL=http://localhost:4780 ghcr.io/agrigoryan/quadit:latest
```

Every setting below can be given as an environment variable (`-e`). The `deploy/` folder has three Compose files to start from:

| File | What |
| --- | --- |
| [`docker-compose.yml`](../deploy/docker-compose.yml) | One container, SQLite, files on disk |
| [`docker-compose.https.yml`](../deploy/docker-compose.https.yml) | The same over HTTPS, with a certificate from Let's Encrypt |
| [`docker-compose.postgres.yml`](../deploy/docker-compose.postgres.yml) | Postgres for the database and S3-compatible storage (RustFS) for files. Quadit waits for the bucket to be made |

The command-line client is in the image too: `docker exec quadit quadit admin …`, `docker exec quadit quadit backup --out /data/backup.tar.gz`.

## Linux packages

Each release has `.deb` and `.rpm` packages for x86-64 and ARM64. They install `/usr/bin/quadit` and a systemd service, which they do not start:

```bash
sudo apt install ./quadit_0.1.0_amd64.deb            # Debian, Ubuntu
sudo dnf install ./quadit-0.1.0-1.x86_64.rpm         # Fedora, RHEL
sudoedit /etc/quadit/quadit.env                      # QUADIT_BASE_URL and any other setting
sudo systemctl enable --now quadit
```

The service runs `quadit serve` as the system user `quadit`, made by the package, with its data in `/var/lib/quadit`. It reads its settings from `/etc/quadit/quadit.env`, which an upgrade keeps as you edited it. Logs: `journalctl -u quadit`. Removing the package stops and disables the service and leaves the data and the user. Commands that work on the data run as that user: `sudo -u quadit QUADIT_DATA=/var/lib/quadit quadit backup --out /var/lib/quadit/backup.tar.gz`.

## Settings

Everything else is set in the admin area of the web app. Each setting can also come from an environment variable, which then wins and shows as locked in the admin area: the setting `auth.google` is read from `QUADIT_SETTING_AUTH_GOOGLE` as JSON.

| Setting | Value |
| --- | --- |
| `install.name` | The name shown on the sign-in page and in mail |
| `auth.password`, `auth.passkeys` | `true` or `false`: turn a sign-in method on or off |
| `auth.registration` | `true` lets anyone make an account. Off by default: people join by invitation |
| `auth.allowed_domains` | `["example.com"]` limits new accounts to these email domains |
| `auth.require_2fa` | `true` requires a second step (codes or a passkey) from everyone |
| `auth.google`, `auth.github` | `{"enabled": true, "client_id": "…", "client_secret": "…"}`. Redirect address: `<url>/api/v1/auth/oauth/google/callback` |
| `auth.oidc` | The same, plus `"issuer"` and a `"name"` for the button. Any OpenID Connect provider. Add `"trust_email": true` only if the provider checks every address but does not say so: an address it does not call verified is otherwise not enough to sign in to the account that has it |
| `mail` | `{"host", "port", "username", "password", "from", "tls"}`. `tls` is `starttls` (default), `tls` or `none` |
| `files` | Where uploads go: see below |
| `files.max_mb` | Largest upload, default 250 |
| `backup` | `{"enabled": true, "hour": 3, "keep": 14, "copy_to_files": false}` |
| `limits.api_per_minute` | Requests per token per minute, default 1200 |
| `metrics.token` | If set, `/metrics` needs it as a bearer token |

## File storage

| `kind` | Other fields |
| --- | --- |
| `disk` (default) | none: files live in the data directory |
| `s3` | `bucket`, `region`, `access_key`, `secret_key`; `endpoint` for Cloudflare R2, RustFS, MinIO and other S3-compatible stores |
| `gcs` | `bucket`, and `credentials` (a service account key as JSON) or the machine's own identity |
| `azure` | `bucket` (the container), `account`, `account_key` |

Switching from disk to a cloud store needs no downtime: new files go to the cloud at once, old ones are still served from disk, and a background job copies them over.

A cloud store set in the admin area is tried before it is kept, and refused if it does not take a test write. A cloud store that cannot be used when the server starts (its bucket not made yet, the store not up, a wrong key in `QUADIT_SETTING_FILES`) is never replaced by the local disk: no file is stored or read and `/readyz` fails until it can be used, which the server tries again every minute at most, and says so in its log.

## Postgres

```bash
quadit serve --db 'postgres://quadit:secret@db.example.com:5432/quadit'
```

The schema is the same on both databases. To move an install from one to the other, take a backup on the old one and restore it on the new one.

## Backups

```bash
quadit backup --out /backups/quadit.tar.gz      # database and files in one archive, verified
quadit backup verify /backups/quadit.tar.gz
quadit restore /backups/quadit.tar.gz            # into an empty install, on SQLite or Postgres
quadit restore FILE --workspace games --task SVA-12     # bring back one task
quadit restore FILE --workspace games --doc PAGE_ID     # or one page
```

Scheduled backups are a switch in the admin area. Each one is read back and checked before it counts; the last one shows in the health panel. Deleted tasks, pages and files stay in the trash for 30 days first.

## Export

An admin can download a workspace as one zip of open formats, in Settings → General → Export workspace or with `GET /api/v1/w/SLUG/export`: tasks and pages as Markdown, every table as JSON, and the uploaded files. Its `README.txt` says what is where.

An export is complete: it contains everything in the workspace, every project and every member's private pages included, which the admin who exports could not open in the app. Treat the file accordingly. A token limited to some projects is refused an export, and each export is written to the audit log.

## Upgrades

Quadit follows [Semantic Versioning](https://semver.org): releases are tagged `vX.Y.Z`, and `quadit version` prints the version a binary is. Within a major version an upgrade breaks nothing that people or agents rely on. What changed is in [CHANGELOG.md](../CHANGELOG.md) and in the notes of each [release](https://github.com/agrigoryan/quadit/releases). Quadit does not update itself: you upgrade it the way you installed it.

| Installed with | Upgrade |
| --- | --- |
| Homebrew | `brew upgrade quadit` |
| The install script | Run it again: it replaces the binary in place and says which version it replaced. `curl … \| QUADIT_VERSION=v0.1.0 sh` installs that version instead of the newest, older or newer than the one there |
| Docker | `docker pull ghcr.io/agrigoryan/quadit:latest` and recreate the container; with Compose, `docker compose pull && docker compose up -d`. Tags: `X.Y.Z`, `X.Y` (newest patch), `X` (newest minor) and `latest`; pin one of the first three to upgrade only that far |
| `.deb` / `.rpm` | Install the newer package: `sudo apt install ./quadit_X.Y.Z_amd64.deb` or `sudo dnf install ./quadit-X.Y.Z-1.x86_64.rpm`. A running `quadit` service is restarted on the new version |
| An archive from Releases | Download the new one, replace the binary, restart the server |
| From source | `git pull && make build`, then restart the server |

Then restart the server, if the upgrade did not. Take a backup first (`quadit backup --out …`, see [Backups](#backups)): it is the only copy of the files as well as the database.

**What an upgrade does to your data.** The server brings the database's schema up to its own version when it starts. Run `quadit upgrade` (with the same `--data` / `--db` as the server) to do that step by itself before starting it. When the new version changes the schema, a copy of the database as it was is made first, and if the copy cannot be made, nothing is changed and the server says why:

- on SQLite, a file beside it: `quadit.sqlite.before-vN`, where N is the schema version being upgraded to;
- on Postgres, a database beside it on the same server: `<name>_before_vN`. This needs the database to itself for a moment and a role allowed to create databases; with several servers on one database, stop them all first. Where that is not possible, take a backup yourself and set `QUADIT_UPGRADE_WITHOUT_COPY=1` to upgrade without the copy.

A release that does not change the schema makes no copy. Copies are not removed by Quadit: delete old ones once the new version has proved itself. Uploaded files are not copied; an upgrade does not change them.

**Going back.** A binary refuses a database that a newer version has upgraded ("database is at version 9, this binary knows 8: use a newer binary"), so an older version cannot simply be started again. To go back: stop the server, run `quadit upgrade --undo` with the newer binary (it puts the copy in its place and keeps the upgraded database beside it as `….after-vN` or `<name>_after_vN`), then install and start the older version. Anything written after the upgrade is in the upgraded database only, not in the copy. A release that did not change the schema can be undone by installing the older version again.

Agents are not broken by an upgrade: the API stays at `/api/v1`, and the list of changes, their arguments, the MCP tools and the command-line tool's commands only ever gain things within a major version. `GET /api/v1/changes` says which surface version a server speaks. Run `quadit skill install` again on each agent's machine after upgrading the `quadit` command there.

## HTTPS

Passkeys and phone notifications need HTTPS. Three ways:

- `quadit serve --tls-domain quadit.example.com` gets a certificate from Let's Encrypt and renews it by itself. Ports 443 and 80 must reach the server.
  Another authority that speaks the same protocol (a company's own, for one) is named with `--acme-directory <url>`, with `--acme-ca <pem file>` when its own certificate is not publicly trusted; `--acme-http-listen` moves the plain-HTTP side off port 80.
- `quadit serve --tls-cert cert.pem --tls-key key.pem` uses a certificate of your own.
- or keep plain HTTP on `:4780` behind a proxy that terminates HTTPS (Caddy, nginx, a tunnel), and set `--url https://…`.

## Several servers

More than one copy of the server can share a Postgres database and a cloud file store (not SQLite, and not files on local disk). Sessions, cursors, task leases, job claims, rate counts, page presence and uploads in progress are all in the database or the file store, and a write taken by one server wakes the live connections held by the others. Jobs (the daily backup, emptying the trash) run once, on whichever server claims them; a backup is written to that server's data directory.

Two things are not shared out yet, and work with a single server only: syncing pages with a git repository, and GitHub integrations. Each server runs them on its own timer, so with several servers two can sync the same source at the same time and their writes can clash. Use them on an install with one server.

## Accounts with no mail server

```bash
quadit admin reset-password someone@example.com     # prints a new password, turns off their second step
quadit admin make-admin someone@example.com
quadit admin token games @coordinator               # an API token for a member, printed once
```

## Monitoring

| Address | What |
| --- | --- |
| `/healthz` | The process is up |
| `/readyz` | The database and the file store answer. A cloud file store that is set but cannot be used makes it fail: the server then keeps no file on its own disk instead, and takes the store as soon as it answers. The Docker image's health check is this address |
| `/metrics` | Prometheus counters: requests, rows per table, waiting jobs, dead webhook deliveries |

The admin area's health panel shows failing webhooks, undelivered wake-ups, repository syncs with errors and the last backup. The dashboard shows the same health part to workspace admins whose sign-in or token is not limited to some projects, since its numbers are the whole workspace's; anyone else's dashboard has none.

## Optional programs on the server

| Program | Used for |
| --- | --- |
| `git` | Syncing a folder of Markdown files in a repository with pages. The server keeps only the last commit, and for a source with a folder only that folder (git 2.25 or later; an older git, or a remote that refuses a shallow clone, gets a whole copy) |
| `ffmpeg`, `ffprobe` | A sheet of stills for each uploaded clip, so agents can look at video cheaply |
| Chrome or Chromium | The render check: a picture of a task or page as a person sees it. Set `QUADIT_CHROME` if it is not on the path |
