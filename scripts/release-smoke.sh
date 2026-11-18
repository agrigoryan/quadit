#!/bin/sh
# release-smoke.sh [DIST]: start what a release ships, the way a person
# installing it would, before anything is published. DIST is GoReleaser's
# output (default dist/, from `goreleaser release --snapshot --clean`, which
# loads one image per platform into the local Docker).
#
# For the platform Docker runs on (amd64 on CI, arm64 on an Apple machine):
#   1. the archive: unpacked in a clean Debian, `quadit version` says the
#      release's version, `quadit serve` on an empty data folder answers
#      /readyz;
#   2. the .deb: holds the licence files, installs in a clean Debian,
#      `quadit version` runs, the service unit and the service's user are
#      there;
#   3. the image: started on an empty volume, it answers /readyz.
#
# Needs docker, curl and jq.
set -eu

dist=${1:-dist}
dist=$(cd "$dist" && pwd)
version=$(jq -r .version "$dist/metadata.json")
arch=$(docker version --format '{{.Server.Arch}}')
debian=debian:stable-slim
port=47811
started=""

cleanup() {
	for c in $started; do
		docker rm -f "$c" >/dev/null 2>&1 || true
	done
}
trap cleanup EXIT

say() { printf '\n== %s\n' "$*"; }

# ready waits for a server's /readyz to answer 200, for up to a minute, and
# shows the container's log when it never does.
ready() {
	name=$1
	for _ in $(seq 60); do
		if curl -fsS "http://127.0.0.1:$port/readyz" >/dev/null 2>&1; then
			echo "ready"
			return 0
		fi
		sleep 1
	done
	echo "$name never became ready; its log:" >&2
	docker logs "$name" >&2 || true
	return 1
}

say "archive quadit_linux_$arch.tar.gz"
name=quadit-smoke-archive
started="$started $name"
docker run -d --name "$name" -p "127.0.0.1:$port:4780" -v "$dist:/dist:ro" "$debian" sh -ec "
	mkdir /opt/quadit && tar -xzf /dist/quadit_linux_$arch.tar.gz -C /opt/quadit
	test -f /opt/quadit/LICENSE && test -f /opt/quadit/THIRD_PARTY_NOTICES
	/opt/quadit/quadit version | tee /tmp/version
	grep -qF '$version' /tmp/version
	exec /opt/quadit/quadit serve --listen :4780 --data /tmp/data" >/dev/null
ready "$name"
docker logs "$name" 2>&1 | head -n 1
docker rm -f "$name" >/dev/null

say "package quadit_*_$arch.deb"
deb=$(cd "$dist" && ls quadit_*_"$arch".deb)
# A slim Debian leaves /usr/share/doc out of what it installs, so the
# licence files are looked for in the package itself.
docker run --rm -e DEBIAN_FRONTEND=noninteractive -v "$dist:/dist:ro" "$debian" sh -ec "
	dpkg-deb -c /dist/$deb | grep -q ' ./usr/share/doc/quadit/LICENSE\$'
	dpkg-deb -c /dist/$deb | grep -q ' ./usr/share/doc/quadit/THIRD_PARTY_NOTICES\$'
	apt-get install -y -qq /dist/$deb >/dev/null
	quadit version
	test -f /usr/lib/systemd/system/quadit.service
	getent passwd quadit >/dev/null"

say "image ghcr.io/agrigoryan/quadit:$version-$arch"
name=quadit-smoke-image
started="$started $name"
docker run -d --name "$name" -p "127.0.0.1:$port:4780" "ghcr.io/agrigoryan/quadit:$version-$arch" >/dev/null
ready "$name"
docker exec "$name" quadit version
docker exec "$name" test -f /usr/share/doc/quadit/THIRD_PARTY_NOTICES

say "every check passed"
