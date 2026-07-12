Add a new on-chain metric named: $ARGUMENTS

Follow the catalog procedure exactly (see AGENTS.md invariant #4):

1. `server/src/schema.sql` — add the column to `metrics_daily` (idempotent:
   the CREATE TABLE plus, if needed, `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`).
2. `server/src/metricsDaily.js` — compute it in the day snapshot/rollup. If it
   needs a new running counter in `chain_state`, you MUST add the matching
   reversal in `sync.js rollbackAbove()` (invariant #3).
3. `server/src/catalog.js` — one entry: slug, column, name, category, format,
   zones, short, explain, method. The API, overview card, bearing dial,
   sparkline, detail chart, OG card, and alerts all follow automatically.
4. If the metric is USD-denominated price-level data, add
   `columns: ['<col>', 'price']` for a same-axis price overlay.
5. Extend `server/test/integration.pipeline.test.js` with a hand-computed
   expected value for the metric from the synthetic chain.
6. Run /verify. `unit.catalog.test.js` will catch schema/catalog mismatches.
