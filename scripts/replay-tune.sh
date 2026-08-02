#!/usr/bin/env bash
# Replay speed-up actions, one explicit subcommand each. Run on the machine
# hosting the sync worker. Order (2026-08 runbook): merge the PR pausing
# utxos_address_live in schema.sql FIRST, then:
#   scripts/replay-tune.sh drop-address-index   # DROP INDEX CONCURRENTLY utxos_address_live
#   scripts/replay-tune.sh db-settings          # synchronous_commit=off, work_mem=256MB (database-level)
#   scripts/replay-tune.sh worker-env           # append SYNC_BATCH_BLOCKS=50 + node heap bump to server/.env.local
#   scripts/replay-tune.sh restart-worker       # restart the atlas-run.sh loop to pick everything up
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENVFILE="$ROOT/server/.env.local"
if [[ -f "$ENVFILE" ]]; then set -a; source "$ENVFILE"; set +a; fi

need_db() {
  if [[ -z "${DATABASE_URL:-}" ]]; then
    echo "DATABASE_URL not set (expected in $ENVFILE)"; exit 1
  fi
}

case "${1:-}" in
  drop-address-index)
    need_db
    echo "Dropping utxos_address_live CONCURRENTLY (can take a while; safe while the worker runs)..."
    psql "$DATABASE_URL" -c "DROP INDEX CONCURRENTLY IF EXISTS utxos_address_live;"
    echo "Done. If schema.sql still contains this index uncommented on main, the next deploy re-creates it."
    ;;
  db-settings)
    need_db
    DB=$(psql "$DATABASE_URL" -Atc "SELECT current_database();")
    psql "$DATABASE_URL" \
      -c "ALTER DATABASE \"$DB\" SET synchronous_commit = off;" \
      -c "ALTER DATABASE \"$DB\" SET work_mem = '256MB';"
    echo "Applied (new connections only): run restart-worker to pick these up."
    ;;
  worker-env)
    grep -qE '^(export )?SYNC_BATCH_BLOCKS=' "$ENVFILE" \
      || echo 'export SYNC_BATCH_BLOCKS=50' >> "$ENVFILE"
    grep -qE '^(export )?NODE_OPTIONS=' "$ENVFILE" \
      || echo 'export NODE_OPTIONS=--max-old-space-size=8192' >> "$ENVFILE"
    echo "--- last lines of $ENVFILE:"
    tail -4 "$ENVFILE"
    echo "Appended (idempotent): run restart-worker to apply."
    ;;
  restart-worker)
    pkill -f atlas-run.sh || true
    pkill -f "node src/sync.js" || true
    sleep 2
    nohup caffeinate -is "$HOME/atlas-run.sh" >> "$HOME/atlas-sync.log" 2>&1 &
    echo "Worker restarted (pid $!); follow with: tail -f ~/atlas-sync.log"
    ;;
  *)
    grep '^#   scripts/replay-tune.sh' "$0" | sed 's/^#   //'
    exit 1
    ;;
esac
