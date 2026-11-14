#!/usr/bin/env bash
# Builds one binary per platform, with the web app inside, into dist/.
# The binary is pure Go, so every platform builds from any machine.
#
#   make release            (builds the web app first)
set -euo pipefail

version=${VERSION:-$(git describe --tags --always --dirty 2>/dev/null || echo dev)}
mkdir -p dist

for target in linux/amd64 linux/arm64 darwin/amd64 darwin/arm64; do
  os=${target%/*}
  arch=${target#*/}
  out="dist/quadit-${os}-${arch}"
  echo "building ${out}"
  CGO_ENABLED=0 GOOS="${os}" GOARCH="${arch}" \
    go build -tags web -trimpath -ldflags "-s -w -X main.version=${version}" -o "${out}" ./cmd/quadit
done

(cd dist && shasum -a 256 quadit-* > SHA256SUMS)
echo "done: version ${version}"
