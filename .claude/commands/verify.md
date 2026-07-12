Run the project's full definition-of-done verification:

1. Ensure the scratch DB is up: `scripts/scratch-db.sh start` (uses Docker if
   available, otherwise a local Homebrew postgresql@16 with the same :5433
   port and credentials).
2. `cd server && DATABASE_URL=postgres://atlas:atlas@localhost:5433/atlas_test PGSSLMODE=disable npm test`
3. `cd web && npm test && npm run build`
4. Report pass/fail counts for each stage. If anything fails, fix it before
   reporting done — do not summarize a red suite as complete.
