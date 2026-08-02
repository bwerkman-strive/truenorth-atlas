#!/usr/bin/env bash
# Replay speed-up actions, one explicit subcommand each. Run on the machine
# hosting the sync worker. Order (2026-08 runbook): merge the PR pausing
# utxos_address_live in schema.sql FIRST, then:
#   scripts/replay-tune.sh drop-address-index   # DROP INDEX CONCURRENTLY utxos_address_live
#   scripts/replay-tune.sh db-settings          # synchronous_commit=off, work_mem=256MB (database-level)
#   scripts/replay-tune.sh autovacuum-utxos     # unthrottle autovacuum on utxos so it can keep up with churn
#   scripts/replay-tune.sh vacuum-utxos         # one-time manual VACUUM of utxos (online; runs for hours, leave it)
#   scripts/replay-tune.sh worker-env           # append SYNC_BATCH_BLOCKS=50, node heap bump, phase logging
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
  autovacuum-utxos)
    need_db
    # Default autovacuum is cost-throttled to ~8MB/s: one pass over a 60GB
    # table takes hours, so dead tuples from spends + pruneSpent outrun it
    # (observed 150M dead vs 56M live on 2026-08-02). Unthrottle it and
    # trigger at 2% dead instead of 20%.
    psql "$DATABASE_URL" -c "ALTER TABLE utxos SET (autovacuum_vacuum_cost_delay = 0, autovacuum_vacuum_scale_factor = 0.02);"
    echo "Applied. Autovacuum picks this up on its next cycle."
    ;;
  vacuum-utxos)
    need_db
    echo "Running VACUUM (VERBOSE) on utxos: online, safe alongside the worker,"
    echo "but it will run for hours; leave this terminal open (or Ctrl-C safely,"
    echo "it resumes from scratch next run). Progress lines appear as it works."
    psql "$DATABASE_URL" -c "VACUUM (VERBOSE) utxos;"
    ;;
  worker-env)
    grep -qE '^(export )?SYNC_BATCH_BLOCKS=' "$ENVFILE" \
      || echo 'export SYNC_BATCH_BLOCKS=50' >> "$ENVFILE"
    grep -qE '^(export )?NODE_OPTIONS=' "$ENVFILE" \
      || echo 'export NODE_OPTIONS=--max-old-space-size=8192' >> "$ENVFILE"
    # Phase instrumentation: every stage logs its duration (the 2026-07-30
    # attempt at this line lacked `export`, so it never reached the worker).
    grep -qE '^export SYNC_SLOW_PHASE_MS=' "$ENVFILE" \
      || echo 'export SYNC_SLOW_PHASE_MS=1' >> "$ENVFILE"
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
