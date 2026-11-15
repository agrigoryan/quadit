# Quadit build. "make" builds the binary with the web app inside it.

VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -X main.version=$(VERSION)

.PHONY: all build server web test test-all lint dev seed clean fmt release image

all: build

# The full product: web app built, then embedded in the binary.
build: web
	go build -tags web -ldflags "$(LDFLAGS)" -o bin/quadit ./cmd/quadit

# The server and CLI only, with no web app inside (fast, for API work).
server:
	go build -ldflags "$(LDFLAGS)" -o bin/quadit ./cmd/quadit

web:
	cd web && pnpm install --frozen-lockfile && pnpm build

test:
	go test ./...

# Both databases. Needs Postgres: docker start quadit-pg
test-all:
	QUADIT_TEST_POSTGRES='postgres://postgres:quadit@127.0.0.1:54329/quadit' go test -race ./...
	cd web && pnpm typecheck

# The rules of docs/code-style.md that a tool can check (.golangci.yml).
GOLANGCI ?= go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.15.0
lint:
	$(GOLANGCI) run ./...

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
