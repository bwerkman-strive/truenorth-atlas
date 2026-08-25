// upsertPrices guard behavior around the tip (born of the 2026-08-23
// reconciliation incident): the in-progress day's candle must never be
// stored, and a close that the metrics engine has finalized is immutable
// even inside the provider settle window. Isolated in its own process so
// config reads a clean env at import.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PGSSLMODE = 'disable';

const { pool, migrate } = await import('../src/db.js');
const { upsertPrices } = await import('../src/prices.js');

const dayStr = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => dayStr(new Date(Date.now() - n * 86400e3));

async function storedClose(day) {
  const r = await pool.query('SELECT close_usd FROM prices WHERE day=$1', [day]);
  return r.rows.length ? Number(r.rows[0].close_usd) : undefined;
}

before(async () => {
  await migrate();
  await pool.query('TRUNCATE prices');
  await pool.query(`DELETE FROM chain_state WHERE key='last_metrics_day_epoch'`);
});
after(async () => { await pool.end(); });

test('the current UTC day is never stored (in-progress candle is mutable)', async () => {
  await upsertPrices([
    { day: daysAgo(0), close: 50000 },
    { day: daysAgo(1), close: 40000 },
  ]);
  assert.equal(await storedClose(daysAgo(0)), undefined);
  assert.equal(await storedClose(daysAgo(1)), 40000);
});

test('a stored but unfinalized recent close may still settle', async () => {
  await upsertPrices([{ day: daysAgo(1), close: 40100 }]);
  assert.equal(await storedClose(daysAgo(1)), 40100);
});

test('a metrics-finalized close is immutable even inside the settle window', async () => {
  const finalizedEpoch = Math.floor(Date.parse(daysAgo(1) + 'T00:00:00Z') / 86400e3);
  await pool.query(
    `INSERT INTO chain_state (key, value) VALUES ('last_metrics_day_epoch', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [finalizedEpoch]);
  await upsertPrices([{ day: daysAgo(1), close: 43210 }]);
  assert.equal(await storedClose(daysAgo(1)), 40100, 'finalized close must not move');
});

test('a close beyond the settle window is immutable regardless of finalization', async () => {
  // Clear finalization so the settle-window guard, not the finalized-day
  // guard, is what this exercises.
  await pool.query(`DELETE FROM chain_state WHERE key='last_metrics_day_epoch'`);
  await upsertPrices([{ day: daysAgo(30), close: 30000 }]);
  assert.equal(await storedClose(daysAgo(30)), 30000);
  await upsertPrices([{ day: daysAgo(30), close: 31000 }]);
  assert.equal(await storedClose(daysAgo(30)), 30000, 'out-of-window close must not move');
});
