#!/bin/sh
# Installs the quadit binary from a GitHub release.
#
#   curl -fsSL https://raw.githubusercontent.com/agrigoryan/quadit/main/install.sh | sh
#
# Settings, all optional:
#   QUADIT_VERSION      a release tag such as v0.1.0; default the newest server
#                       release (the highest vX.Y.Z, so no pre-release)
#   QUADIT_INSTALL_DIR  where the binary goes; default /usr/local/bin if it can
#                       be written to, else ~/.local/bin
#   QUADIT_RELEASES_URL where releases are downloaded from; default
#                       https://github.com/agrigoryan/quadit/releases (for testing
#                       against a copy laid out the same way)
#   QUADIT_RELEASES_API the GitHub API's list of those releases, where the
#                       newest is looked up; default
#                       https://api.github.com/repos/agrigoryan/quadit/releases
set -eu

releases=${QUADIT_RELEASES_URL:-https://github.com/agrigoryan/quadit/releases}
releases_api=${QUADIT_RELEASES_API:-https://api.github.com/repos/agrigoryan/quadit/releases}
version=${QUADIT_VERSION:-latest}

fail() {
	echo "quadit install: $*" >&2
	exit 1
}

case $(uname -s) in
Linux) os=linux ;;
Darwin) os=darwin ;;
*) fail "no release for $(uname -s): build from source (https://github.com/agrigoryan/quadit)" ;;
esac

case $(uname -m) in
x86_64 | amd64) arch=amd64 ;;
arm64 | aarch64) arch=arm64 ;;
*) fail "no release for $(uname -m): build from source (https://github.com/agrigoryan/quadit)" ;;
esac

if command -v curl >/dev/null 2>&1; then
	fetch() { curl -fsSL -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
	fetch() { wget -qO "$2" "$1"; }
else
	fail "needs curl or wget"
fi

if command -v sha256sum >/dev/null 2>&1; then
	sha256() { sha256sum "$1" | cut -d ' ' -f 1; }
elif command -v shasum >/dev/null 2>&1; then
	sha256() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
else
	fail "needs sha256sum or shasum to check the download"
fi

archive="quadit_${os}_${arch}.tar.gz"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# The newest server release, from the API: the highest vX.Y.Z tag. Not
# GitHub's "Latest", whatever it is at the moment: the desktop app is
# released from the same repository (desktop-v1.2.3). JSON without jq: each
# member on a line of its own; a tag_name in a release's notes has its
# quotes escaped and does not match.
newest_release() {
	fetch "$releases_api?per_page=100" "$tmp/releases.json" || return 1
	# shellcheck disable=SC2020 # one newline for each of the three characters, as meant
	tr ',{}' '\n\n\n' <"$tmp/releases.json" |
		sed -n 's/^[[:space:]]*"tag_name":[[:space:]]*"v\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)"[[:space:]]*$/\1/p' |
		sort -t . -k 1,1n -k 2,2n -k 3,3n | tail -n 1
}

if [ "$version" = latest ]; then
	newest=$(newest_release) || newest=""
	if [ -n "$newest" ]; then
		version="v$newest"
	else
		echo "quadit install: could not list the releases ($releases_api); taking the one GitHub marks Latest" >&2
	fi
fi
case $version in
latest) base="$releases/latest/download" ;;
v*) base="$releases/download/$version" ;;
*)
	version="v$version"
	base="$releases/download/$version"
	;;
esac

echo "Downloading $archive ($version)"
fetch "$base/$archive" "$tmp/$archive" || fail "could not download $base/$archive"
fetch "$base/checksums.txt" "$tmp/checksums.txt" || fail "could not download $base/checksums.txt"

want=$(awk -v f="$archive" '$2 == f { print $1 }' "$tmp/checksums.txt")
[ -n "$want" ] || fail "checksums.txt does not list $archive"
got=$(sha256 "$tmp/$archive")
[ "$want" = "$got" ] || fail "checksum mismatch for $archive: expected $want, got $got"

tar -xzf "$tmp/$archive" -C "$tmp" quadit

if [ -n "${QUADIT_INSTALL_DIR:-}" ]; then
	dir=$QUADIT_INSTALL_DIR
elif [ -w /usr/local/bin ]; then
	dir=/usr/local/bin
else
	dir="$HOME/.local/bin"
fi
mkdir -p "$dir"
# "quadit 0.1.0 (agent surface 2.0)" -> 0.1.0
version_of() { "$1" version 2>/dev/null | awk '{ print $2 }'; }
old=""
if [ -x "$dir/quadit" ]; then
	old=$(version_of "$dir/quadit")
fi
# Into place in one step, so a running quadit is never half overwritten.
cp "$tmp/quadit" "$dir/.quadit.new"
chmod 755 "$dir/.quadit.new"
mv -f "$dir/.quadit.new" "$dir/quadit"
new=$(version_of "$dir/quadit")

if [ -z "$old" ]; then
	echo "Installed quadit $new to $dir/quadit"
elif [ "$old" = "$new" ]; then
	echo "quadit $new was already installed in $dir/quadit; installed it again"
else
	echo "Updated quadit $old -> $new in $dir/quadit"
	echo "Restart a running server to use it: the database is upgraded when it starts (docs/install.md#upgrades)."
fi
case ":$PATH:" in
*":$dir:"*)
	found=$(command -v quadit || true)
	if [ -n "$found" ] && [ "$found" != "$dir/quadit" ]; then
		echo "Note: $found comes first in your PATH and is $(version_of "$found"); remove it or put $dir first."
	fi
	;;
*) echo "Add $dir to your PATH to run it as quadit." ;;
esac

cat <<'EOF'

Next:
  quadit serve                          start a server: http://localhost:4780, data in ./data
  quadit login URL TOKEN                or connect to a server as an agent
  quadit skill install                  teach your coding agents Quadit

Docs: https://github.com/agrigoryan/quadit#readme
EOF
