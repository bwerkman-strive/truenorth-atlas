// Integrity-control tests: the "never replay from genesis again" suite.
//
// Exercises every defense added after the 2015-08-26 price-gap incident:
//   1. hot-loop input contracts (missing prevout / negative fee / missing
//      height metadata all REJECT the block instead of silently degrading)
//   2. the day-boundary reconciliation gate (counters must balance against
//      independent recomputation or the day refuses to finalize)
//   3. provisional tip-day repricing (fallback-priced cost bases are
//      re-stamped at the true close when the day finalizes)
//   4. price-table guards (immutable finalized closes, garbage rejection,
//      non-positive and implausible-jump detection)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PGSSLMODE = 'disable';

const { pool, migrate, getState, setState } = await import('../src/db.js');
const { processBlocks, heightMeta, tipHeight } = await import('../src/sync.js');
const { snapshotAndRollupDay } = await import('../src/metricsDaily.js');
const { bustPriceCache, priceForDay, assertNoPriceGaps, upsertPrices } =
  await import('../src/prices.js');

const SAT = 1e8;
const P1 = '2025-01-01', P2 = '2025-01-02', P3 = '2025-01-03';
const t = (day, hh) => Date.parse(`${day}T${String(hh).padStart(2, '0')}:00:00Z`) / 1000;
const noLog = { info: () => {}, error: () => {} };

const cb = (txid, height, valueBtc, addr) => ({
  txid,
  vin: [{ coinbase: '01' }],
  vout: [{ n: 0, value: valueBtc, scriptPubKey: { type: 'witness_v0_keyhash', address: addr } }],
});
const g1 = '11'.repeat(32), g2 = '22'.repeat(32), g3 = '33'.repeat(32), g4 = '44'.repeat(32);

before(async () => {
  await migrate();
  await (await import('./guard.js')).assertScratchDb();
  await pool.query(`TRUNCATE blocks, block_agg, utxos, prices, metrics_daily, chain_state, day_active_addresses`);
  await pool.query(`INSERT INTO prices (day, close_usd) VALUES ($1,100),($2,200)`, [P1, P2]);
  bustPriceCache();
  heightMeta.length = 0;

  await processBlocks([
    { height: 1, hash: 'g1', time: t(P1, 6), difficulty: 1, weight: 1000, tx: [cb(g1, 1, 50, 'pA')] },
    { height: 2, hash: 'g2', time: t(P1, 12), difficulty: 1, weight: 1000, tx: [cb(g2, 2, 50, 'pB')] },
  ]);
  await snapshotAndRollupDay(P1, noLog); // gate passes on honest books
});

after(async () => { await pool.end(); });

// ---------------------------------------------------------------------------
test('input contracts: corrupt block data rejects the block, commits nothing', async () => {
  const base = { height: 3, hash: 'g3-bad', time: t(P2, 3), difficulty: 1, weight: 1000 };

  await assert.rejects(processBlocks([{ ...base, tx: [
    cb(g3, 3, 50, 'pC'),
    { txid: 'ab'.repeat(32), vin: [{ txid: g1, vout: 0 }], // no prevout at all
      vout: [{ n: 0, value: 49, scriptPubKey: { type: 'witness_v0_keyhash', address: 'pX' } }] },
  ] }]), /missing prevout/);

  await assert.rejects(processBlocks([{ ...base, tx: [
    cb(g3, 3, 50, 'pC'),
    { txid: 'cd'.repeat(32), vin: [{ txid: g1, vout: 0, prevout: { value: 1, height: 1 } }],
      vout: [{ n: 0, value: 2, scriptPubKey: { type: 'witness_v0_keyhash', address: 'pX' } }] },
  ] }]), /exceed inputs/);

  await assert.rejects(processBlocks([{ ...base, tx: [
    cb(g3, 3, 50, 'pC'),
    { txid: 'ef'.repeat(32), vin: [{ txid: g1, vout: 0, prevout: { value: 50, height: 99 } }],
      vout: [{ n: 0, value: 49, scriptPubKey: { type: 'witness_v0_keyhash', address: 'pX' } }] },
  ] }]), /no height metadata/);

  assert.equal(await tipHeight(), 2, 'every rejected block rolled back whole');
});

test('reconciliation gate: cooked books refuse to finalize; honest books pass', async () => {
  await processBlocks([
    { height: 3, hash: 'g3', time: t(P2, 9), difficulty: 1, weight: 1000, tx: [cb(g3, 3, 50, 'pC')] },
  ]);

  const rc = await getState(pool, 'realized_cap_usd');
  await setState(pool, 'realized_cap_usd', rc + 5000);
  await assert.rejects(snapshotAndRollupDay(P2, noLog), /reconciliation failed.*realized_cap/s);
  await setState(pool, 'realized_cap_usd', rc);

  const supply = await getState(pool, 'circulating_supply_sat');
  await setState(pool, 'circulating_supply_sat', supply + 1);
  await assert.rejects(snapshotAndRollupDay(P2, noLog), /circulating_supply_sat/);
  await setState(pool, 'circulating_supply_sat', supply);

  await snapshotAndRollupDay(P2, noLog);
  const r = (await pool.query('SELECT realized_cap FROM metrics_daily WHERE day=$1', [P2])).rows[0];
  assert.ok(r, 'day finalizes once the books balance again');
  assert.ok(Math.abs(Number(r.realized_cap) - 20_000) < 1e-6);
});

test('provisional tip day: fallback stamps are repriced at the finalized close', async () => {
  // P3's candle does not exist yet: the block is priced off P2's close ($200)
  // and the day is durably flagged provisional.
  await processBlocks([
    { height: 4, hash: 'g4', time: t(P3, 2), difficulty: 1, weight: 1000, tx: [cb(g4, 4, 50, 'pD')] },
  ]);
  const stamped = (await pool.query(
    'SELECT created_price::float p FROM utxos WHERE txid=$1', [Buffer.from(g4, 'hex')])).rows[0].p;
  assert.equal(stamped, 200, 'processed with the previous close as provisional basis');
  const flag = await pool.query(`SELECT 1 FROM chain_state WHERE key=$1`, ['provisional:' + P3]);
  assert.equal(flag.rows.length, 1, 'day durably marked provisional');

  // The real candle lands, then the day finalizes: stamps, block_agg, and
  // counters must all converge on the true close — and the reconciliation
  // gate inside the same call proves the books balance afterward.
  await pool.query(`INSERT INTO prices (day, close_usd) VALUES ($1, 300)`, [P3]);
  await snapshotAndRollupDay(P3, noLog);

  const restamped = (await pool.query(
    'SELECT created_price::float p FROM utxos WHERE txid=$1', [Buffer.from(g4, 'hex')])).rows[0].p;
  assert.equal(restamped, 300);
  const agg = (await pool.query('SELECT * FROM block_agg WHERE height=4')).rows[0];
  assert.ok(Math.abs(Number(agg.realized_cap_delta) - 15_000) < 1e-6, 'creation delta re-valued');
  assert.ok(Math.abs(Number(agg.miner_rev_usd) - 15_000) < 1e-6, 'miner revenue re-valued');
  assert.ok(Math.abs(await getState(pool, 'realized_cap_usd') - 35_000) < 1e-6,
    'counter carries the correction');
  const r = (await pool.query('SELECT realized_cap FROM metrics_daily WHERE day=$1', [P3])).rows[0];
  assert.ok(Math.abs(Number(r.realized_cap) - 35_000) < 1e-6);
  const flagAfter = await pool.query(`SELECT 1 FROM chain_state WHERE key=$1`, ['provisional:' + P3]);
  assert.equal(flagAfter.rows.length, 0, 'provisional flag consumed');
});

test('price-table guards: immutability, garbage rejection, gap/jump/zero detection', async () => {
  await assertNoPriceGaps(); // P1..P3 contiguous, positive, no jumps

  // Finalized closes are immutable: a provider "revision" of P1 is refused.
  await upsertPrices([{ day: P1, close: 999 }], noLog);
  const p1 = (await pool.query('SELECT close_usd::float c FROM prices WHERE day=$1', [P1])).rows[0].c;
  assert.equal(p1, 100, 'historical close revision refused');

  // Garbage never lands.
  await upsertPrices([{ day: '2025-01-04', close: NaN }, { day: '2025-01-04', close: -5 }], noLog);
  const bad = await pool.query(`SELECT 1 FROM prices WHERE day='2025-01-04'`);
  assert.equal(bad.rows.length, 0);

  // A zero close after market start is provider garbage, not economics.
  await pool.query('UPDATE prices SET close_usd = 0 WHERE day=$1', [P2]);
  await assert.rejects(assertNoPriceGaps(), /non-positive/);
  await pool.query('UPDATE prices SET close_usd = 200 WHERE day=$1', [P2]);

  // No adjacent closes have ever legitimately moved 10x.
  await pool.query('UPDATE prices SET close_usd = 30000 WHERE day=$1', [P2]);
  await assert.rejects(assertNoPriceGaps(), /implausible/);
  await pool.query('UPDATE prices SET close_usd = 200 WHERE day=$1', [P2]);

  // Recent candles may still be revised while they finalize.
  const recent = new Date(Date.now() - 86400e3).toISOString().slice(0, 10);
  await upsertPrices([{ day: recent, close: 50000 }], noLog);
  await upsertPrices([{ day: recent, close: 51000 }], noLog);
  const rc = (await pool.query('SELECT close_usd::float c FROM prices WHERE day=$1', [recent])).rows[0].c;
  assert.equal(rc, 51000, 'revision inside the finalization window is allowed');
  await pool.query('DELETE FROM prices WHERE day=$1', [recent]);
});
