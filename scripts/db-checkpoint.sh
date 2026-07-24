#!/bin/sh
# Logical checkpoint of the Atlas database.
#
# Restore-and-resume beats replay-from-genesis: pg_restore the newest dump,
# start the worker, and it syncs forward from the dump's height (the sync is
# a resume by construction). A weekly checkpoint bounds any future disaster
# — poison, data loss, bad migration — to at most a week of re-sync.
#
#   scripts/db-checkpoint.sh              # dump to ~/atlas-backups
#   ATLAS_BACKUP_DIR=/mnt/x scripts/db-checkpoint.sh
#
# Restore (into an EMPTY database, then point the worker at it):
#   pg_restore --no-owner --clean --if-exists -d "$DATABASE_URL" <dumpfile>
set -e
REPO="$(cd "$(dirname "$0")/.." && pwd)"
if [ -f "$REPO/server/.env.local" ]; then . "$REPO/server/.env.local"; fi
: "${DATABASE_URL:?set DATABASE_URL or put it in server/.env.local}"

DIR="${ATLAS_BACKUP_DIR:-$HOME/atlas-backups}"
mkdir -p "$DIR"
OUT="$DIR/atlas-$(date -u +%Y%m%d-%H%M).dump"

pg_dump --format=custom --compress=6 --no-owner --file "$OUT" "$DATABASE_URL"
echo "checkpoint written: $OUT ($(du -h "$OUT" | cut -f1))"

# Keep the newest 5 checkpoints.
ls -t "$DIR"/atlas-*.dump 2>/dev/null | tail -n +6 | while read -r f; do rm -f "$f"; done
echo "retained: $(ls "$DIR"/atlas-*.dump 2>/dev/null | wc -l | tr -d ' ') checkpoint(s) in $DIR"
