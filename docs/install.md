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
| `--url` | `QUADIT_BASE_URL` | `http://localhost:4780` | The address people use. Links in mail, passkeys and file addresses need it right, and so does a change made in a browser too old to say which page it comes from: a write sent with the sign-in cookie is taken only from the server's own pages |
| | `QUADIT_SECRET` | a file made in the data directory (`secret.key`) | Encrypts stored secrets (two-step sign-in codes, the vault, integration tokens, mail and storage passwords). Backups do not hold it: keep a copy apart from them (see [Backups](#backups)) |
| `--log-json` | `QUADIT_LOG=json` | text | Structured logs |
| `--trusted-proxies` | `QUADIT_TRUSTED_PROXIES` | `127.0.0.1,::1` | The reverse proxies in front of the server, addresses or networks: only their `X-Forwarded-For` is believed ([below](#behind-a-proxy)). `--trusted-proxies=` (empty) trusts none |
| `--allow-private-networks` | `QUADIT_ALLOW_PRIVATE_NETWORKS` | none | Networks off the public internet the server may call for its users, e.g. `192.168.1.0/24,10.0.0.5` ([below](#addresses-users-give)) |
| `--stop-on-stdin-close` | | off | Shut down cleanly when standard input closes: for a program that starts the server and holds its input open while it wants it running (the desktop app's [own server](#a-server-on-this-computer)) |

Put it behind a reverse proxy for HTTPS. The proxy must not buffer responses (the live stream and held requests need that): for nginx, `proxy_buffering off`.

### Behind a proxy

The caller's address counts sign-in attempts and goes on the audit log. Behind a proxy, every connection comes from the proxy, which says whom it forwards for in `X-Forwarded-For`. The server believes that header only from the proxies named in `--trusted-proxies`, and takes the last address in it that is not one of them, so a caller cannot write its own. The default trusts this machine (`127.0.0.1,::1`): Caddy, nginx, `tailscale serve` or a tunnel on the same machine. A proxy elsewhere is named by its address: in Docker Compose, the network the proxy's container shares with Quadit's (`QUADIT_TRUSTED_PROXIES=172.16.0.0/12`, or the network's own range). Name only addresses nobody else can connect from: with Docker publishing Quadit's port to the world, a direct visitor may come from the same bridge address as the proxy.

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
| `auth.require_2fa` | `true` requires every sign-in to take two steps: a passkey, or a password or outside account followed by an app's code or the person's passkey. A session of one step reaches nothing until it has two (no workspace, no install administration, no change to the account's password, email, passkeys or codes): someone with no second step reaches only setting one up; sessions that signed in with one step before are asked for the second. A passkey counts as two steps because every passkey ceremony requires the device to check who holds it (a fingerprint, a face, a PIN): a security key with no PIN cannot be added or used |
| `auth.google`, `auth.github` | `{"enabled": true, "client_id": "…", "client_secret": "…"}`. Redirect address: `<url>/api/v1/auth/oauth/google/callback` |
| `auth.oidc` | The same, plus `"issuer"` and a `"name"` for the button. Any OpenID Connect provider. Add `"trust_email": true` only if the provider checks every address but does not say so: an address it does not call verified is otherwise not enough to sign in to the account that has it |
| `mail` | `{"host", "port", "username", "password", "from", "tls"}`. `tls` is `starttls` (default), `tls` or `none` |
| `files` | Where uploads go: see below |
| `files.max_mb` | Largest upload, default 250 |
| `backup` | `{"enabled": true, "hour": 3, "keep": 14, "copy_to": {"kind": "folder", "folder": "/mnt/backups"}}`: see [Backups](#backups) |
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

A cloud store set in the admin area is tried before it is kept, and refused if it does not take a test write. A cloud store that is set is never replaced by the local disk: while the server is opening it at start, and for as long as it cannot be used (its bucket not made yet, the store not up, a wrong key in `QUADIT_SETTING_FILES`), no file is stored or read, a request for one is answered `503` with `Retry-After`, and `/readyz` fails. The server tries the store again every minute at most, and says so in its log.

## Postgres

```bash
quadit serve --db 'postgres://quadit:secret@db.example.com:5432/quadit'
```

The schema is the same on both databases. To move an install from one to the other, take a backup on the old one and restore it on the new one.

## Backups

```bash
quadit backup --out /backups/quadit.tar.gz      # database and files in one archive, verified
quadit backup verify /backups/quadit.tar.gz
quadit restore /backups/quadit.tar.gz --secret-key /safe/place/secret.key   # into an empty install, on SQLite or Postgres
quadit restore FILE --workspace games --task SVA-12     # bring back one task
quadit restore FILE --workspace games --doc PAGE_ID     # or one page
```

An archive is the install at one moment, taken while it runs: every table as it stood when the backup began, and the uploaded files those rows name. Checking an archive (`verify`, and every backup after it is written) reads every member against its checksum and the rows against each other.

**Keep the install secret apart from your backups.** The archive does not hold `secret.key` from the data directory (or `QUADIT_SECRET`), which encrypts two-step sign-in codes, vault secrets, integration tokens and the mail and storage passwords; an archive that leaks does not give those away. Copy `secret.key` once to somewhere safe that is not where the archives go. A full restore checks the secret before it writes anything:

- `--secret-key FILE` gives the original secret. The restore checks that it opens the archive's secrets, and the restored install keeps it as its `secret.key` (the one the new, empty install made for itself is kept beside it as `secret.key.before-restore-…`). With `QUADIT_SECRET`, set it as it was set before and leave the flag out.
- Without the flag, the restore uses the install's own secret, and refuses, changing nothing, when that is not the one the archive was made with.
- `--without-secret-key` is for a secret that is lost for good: everything else is restored, and two-step sign-in, vault secrets, integrations, mail, file storage and backup bucket settings must be set up again.

An archive that does not say which secret it was made with cannot be checked, and a full restore refuses it. `--without-secret-key` restores it unchecked: its encrypted values open only if this install's secret (its `secret.key`, or `QUADIT_SECRET`) is the one they were sealed with, and must be set up again otherwise.

A full restore goes into an empty install. It reads the whole archive first and refuses a damaged one before writing anything; then it loads every row in one transaction. When it fails, the database is left empty and the files it stored are taken out again, so it can simply be run again. An archive holds no part of an upload that was still arriving: after a restore, such an upload is sent again from the start.

Scheduled backups are a switch in the admin area. Each one is read back and checked before it counts; the last one shows in the health panel. Deleted tasks, pages and files stay in the trash for 30 days first, and a file's bytes a day longer.

Archives are written to `backups` in the data directory, on the same disk as the data. To have each one also kept somewhere else, choose where in the admin area ("Also copy each backup to"), or set `copy_to` in the `backup` setting:

| `copy_to.kind` | Where each archive is copied |
| --- | --- |
| none (default) | nowhere: archives stay only beside the data |
| `files` | file storage, under `backups/`. This takes them off the machine only when file storage is a cloud bucket |
| `folder` | `folder`, an absolute path on the server: a mounted network drive or a synced folder. It must be there; the server does not make it |
| `bucket` | `bucket`, a cloud bucket of their own, set with the same fields as [file storage](#file-storage) (`kind` is `s3`, `gcs` or `azure`); its keys are stored encrypted the same way |

Every backup, scheduled or made with "Back up now", is copied once it is verified, under its own name (`quadit-YYYYMMDD-HHMMSS.tar.gz`). `keep` holds there too: after a copy gets there, the oldest copies beyond it are removed; other files in that place are left alone. Saving the setting tries the place first and refuses it, saying why, when it is not there or does not take a test write. Saving a folder puts a file `.quadit-backups` in it, and a copy goes only to a folder that has it, so an unmounted drive's empty mount point is refused, not filled (a folder set through `QUADIT_SETTING_BACKUP` needs that file made by hand). A copy that fails does not fail the backup: the archive is kept, and the reason is shown on it in the admin area, in the health panel and on the dashboards of workspace admins; the next backup tries again. `quadit backup --out` writes only where it is told.

The install secret is not in the copies either: keep `secret.key` somewhere that is neither the data directory nor where the copies go.

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
| The desktop app ([its own server](#a-server-on-this-computer)) | Install the newer app: it carries the newer server, which upgrades the database at its next start |

Then restart the server, if the upgrade did not. Take a backup first (`quadit backup --out …`, see [Backups](#backups)): it is the only copy of the files as well as the database.

**What an upgrade does to your data.** The server brings the database's schema up to its own version when it starts. Run `quadit upgrade` (with the same `--data` / `--db` as the server) to do that step by itself before starting it. When the new version changes the schema, a copy of the database as it was is made first, and if the copy cannot be made, nothing is changed and the server says why:

- on SQLite, a file beside it: `quadit.sqlite.before-vN`, where N is the schema version being upgraded to;
- on Postgres, a database beside it on the same server: `<name>_before_vN`. This needs the database to itself for a moment and a role allowed to create databases; with several servers on one database, stop them all first. Where that is not possible, take a backup yourself and set `QUADIT_UPGRADE_WITHOUT_COPY=1` to upgrade without the copy.

A release that does not change the schema makes no copy. Copies are not removed by Quadit: delete old ones once the new version has proved itself. Uploaded files are not copied; an upgrade does not change them.

**Going back.** A binary refuses a database that a newer version has upgraded ("database is at version 9, this binary knows 8: use a newer binary"), so an older version cannot simply be started again. To go back: stop the server, run `quadit upgrade --undo` with the newer binary (it puts the copy in its place and keeps the upgraded database beside it as `….after-vN` or `<name>_after_vN`), then install and start the older version. Anything written after the upgrade is in the upgraded database only, not in the copy: an upload that was under way goes on from where it stood at the upgrade, and one started after it is not there. A release that did not change the schema can be undone by installing the older version again.

Agents are not broken by an upgrade: the API stays at `/api/v1`, and the list of changes, their arguments, the MCP tools and the command-line tool's commands only ever gain things within a major version. `GET /api/v1/changes` says which surface version a server speaks. Run `quadit skill install` again on each agent's machine after upgrading the `quadit` command there.

## HTTPS

Passkeys and phone notifications need HTTPS. Three ways:

- `quadit serve --tls-domain quadit.example.com` gets a certificate from Let's Encrypt and renews it by itself. Ports 443 and 80 must reach the server.
  Another authority that speaks the same protocol (a company's own, for one) is named with `--acme-directory <url>`, with `--acme-ca <pem file>` when its own certificate is not publicly trusted; `--acme-http-listen` moves the plain-HTTP side off port 80.
- `quadit serve --tls-cert cert.pem --tls-key key.pem` uses a certificate of your own.
- or keep plain HTTP on `:4780` behind a proxy that terminates HTTPS (Caddy, nginx, a tunnel), and set `--url https://…`.

## Addresses users give

Some addresses the server calls are written by its users: a browser's push service, webhooks, the hosts a vault secret is bound to, a service to import from, a GitHub Enterprise. The server calls them only when they are on the public internet. An address on the server's own machine (`localhost`, `127.0.0.1`), on a private network (`10.x`, `172.16–31.x`, `192.168.x`, `fd00::/8`), link-local (the cloud metadata service at `169.254.169.254`), shared (`100.64.0.0/10`, Tailscale's) or reserved is refused, whatever name leads to it: the check is made on each connection as it opens, so a name that changes what it points to gains nothing. Redirects are not followed; a push service is reached over HTTPS only.

A webhook to an agent on the same machine or network, or a secret for a service inside it, needs that network opened: `--allow-private-networks 192.168.1.0/24,::1` (or `QUADIT_ALLOW_PRIVATE_NETWORKS`), networks or single addresses, split by commas. Open no more than is needed: anyone who may make a webhook can make the server call what is there. These calls use no proxy from the environment (`HTTPS_PROXY`).

## The desktop app

The Quadit desktop app opens a server's own web address in a window of its own; the server needs nothing turned on for it.

Download it from [Releases](https://github.com/agrigoryan/quadit/releases), under the newest `desktop-v…` release: the `.dmg` for macOS (`arm64` for Apple silicon, `x64` for Intel; drag Quadit to Applications), the `.exe` installer for Windows, or the AppImage or `.deb` for Linux. Builds so far are pre-releases and are not signed, so the system warns the first time one is opened:

- macOS refuses to open it. Allow it under System Settings → Privacy & Security, "Open Anyway", or run `xattr -dr com.apple.quarantine /Applications/Quadit.app` once.
- Windows SmartScreen says it protected the PC: choose "More info", then "Run anyway".

The app does not update itself: it tells you when a newer version is out, and you download it the same way.

It can also be a server itself, so that downloading it is the whole install: see [A server on this computer](#a-server-on-this-computer).

What the app adds to the web app:

- **Connect your agents.** Set Up Quadit… in the app menu finds the agent harnesses on the computer (Claude Code, Codex, Gemini CLI, Cursor, opencode, pi, GitHub Copilot) and sets each up to work in Quadit: with the `quadit` command and the skill, through Quadit's MCP server with the harness's own sign-in, or both. It shows every file it will change before changing it, keeps a copy of each, and Disconnect puts them back. [Connect from the desktop app](agents.md#connect-from-the-desktop-app) says what each choice writes.
- **Answer from a notification.** On macOS, a question's notification carries its options, and a mention's has a reply field.
- **The menu-bar icon** lists the questions waiting on you, which you can answer there, and what each agent is doing.
- **Quick capture.** Alt+Cmd+N (Alt+Ctrl+N on Windows and Linux) opens a small window that makes a task or a page from anywhere; the shortcut can be turned off in Set Up Quadit….
- **Open in desktop app**, in the web app's user menu in a browser, opens the same page in the app.


- Adding a server, the app asks `GET /api/v1/version` (no sign-in needed) whether the address is a Quadit server and which version of the sign-in hand-off it speaks.
- Passkeys and Google, GitHub or OpenID Connect sign-in do not work inside the app's window, so the app signs in through the system browser: it opens `/desktop/connect` there, the person signs in as usual (second step included) and presses Continue, and the browser hands the app a code that works once, for two minutes. The app trades it at `/desktop/finish` for a session of its own, of the steps the browser's session took: a browser signed in with one step hands over a session that still owes the second, where one is owed. That address answers only the app's own windows, so no link or page can sign a browser in with a code made for another account.
- The browser hands the app this server's address as set with `--url`, and the app checks it is the address it was given: add the server in the app by that same address.
- `/desktop/finish` answers only the app's own load of it, which carries the header `X-Quadit-Handoff: 1`: a proxy in front of the server must pass that header on (proxies do unless told otherwise). Its address carries the code and the app's secret for it, so keep query strings of `/desktop/finish` out of the proxy's access log.
- The app adds a server over plain `http://` without asking only on this computer or a private network (a private address, `localhost`, a `.local`, `.home.arpa` or `.internal` name); anywhere else it asks first, and says the connection is not encrypted.
- The app's session is listed under Settings → Sign-in and security, Signed-in browsers, as "Quadit desktop", and is signed out there like any browser. Each hand-off is in the audit log as a sign-in with the method `desktop`.
- The app shows a notification for each new inbox item of the workspace open in it, from the live connection (it has no push). "Send push notifications" off, under Settings → Notifications, turns these off too.

### A server on this computer

The app can run Quadit for you on the computer it is on, with no terminal: choose **Run Quadit on this computer** on its first start (step 1 of setup), in the server list, or under File → Run Quadit on This Computer…. It starts the `quadit` it carries (the same server, with the web app inside), adds it to the server list as "This computer", and opens its first-run page in a window, where you make your account and the first workspace and are signed in. It can sit in the list beside servers elsewhere.

- macOS and Linux. The Windows app has no server to run.
- The server runs while the app does: the app starts it when it starts, and tells it to stop when you quit; the server finishes what it is doing on its own, without holding up the quit or a logout. Closing the windows leaves the app in the menu bar (the tray on Linux) and the server running. If the app ends any other way, the server stops with it (`quadit serve --stop-on-stdin-close`). On macOS, "Start Quadit when I log in" (in the server list, and in File → Server on This Computer) starts the app at login without opening a window.
- It listens on this computer only, at `http://127.0.0.1:4780`, or at another free port when 4780 was taken when it was first set up. That address never changes afterwards, because sign-ins and agents' settings are tied to it: if the port is still held a few seconds into a later start, the app says another program has it instead of moving, and you start the server again once the port is free. Other devices cannot reach it, and it trusts no proxy (`--trusted-proxies=`): everything reaches it directly. Passkeys are off for it (`QUADIT_SETTING_AUTH_PASSKEYS=false`), since a passkey cannot be made for an address that is a number like `127.0.0.1`: sign in with your password. Until it runs, its window shows why it cannot be reached rather than loading its address, which another program may hold.
- Its data is the folder `server` in the app's own data folder: `~/Library/Application Support/Quadit/server` on macOS, `~/.config/Quadit/server` on Linux. The app never deletes it. Removing "This computer" from the server list stops the server and keeps the folder; running Quadit on this computer again uses it. Show Data Folder and Show Log open it. Its log is `server.log` there, started anew at a start once it is over 5 MB, with the one before kept as `server.log.1`.
- The server list shows whether it is starting, running, stopped or failed (with the reason and the last lines of its log), with Start, Stop and Restart; File → Server on This Computer has the same. If it exits on its own, the app starts it again, up to three times, then shows it as failed.
- It gets the PATH of your login shell, so the [optional programs](#optional-programs-on-the-server) (`git`, `ffmpeg`, Chrome) are found as they are in a terminal, even when the app was opened from the Dock.
- `quadit backup` and the other commands work on it as on any server, with `--data` set to that folder. A newer app carries a newer server, which upgrades the database at its first start, copying it first ([Upgrades](#upgrades)).

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
