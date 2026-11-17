#!/bin/sh
# After the package is installed or upgraded: the quadit user and its data
# directory for the service, and a restart of the service if it was running,
# so an upgrade takes effect. The service is never enabled or started here.
set -e

if ! getent group quadit >/dev/null; then
	groupadd --system quadit
fi
if ! getent passwd quadit >/dev/null; then
	useradd --system --gid quadit --home-dir /var/lib/quadit --no-create-home \
		--shell /usr/sbin/nologin --comment "Quadit" quadit
fi
mkdir -p /var/lib/quadit
chown quadit:quadit /var/lib/quadit
chmod 750 /var/lib/quadit

if [ -d /run/systemd/system ]; then
	systemctl daemon-reload || true
	systemctl try-restart quadit.service || true
fi
