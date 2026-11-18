#!/bin/sh
# Checks install.sh against a copy of the repository's releases laid out as
# GitHub serves them, on a local web server: the archives under
# releases/download/<tag>/, GitHub's "Latest" under releases/latest/download/,
# and the API's list of releases. The newest server release is v0.2.0; a
# desktop release (desktop-v0.3.0, no server archives) is newer and is what
# GitHub marks Latest, and a server pre-release (v0.3.0-rc.1) is newer still.
#
#   sh scripts/install-test.sh
#
# Needs python3 (the web server), tar and sha256sum or shasum.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
server=""
# shellcheck disable=SC2154 # status is assigned in the trap itself
trap 'status=$?; if [ -n "$server" ]; then kill "$server"; wait "$server" 2>/dev/null || :; fi; rm -rf "$work"; exit "$status"' EXIT

case $(uname -s) in
Linux) os=linux ;;
Darwin) os=darwin ;;
esac
case $(uname -m) in
x86_64 | amd64) arch=amd64 ;;
arm64 | aarch64) arch=arm64 ;;
esac
archive="quadit_${os}_${arch}.tar.gz"
if command -v sha256sum >/dev/null 2>&1; then
	sha256() { sha256sum "$1" | cut -d ' ' -f 1; }
else
	sha256() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
fi

# A server release: a "quadit" that tells its version, in its archive, with its checksums.
server_release() {
	dir="$work/site/releases/$1"
	mkdir -p "$dir" "$work/build/$2"
	printf '#!/bin/sh\necho "quadit %s (agent surface 2.0)"\n' "$2" >"$work/build/$2/quadit"
	chmod 755 "$work/build/$2/quadit"
	tar -czf "$dir/$archive" -C "$work/build/$2" quadit
	echo "$(sha256 "$dir/$archive")  $archive" >"$dir/checksums.txt"
}
server_release download/v0.1.0 0.1.0
server_release download/v0.2.0 0.2.0
server_release download/v0.3.0-rc.1 0.3.0-rc.1
mkdir -p "$work/site/releases/download/desktop-v0.3.0" "$work/site/releases/latest/download"
echo "Quadit-0.3.0-mac-arm64.dmg" >"$work/site/releases/download/desktop-v0.3.0/Quadit-0.3.0-mac-arm64.dmg"
cp "$work/site/releases/download/desktop-v0.3.0/"* "$work/site/releases/latest/download/"

# The API's list, newest first, compact as the API sends it to a script. A
# release's notes can hold anything, a tag_name in quotes among it.
mkdir -p "$work/site/api"
printf '%s' '[{"tag_name":"desktop-v0.3.0","prerelease":false,"body":"Not \"tag_name\": \"v9.9.9\", {}"},' \
	'{"tag_name":"v0.3.0-rc.1","prerelease":true},{"tag_name":"v0.2.0","prerelease":false},' \
	'{"tag_name":"v0.1.0","prerelease":false}]' >"$work/site/api/releases"

python3 -u -m http.server 0 --bind 127.0.0.1 --directory "$work/site" >"$work/server.log" 2>&1 &
server=$!
port=""
for _ in $(seq 50); do
	port=$(sed -n 's/.*port \([0-9][0-9]*\).*/\1/p' "$work/server.log" | head -n 1)
	[ -n "$port" ] && break
	sleep 0.1
done
[ -n "$port" ] || {
	cat "$work/server.log"
	exit 1
}
site="http://127.0.0.1:$port"

failed=0
# check NAME WANT [VAR=VALUE...]: installs with the settings given and checks the version installed.
check() {
	name=$1 want=$2
	shift 2
	dir="$work/bin-$(echo "$name" | tr -c 'a-z0-9' -)"
	got=$(env QUADIT_RELEASES_URL="$site/releases" QUADIT_RELEASES_API="$site/api/releases" \
		QUADIT_INSTALL_DIR="$dir" "$@" sh "$root/install.sh" >"$work/out" 2>&1 && "$dir/quadit" version | awk '{ print $2 }') || got="(failed)"
	if [ "$got" = "$want" ]; then
		echo "ok    $name"
	else
		echo "FAIL  $name: installed $got, want $want"
		sed 's/^/      /' "$work/out"
		failed=1
	fi
}

check "the newest server release, not GitHub's Latest" 0.2.0
check "a version asked for" 0.1.0 QUADIT_VERSION=0.1.0
check "a pre-release asked for" 0.3.0-rc.1 QUADIT_VERSION=v0.3.0-rc.1
# Without the API (out of its hourly allowance, say) it falls back on Latest,
# which here is a desktop release: the install fails rather than install something else.
check "no API, and Latest is not a server release" "(failed)" QUADIT_RELEASES_API="$site/api/missing"
grep -q "could not download" "$work/out" || {
	echo "FAIL  no API: did not say why"
	failed=1
}

exit $failed
