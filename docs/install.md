# Running Quadit

One binary serves the web app, the API and the background work. By default it keeps one SQLite file and the uploaded files in a data directory.

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
| `auth.oidc` | The same, plus `"issuer"` and a `"name"` for the button. Any OpenID Connect provider |
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
| `s3` | `bucket`, `region`, `access_key`, `secret_key`; `endpoint` for Cloudflare R2, MinIO and other S3-compatible stores |
| `gcs` | `bucket`, and `credentials` (a service account key as JSON) or the machine's own identity |
| `azure` | `bucket` (the container), `account`, `account_key` |

Switching from disk to a cloud store needs no downtime: new files go to the cloud at once, old ones are still served from disk, and a background job copies them over.

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

## Upgrades

Replace the binary and start it; or, to do the database step by itself first, run `quadit upgrade`. If the new version changes the schema, a copy of the database as it was is made before anything is changed:

- on SQLite, a file beside it (`quadit.sqlite.before-vN`);
- on Postgres, a database beside it on the same server (`<name>_before_vN`). This needs the database to itself for a moment and a role allowed to create databases; if the copy cannot be made, nothing is changed and the server says why. With several servers on one database, stop them all first.

To go back: stop the server, run `quadit upgrade --undo` (it puts the copy in place and keeps the upgraded database beside it), and start the older binary.

Agents are not broken by an upgrade: the API stays at `/api/v1`, and the list of changes, their arguments, the MCP tools and the command-line tool's commands only ever gain things within a major version. `GET /api/v1/changes` says which surface version a server speaks.

## HTTPS

Passkeys and phone notifications need HTTPS. Three ways:

- `quadit serve --tls-domain quadit.example.com` gets a certificate from Let's Encrypt and renews it by itself. Ports 443 and 80 must reach the server.
- `quadit serve --tls-cert cert.pem --tls-key key.pem` uses a certificate of your own.
- or keep plain HTTP on `:4780` behind a proxy that terminates HTTPS (Caddy, nginx, a tunnel), and set `--url https://…`.

## Several servers

More than one copy of the server can share a Postgres database and a cloud file store (not SQLite, and not files on local disk). Sessions, cursors, task leases, job claims, rate counts, page presence and uploads in progress are all in the database or the file store, and a write taken by one server wakes the live connections held by the others.

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
| `/readyz` | The database answers |
| `/metrics` | Prometheus counters: requests, rows per table, waiting jobs, dead webhook deliveries |

The admin area's health panel shows failing webhooks, undelivered wake-ups, repository syncs with errors and the last backup.

## Optional programs on the server

| Program | Used for |
| --- | --- |
| `git` | Syncing a folder of Markdown files in a repository with pages |
| `ffmpeg`, `ffprobe` | A sheet of stills for each uploaded clip, so agents can look at video cheaply |
| Chrome or Chromium | The render check: a picture of a task or page as a person sees it. Set `QUADIT_CHROME` if it is not on the path |

## Development database

Tests run on SQLite always, and on Postgres when `QUADIT_TEST_POSTGRES` holds a URL:

```bash
docker run -d --name quadit-pg -e POSTGRES_PASSWORD=quadit -e POSTGRES_DB=quadit -p 127.0.0.1:54329:5432 postgres:17-alpine
make test-all
```

## Checking against real services

The test suite runs without a network. Three of its checks also run against real services when told where they are:

```
# S3 (AWS, R2, MinIO), Azure Blob and Google Cloud Storage: the store's settings as JSON, as the admin area saves them
QUADIT_TEST_FILES_S3='{"kind":"s3","bucket":"quadit","endpoint":"http://127.0.0.1:9000","region":"us-east-1","access_key":"…","secret_key":"…"}' \
QUADIT_TEST_FILES_AZURE='{"kind":"azure","bucket":"quadit","account":"…","account_key":"…"}' \
QUADIT_TEST_FILES_GCS='{"kind":"gcs","bucket":"quadit","credentials":"{…service account key…}"}' \
  go test -run TestRealBuckets ./internal/blob
```

What has been run this way, and by hand against a live server: file storage on MinIO (uploads, ranges, and moving an install's files from disk to the bucket), Azurite and a Google Cloud Storage emulator; mail through an SMTP server (test message, invitation, password reset, following the links); OpenID Connect sign-in with Dex in a browser; GitHub pull request and check linking against github.com; browser push through Google's push service to Chrome. Sign-in with Google and with GitHub themselves need your own OAuth app, and are the same code as OpenID Connect and the GitHub tests: try them once after you set them up.
