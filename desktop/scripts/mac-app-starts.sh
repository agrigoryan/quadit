#!/bin/sh
# Starts a packaged macOS app and says whether it stays up: sh
# scripts/mac-app-starts.sh dist/mac-arm64/Quadit.app. macOS kills a signed
# app the moment it starts when it claims a right its signing does not
# carry (the keychain group without a provisioning profile did that), and
# nothing short of starting it shows that. For a build machine: it opens
# the app's window.
set -eu
app=${1:?usage: mac-app-starts.sh APP}
"$app/Contents/MacOS/$(basename "$app" .app)" &
pid=$!
sleep 20
if kill -0 "$pid" 2>/dev/null; then
  echo "$app is running."
  kill "$pid"
  exit 0
fi
code=0
wait "$pid" || code=$?
echo "::error::$app stopped by itself, with status $code."
log show --last 2m --style compact --predicate 'process == "amfid" OR (process == "kernel" AND eventMessage CONTAINS "AMFI")' | tail -30
exit 1
