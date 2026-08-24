#!/bin/sh
# Entrypoint for Dockerfile.worker, shared by both Render Docker services.
# Starts the connectivity daemon the environment asks for, then execs the app:
#
#   TOR_SOCKS_PROXY set    -> start Tor, wait for full bootstrap (Tor accepts
#                             SOCKS connections before it can build circuits,
#                             so a plain port check isn't enough)
#   TAILSCALE_AUTHKEY set  -> start tailscaled (userspace networking, SOCKS5
#                             on 127.0.0.1:1055) and join the tailnet; pair
#                             with RPC_SOCKS_PROXY=socks5h://127.0.0.1:1055
#                             and clear TOR_SOCKS_PROXY (see README pattern 3)
#   neither                -> no daemon; direct RPC only
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

if [ -n "${TAILSCALE_AUTHKEY:-}" ]; then
  # Userspace networking needs no TUN device or root; state in /tmp means the
  # node re-registers on every boot, so use a REUSABLE + EPHEMERAL auth key
  # (ephemeral nodes clean themselves out of the tailnet after they vanish).
  mkdir -p /tmp/tailscale
  tailscaled --tun=userspace-networking \
    --statedir=/tmp/tailscale \
    --socket=/tmp/tailscale/tailscaled.sock \
    --socks5-server=127.0.0.1:1055 \
    > /tmp/tailscaled.log 2>&1 &

  echo 'worker-entrypoint: joining tailnet'
  waited=0
  # Retries cover the gap until tailscaled's control socket is listening.
  until tailscale --socket=/tmp/tailscale/tailscaled.sock up \
      --authkey="$TAILSCALE_AUTHKEY" \
      --hostname="${TAILSCALE_HOSTNAME:-atlas-render}" 2>/dev/null; do
    waited=$((waited + 1))
    if [ "$waited" -gt 90 ]; then
      echo 'worker-entrypoint: Tailscale did not come up within 90s' >&2
      tail -20 /tmp/tailscaled.log >&2 || true
      exit 1
    fi
    sleep 1
  done
  echo 'worker-entrypoint: Tailscale up'
fi

[ "$#" -gt 0 ] || set -- node src/sync.js
exec "$@"
