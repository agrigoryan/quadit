# Quadit build. "make" builds the binary with the web app inside it.

# The server's own tags only (v*): the desktop app's (desktop-v*) are another product's.
VERSION ?= $(shell git describe --tags --match 'v*' --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -X main.version=$(VERSION)

.PHONY: all build server web generate test test-all e2e lint notices dev seed clean fmt release smoke image desktop desktop-e2e

all: build

# The full product: web app built, then embedded in the binary.
build: web
	go build -tags web -ldflags "$(LDFLAGS)" -o bin/quadit ./cmd/quadit

# The server and CLI only, with no web app inside (fast, for API work).
server:
	go build -ldflags "$(LDFLAGS)" -o bin/quadit ./cmd/quadit

web:
	cd web && pnpm install --frozen-lockfile && pnpm build

# The web app's types generated from the server: every change and its
# arguments, and every row (the guard rows.check.ts holds the web's own row
# types to). A test (cmd/webtypes) fails until this is run after an argument
# or a row changes.
generate:
	go run ./cmd/webtypes

test:
	go test ./...

# Both databases. Needs Postgres: docker start quadit-pg
test-all:
	QUADIT_TEST_POSTGRES='postgres://postgres:quadit@127.0.0.1:54329/quadit' go test -race -timeout 30m ./...
	cd web && pnpm typecheck && pnpm test

# The end-to-end suite: Chromium drives the binary just built, on a server of
# its own (web/e2e). The browser is installed once with:
#   cd web && pnpm exec playwright install chromium
e2e: build
	cd web && pnpm e2e

# The code-style rules a tool can check (CONTRIBUTING.md has the rest):
# .golangci.yml for Go, web/.oxlintrc.json and Prettier for the web app. CI runs this, so the
# version here is the one that gates.
GOLANGCI ?= go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.15.0
lint:
	$(GOLANGCI) run ./...
	cd web && pnpm install --frozen-lockfile && pnpm lint && pnpm format:check

# THIRD_PARTY_NOTICES from the Go modules and web packages a release holds
# (scripts/notices). CI checks it is current and that no dependency is under
# the GPL, the LGPL or the AGPL: go run ./scripts/notices -check.
notices:
	cd web && pnpm install --frozen-lockfile
	go run ./scripts/notices

# The desktop app (desktop/): its packages for this system, unsigned unless
# the signing environment is set (desktop/electron-builder.config.cjs), into
# desktop/dist/. On macOS and Linux they carry the quadit command, built
# with Go for each architecture (desktop/scripts/cli.mjs).
desktop:
	cd desktop && pnpm install --frozen-lockfile && pnpm dist

# The desktop app's end-to-end suite: Playwright drives the app against a
# server built from this tree, on a port and data directory of its own, with
# Chromium playing the system browser in the sign-in hand-off.
desktop-e2e: build
	cd desktop && pnpm install --frozen-lockfile && pnpm exec playwright install chromium && pnpm e2e

# A local server on :4780 with data in ./data.
dev: server
	QUADIT_DATA=./data ./bin/quadit serve --listen 127.0.0.1:4780

# Fill a fresh local server with a little of everything.
seed:
	./scripts/dev-seed.sh

fmt:
	gofmt -w cmd internal

# A release as GoReleaser makes it (.goreleaser.yaml), into dist/ and
# published nowhere: archives for Linux, macOS and Windows, x86 and ARM,
# checksums, the Homebrew cask and the Docker images. A tag v* pushed to
# GitHub makes the real one. Its version follows the server's newest tag,
# not a desktop app's (desktop-v*), which GoReleaser would take otherwise.
release:
	GORELEASER_CURRENT_TAG=$$(git describe --tags --match 'v*' --abbrev=0) goreleaser release --snapshot --clean

# Start what make release made, as the release workflow does before it
# publishes: the archive, the .deb and the image (scripts/release-smoke.sh).
smoke: release
	scripts/release-smoke.sh dist

# The Docker image.
image:
	docker build --build-arg VERSION=$(VERSION) -t quadit:$(VERSION) .

clean:
	rm -rf bin dist web/dist
