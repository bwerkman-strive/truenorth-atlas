#!/usr/bin/env bash
# Replay diagnostics: worker phase-time split + DB-side evidence, read-only.
# Run on the machine hosting the sync worker.
# Usage: scripts/replay-diag.sh [path-to-atlas-sync.log]   (default ~/atlas-sync.log)
set -euo pipefail

LOG="${1:-$HOME/atlas-sync.log}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [[ -f "$ROOT/server/.env.local" ]]; then
  set -a; source "$ROOT/server/.env.local"; set +a
fi

echo "== Phase split (last ~50MB of $LOG) =="
if [[ -f "$LOG" ]]; then
  tail -c 50000000 "$LOG" | grep '"msg":"phase done"' \
    | sed -E 's/.*"phase":"([^"]+)".*"ms":([0-9]+).*/\1 \2/' \
    | awk '{n[$1]++; s[$1]+=$2}
           END {for (p in n) printf "%-14s %6d calls %9.0f ms avg %11.0f ms total\n", p, n[p], s[p]/n[p], s[p]}'
else
  echo "log not found: $LOG (pass its path as the first argument)"
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo
  echo "DATABASE_URL not set (no server/.env.local?) — skipping DB checks"
  exit 0
fi

echo
echo "== utxos indexes (size / scans) =="
psql "$DATABASE_URL" -c "SELECT indexrelname, pg_size_pretty(pg_relation_size(indexrelid)) AS size, idx_scan FROM pg_stat_user_indexes WHERE relname='utxos' ORDER BY pg_relation_size(indexrelid) DESC;"

echo "== utxos table health =="
psql "$DATABASE_URL" \
  -c "SELECT n_live_tup, n_dead_tup, last_autovacuum, last_autoanalyze FROM pg_stat_user_tables WHERE relname='utxos';" \
  -c "SELECT pg_size_pretty(pg_total_relation_size('utxos')) AS utxos_total;"

echo "== settings =="
psql "$DATABASE_URL" -c "SHOW synchronous_commit;" -c "SHOW work_mem;" -c "SHOW shared_buffers;"
