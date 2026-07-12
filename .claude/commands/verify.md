Run the project's full definition-of-done verification:

1. Ensure the scratch DB is up: `docker compose up -d db` (wait for healthy).
2. `cd server && DATABASE_URL=postgres://atlas:atlas@localhost:5433/atlas_test PGSSLMODE=disable npm test`
3. `cd web && npm test && npm run build`
4. Report pass/fail counts for each stage. If anything fails, fix it before
   reporting done — do not summarize a red suite as complete.
