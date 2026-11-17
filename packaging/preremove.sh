#!/bin/sh
# Before the package is removed (not upgraded): stop and disable the service.
# The data in /var/lib/quadit and the quadit user stay.
set -e

# dpkg passes "remove" or "purge"; rpm passes 0 when nothing of the package
# will be left, and 1 or more on an upgrade.
case "${1:-}" in
remove | purge | 0) ;;
*) exit 0 ;;
esac

if [ -d /run/systemd/system ]; then
	systemctl disable --now quadit.service || true
fi
