#!/bin/sh
# Entrypoint for Dockerfile.worker, shared by both Render Docker services:
# if TOR_SOCKS_PROXY is set, start a local Tor daemon and wait for it to
# fully bootstrap before launching the app (Tor accepts SOCKS connections
# before it can actually build circuits, so a plain port check isn't enough).
#
# Runs the command passed as arguments, defaulting to the sync worker:
#   ./worker-entrypoint.sh                    -> node src/sync.js  (atlas-sync)
#   ./worker-entrypoint.sh node src/api.js    -> the read API      (atlas-api)
set -eu

if [ -n "${TOR_SOCKS_PROXY:-}" ]; then
  tor --SocksPort 127.0.0.1:9050 --DataDirectory /tmp/tor-data \
    --Log 'notice stdout' 2>&1 | tee /tmp/tor.log &

  echo 'worker-entrypoint: waiting for Tor to bootstrap'
  waited=0
  until grep -q 'Bootstrapped 100' /tmp/tor.log 2>/dev/null; do
    waited=$((waited + 1))
    if [ "$waited" -gt 180 ]; then
      echo 'worker-entrypoint: Tor did not bootstrap within 180s' >&2
      exit 1
    fi
    sleep 1
  done
  echo 'worker-entrypoint: Tor ready'
fi

[ "$#" -gt 0 ] || set -- node src/sync.js
exec "$@"
