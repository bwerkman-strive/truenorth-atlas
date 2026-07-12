#!/usr/bin/env bash
# Scratch Postgres for the integration test suite — throwaway by design;
# the tests TRUNCATE its tables. Never point it at real data.
#
#   scripts/scratch-db.sh start|stop|status
#
# Uses `docker compose up -d db` when Docker is available; otherwise falls
# back to a local Homebrew postgresql@16 instance with the same contract:
#   postgres://atlas:atlas@localhost:5433/atlas_test
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CMD="${1:-start}"
PORT=5433
DATA_DIR="${TN_SCRATCH_PGDATA:-$HOME/.local/state/truenorth-atlas/pgdata}"

have_docker() { command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; }

pgbin() {
  local prefix
  prefix="$(brew --prefix postgresql@16 2>/dev/null)" || {
    echo "Neither Docker nor Homebrew postgresql@16 found." >&2
    echo "Install one:  brew install postgresql@16   (or Docker Desktop / colima)" >&2
    exit 1
  }
  echo "$prefix/bin"
}

case "$CMD" in
  start)
    if have_docker; then
      exec docker compose -f "$ROOT/docker-compose.yml" up -d db
    fi
    BIN="$(pgbin)"
    if [ ! -d "$DATA_DIR" ]; then
      mkdir -p "$DATA_DIR"
      "$BIN/initdb" -D "$DATA_DIR" -U atlas --pwfile=<(echo atlas) -A md5 --no-locale -E UTF8 >/dev/null
    fi
    if ! "$BIN/pg_ctl" -D "$DATA_DIR" status >/dev/null 2>&1; then
      # TCP-only: unix sockets need a short path and nothing here uses them.
      "$BIN/pg_ctl" -D "$DATA_DIR" -o "-p $PORT -c unix_socket_directories=''" \
        -l "$DATA_DIR/pg.log" -w start
    fi
    PGPASSWORD=atlas "$BIN/createdb" -h localhost -p "$PORT" -U atlas atlas_test 2>/dev/null || true
    echo "scratch db ready: postgres://atlas:atlas@localhost:$PORT/atlas_test"
    ;;
  stop)
    if have_docker; then
      exec docker compose -f "$ROOT/docker-compose.yml" down
    fi
    "$(pgbin)/pg_ctl" -D "$DATA_DIR" stop
    ;;
  status)
    if have_docker; then
      exec docker compose -f "$ROOT/docker-compose.yml" ps db
    fi
    "$(pgbin)/pg_ctl" -D "$DATA_DIR" status
    ;;
  *)
    echo "usage: scripts/scratch-db.sh start|stop|status" >&2
    exit 2
    ;;
esac
