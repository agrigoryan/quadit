# Quadit build. "make" builds the binary with the web app inside it.

VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -X main.version=$(VERSION)

.PHONY: all build server web generate test test-all e2e lint dev seed clean fmt release image

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

# The rules of docs/code-style.md that a tool can check: .golangci.yml for
# Go, web/.oxlintrc.json and Prettier for the web app. CI runs this, so the
# version here is the one that gates.
GOLANGCI ?= go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.15.0
lint:
	$(GOLANGCI) run ./...
	cd web && pnpm install --frozen-lockfile && pnpm lint && pnpm format:check

# A local server on :4780 with data in ./data.
dev: server
	QUADIT_DATA=./data ./bin/quadit serve --listen 127.0.0.1:4780

# Fill a fresh local server with a little of everything.
seed:
	./scripts/dev-seed.sh

fmt:
	gofmt -w cmd internal

# Binaries for Linux and macOS, x86 and ARM, in dist/.
release: web
	VERSION=$(VERSION) ./scripts/release.sh

# The Docker image.
image:
	docker build --build-arg VERSION=$(VERSION) -t quadit:$(VERSION) .

clean:
	rm -rf bin web/dist
