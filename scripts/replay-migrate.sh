#!/usr/bin/env bash
# Migrate the in-progress chain replay from the Render Postgres to a local
# Postgres 16, WITHOUT restarting from genesis, then point the worker at it.
# Only the chain-owned tables move (blocks, block_agg, utxos,
# day_active_addresses, chain_state, metrics_daily, prices): admin, alert,
# newsletter, email-log, API-key, and metric-copy tables stay on Render,
# which keeps serving the site (frozen at the cutover height) until the
# tip cutover restores the chain tables back.
#
# Subcommands, in run order:
#   scripts/replay-migrate.sh preflight    # read-only checks: tools, disk, worker, both DBs
#   scripts/replay-migrate.sh install-pg   # brew postgresql@16 + initdb + tuned config + start + createdb
#   scripts/replay-migrate.sh dump         # stop-worker-first pg_dump of chain tables from Render
#   scripts/replay-migrate.sh restore      # schema + data into local, rebuild pkey, verify heights
#   scripts/replay-migrate.sh switch-local # rewrite server/.env.local to local DB (Render URL preserved)
# then:  scripts/replay-tune.sh restart-worker
#
# Overridables (export before running):
#   ATLAS_PG_DIR  (default ~/atlas-pg)          data directory — put on an external SSD if / is tight
#   ATLAS_PG_PORT (default 5434)
#   ATLAS_DUMP    (default ~/atlas-chain.dump)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENVFILE="${ATLAS_ENV_FILE:-$ROOT/server/.env.local}"
PGDIR="${ATLAS_PG_DIR:-$HOME/atlas-pg}"
PGPORT_LOCAL="${ATLAS_PG_PORT:-5434}"
DUMP="${ATLAS_DUMP:-$HOME/atlas-chain.dump}"
LOCAL_URL="postgres://atlas@127.0.0.1:${PGPORT_LOCAL}/atlas"
CHAIN_TABLES=(blocks block_agg utxos day_active_addresses chain_state metrics_daily prices)

if [[ -f "$ENVFILE" ]]; then set -a; source "$ENVFILE"; set +a; fi

PGBIN="$(brew --prefix postgresql@16 2>/dev/null)/bin"

need_render() {
  if [[ -z "${DATABASE_URL:-}" ]]; then
    echo "DATABASE_URL not set (expected in $ENVFILE)"; exit 1
  fi
}

worker_running() { pgrep -f "node src/sync.js" >/dev/null 2>&1; }

case "${1:-}" in
  preflight)
    ok=1
    command -v brew >/dev/null || { echo "FAIL: Homebrew not found"; ok=0; }
    if [[ -x "$PGBIN/pg_dump" ]]; then echo "ok:   postgresql@16 installed ($PGBIN)"
    else echo "note: postgresql@16 not installed yet (install-pg will do it)"; fi
    avail_gb=$(df -g "$HOME" | awk 'NR==2 {print $4}')
    if [[ "${avail_gb:-0}" -ge 120 ]]; then echo "ok:   ${avail_gb} GB free on home volume"
    else echo "WARN: only ${avail_gb:-?} GB free on home volume (want 120+; use ATLAS_PG_DIR to point at an external disk)"; fi
    if worker_running; then echo "note: worker is RUNNING (fine for preflight; dump will require it stopped)"
    else echo "ok:   worker not running"; fi
    need_render
    h=$(psql "$DATABASE_URL" -Atc "SELECT COALESCE(MAX(height),-1) FROM blocks;") \
      && echo "ok:   Render reachable, chain height $h" \
      || { echo "FAIL: cannot reach Render DB"; ok=0; }
    if "$PGBIN/pg_isready" -q -p "$PGPORT_LOCAL" 2>/dev/null; then
      echo "ok:   local Postgres already running on :$PGPORT_LOCAL"
    else
      echo "note: local Postgres not running on :$PGPORT_LOCAL (install-pg starts it)"
    fi
    [[ $ok -eq 1 ]] && echo "preflight complete" || exit 1
    ;;

  install-pg)
    command -v brew >/dev/null || { echo "Homebrew required"; exit 1; }
    brew list postgresql@16 >/dev/null 2>&1 || brew install postgresql@16
    PGBIN="$(brew --prefix postgresql@16)/bin"
    if [[ ! -d "$PGDIR" ]]; then
      "$PGBIN/initdb" -D "$PGDIR" -U atlas --auth=trust
    fi
    if ! grep -q '# atlas-replay tuning' "$PGDIR/postgresql.conf"; then
      ram_gb=$(( $(sysctl -n hw.memsize) / 1073741824 ))
      sb=$(( ram_gb / 4 )); ecs=$(( ram_gb * 3 / 4 ))
      cat >> "$PGDIR/postgresql.conf" <<EOF

# atlas-replay tuning (RAM detected: ${ram_gb}GB)
listen_addresses = '127.0.0.1'
port = ${PGPORT_LOCAL}
shared_buffers = ${sb}GB
effective_cache_size = ${ecs}GB
work_mem = 256MB
maintenance_work_mem = 1GB
synchronous_commit = off
max_wal_size = 8GB
checkpoint_completion_target = 0.9
autovacuum_vacuum_cost_delay = 0
EOF
    fi
    "$PGBIN/pg_isready" -q -p "$PGPORT_LOCAL" 2>/dev/null \
      || "$PGBIN/pg_ctl" -D "$PGDIR" -l "$PGDIR/server.log" start
    sleep 2
    psql -p "$PGPORT_LOCAL" -U atlas -Atc "SELECT 1" -d postgres >/dev/null 2>&1 || true
    psql -p "$PGPORT_LOCAL" -U atlas -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname='atlas'" | grep -q 1 \
      || "$PGBIN/createdb" -p "$PGPORT_LOCAL" -U atlas atlas
    echo "local Postgres ready: $LOCAL_URL  (data dir $PGDIR)"
    ;;

  dump)
    need_render
    if worker_running; then
      echo "REFUSING: the worker is still running. Any blocks it writes after the"
      echo "dump starts would be lost at cutover. Stop it first:"
      echo "  pkill -f atlas-run.sh; pkill -f 'node src/sync.js'"
      exit 1
    fi
    h=$(psql "$DATABASE_URL" -Atc "SELECT MAX(height) FROM blocks;")
    echo "$h" > "$DUMP.height"
    echo "Render chain height at dump time: $h (recorded to $DUMP.height)"
    tflags=(); for t in "${CHAIN_TABLES[@]}"; do tflags+=(-t "$t"); done
    echo "Dumping chain tables to $DUMP (runs for a while; bandwidth-bound)..."
    "$PGBIN/pg_dump" "$DATABASE_URL" -Fc -Z1 --no-owner --no-privileges "${tflags[@]}" -f "$DUMP"
    ls -lh "$DUMP"
    echo "Dump complete."
    ;;

  restore)
    [[ -f "$DUMP" ]] || { echo "dump file not found: $DUMP (run dump first)"; exit 1; }
    "$PGBIN/pg_isready" -q -p "$PGPORT_LOCAL" || { echo "local Postgres not running (run install-pg)"; exit 1; }
    echo "Applying schema to local DB..."
    (cd "$ROOT/server" && DATABASE_URL="$LOCAL_URL" PGSSLMODE=disable npm run --silent migrate)
    echo "Emptying chain tables and dropping utxos indexes for fast load..."
    psql "$LOCAL_URL" -q \
      -c "TRUNCATE blocks, block_agg, utxos, day_active_addresses, chain_state, metrics_daily, prices CASCADE;" \
      -c "ALTER TABLE utxos DROP CONSTRAINT IF EXISTS utxos_pkey;" \
      -c "DROP INDEX IF EXISTS utxos_spent_height_idx;" \
      -c "DROP INDEX IF EXISTS utxos_address_live;"
    echo "Restoring data (the utxos table dominates; expect this to run a while)..."
    "$PGBIN/pg_restore" -d "$LOCAL_URL" --data-only --disable-triggers -j4 "$DUMP"
    echo "Rebuilding utxos primary key + spent-height index..."
    psql "$LOCAL_URL" -q \
      -c "ALTER TABLE utxos ADD PRIMARY KEY (txid, vout);" \
      -c "CREATE INDEX utxos_spent_height_idx ON utxos (spent_height) WHERE spent_height IS NOT NULL;" \
      -c "ANALYZE;"
    want=$(cat "$DUMP.height" 2>/dev/null || echo "?")
    got=$(psql "$LOCAL_URL" -Atc "SELECT MAX(height) FROM blocks;")
    echo "height at dump: $want   height restored: $got"
    if [[ "$want" == "$got" ]]; then echo "restore VERIFIED."
    else echo "MISMATCH — do not switch the worker; investigate first."; exit 1; fi
    ;;

  switch-local)
    [[ -f "$ENVFILE" ]] || { echo "env file not found: $ENVFILE"; exit 1; }
    need_render
    got=$(psql "$LOCAL_URL" -Atc "SELECT COALESCE(MAX(height),-1) FROM blocks;" 2>/dev/null || echo "-1")
    [[ "$got" != "-1" ]] || { echo "local DB not ready (run install-pg/restore first)"; exit 1; }
    if [[ ! -f "$ENVFILE.render-backup" ]]; then cp "$ENVFILE" "$ENVFILE.render-backup"; fi
    tmp="$(mktemp)"
    grep -vE '^(export )?(DATABASE_URL|PGSSLMODE)=' "$ENVFILE" > "$tmp"
    grep -qE '^(export )?RENDER_DATABASE_URL=' "$tmp" \
      || printf 'export RENDER_DATABASE_URL=%s\n' "$DATABASE_URL" >> "$tmp"
    printf 'export DATABASE_URL=%s\nexport PGSSLMODE=disable\n' "$LOCAL_URL" >> "$tmp"
    mv "$tmp" "$ENVFILE"
    echo "Switched. $ENVFILE now points at $LOCAL_URL (height $got);"
    echo "the Render URL is preserved as RENDER_DATABASE_URL and in $ENVFILE.render-backup."
    echo "Now run: scripts/replay-tune.sh restart-worker"
    ;;

  *)
    grep '^#   scripts/replay-migrate.sh' "$0" | sed 's/^#   //'
    exit 1
    ;;
esac
