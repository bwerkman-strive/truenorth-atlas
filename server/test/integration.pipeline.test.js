// End-to-end pipeline test against a real Postgres instance.
//
// Builds a small synthetic chain in exactly the shape Bitcoin Core returns
// from `getblock <hash> 3` (prevout value+height inlined on every input),
// pushes it through the same code paths the sync worker uses, and verifies
// the resulting economics by hand:
//
//   day 1 ($100 close):  two 50 BTC coinbases mined
//   day 2 ($200 close):  one of them is spent — 50 BTC bought at $100 sold
//                        at $200 -> SOPR 2.0, realized profit $5,000,
//                        realized cap rotates to the new (higher) basis
//   day 3 ($150 close):  quiet day, then a reorg strikes the last block
//
// Set DATABASE_URL before running (the npm script handles the local case).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PGSSLMODE = 'disable';
process.env.STH_THRESHOLD_DAYS = '155';
process.env.ASOPR_MIN_AGE_SECONDS = '3600';

const { pool, migrate, getState } = await import('../src/db.js');
const { processBlocks, rollbackAbove, pruneSpent, heightMeta, dayOf, tipHeight } =
  await import('../src/sync.js');
const { snapshotAndRollupDay } = await import('../src/metricsDaily.js');
const { bustPriceCache } = await import('../src/prices.js');

const SAT = 1e8;
// Three consecutive UTC days, mid-2024-style timestamps.
const D1 = '2024-06-01', D2 = '2024-06-02', D3 = '2024-06-03';
const t = (day, hh) => Date.parse(`${day}T${String(hh).padStart(2, '0')}:00:00Z`) / 1000;

const txidA = 'aa'.repeat(32); // coinbase @ h1 (will be spent on day 2)
const txidB = 'bb'.repeat(32); // coinbase @ h2 (held)
const txidC = 'cc'.repeat(32); // day-2 coinbase
const txidS = 'dd'.repeat(32); // the day-2 spend tx
const txidE = 'ee'.repeat(32); // day-3 coinbase
const txidR = 'ff'.repeat(32); // reorg-victim coinbase

const cb = (txid, height, valueBtc) => ({
  txid,
  vin: [{ coinbase: '01' }],
  vout: [{ n: 0, value: valueBtc, scriptPubKey: { type: 'witness_v0_keyhash' } }],
});

function chain() {
  return [
    { height: 1, hash: 'h1', time: t(D1, 6), difficulty: 1, tx: [cb(txidA, 1, 50)] },
    { height: 2, hash: 'h2', time: t(D1, 12), difficulty: 1, tx: [cb(txidB, 2, 50)] },
    {
      height: 3, hash: 'h3', time: t(D2, 9), difficulty: 2, tx: [
        cb(txidC, 3, 50.001), // 50 BTC subsidy + 0.001 BTC fees claimed
        {
          txid: txidS,
          vin: [{ txid: txidA, vout: 0, prevout: { value: 50, height: 1 } }],
          vout: [
            { n: 0, value: 30, scriptPubKey: { type: 'witness_v0_keyhash' } },
            { n: 1, value: 19.999, scriptPubKey: { type: 'witness_v0_keyhash' } },
          ],
        },
      ],
    },
    { height: 4, hash: 'h4', time: t(D3, 3), difficulty: 2, tx: [cb(txidE, 4, 50)] },
  ];
}

before(async () => {
  await migrate();
  // Clean slate (idempotent re-runs).
  await pool.query(`TRUNCATE blocks, block_agg, utxos, prices, metrics_daily, chain_state`);
  await pool.query(
    `INSERT INTO prices (day, close_usd) VALUES ($1,100),($2,200),($3,150)`, [D1, D2, D3]);
  bustPriceCache();
  heightMeta.length = 0;
});

after(async () => { await pool.end(); });

// ---------------------------------------------------------------------------
test('day-1 blocks: UTXO creation, issuance, realized cap at cost basis', async () => {
  const blocks = chain().filter(b => dayOf(b.time) === D1);
  await processBlocks(blocks);

  assert.equal(await tipHeight(), 2);
  const supply = await getState(pool, 'circulating_supply_sat');
  assert.equal(supply, 100 * SAT, 'two 50 BTC subsidies minted');

  const rc = await getState(pool, 'realized_cap_usd');
  assert.equal(rc, 100 * 100, 'realized cap = 100 BTC × $100 close');

  const utxos = await pool.query('SELECT COUNT(*)::int c FROM utxos WHERE spent_height IS NULL');
  assert.equal(utxos.rows[0].c, 2);
  const basis = await pool.query('SELECT DISTINCT created_price::float p FROM utxos');
  assert.deepEqual(basis.rows.map(r => r.p), [100]);
});

test('day-1 snapshot: HODL waves, cohorts, supply in profit', async () => {
  await snapshotAndRollupDay(D1, { info: () => {} });
  const r = (await pool.query('SELECT * FROM metrics_daily WHERE day=$1', [D1])).rows[0];
  assert.ok(r, 'day-1 row exists');

  assert.equal(Number(r.price), 100);
  assert.equal(Number(r.circulating_supply), 100);
  assert.equal(Number(r.realized_cap), 10_000);
  assert.equal(Number(r.market_cap), 10_000);       // 100 BTC × $100
  assert.equal(Number(r.mvrv), 1, 'basis equals spot on creation day');

  // Coins created today at today's close are not "in profit" (created_price < price is strict).
  assert.equal(Number(r.supply_profit_pct), 0);

  const waves = r.hodl_waves;
  const sum = Object.values(waves).reduce((a, b) => a + Number(b), 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, 'HODL waves sum to 100% of supply');
  assert.ok(Number(waves['24h']) > 0.999, 'all supply is under 24h old');

  // Whole float is short-term holder supply.
  assert.equal(Number(r.sth_supply), 100);
  assert.equal(Number(r.lth_supply), 0);
});

test('day-2 spend: SOPR, realized P&L, CDD, realized-cap rotation', async () => {
  const blocks = chain().filter(b => dayOf(b.time) === D2);
  await processBlocks(blocks);

  const agg = (await pool.query('SELECT * FROM block_agg WHERE height=3')).rows[0];

  // 50 BTC acquired @ $100, spent @ $200.
  assert.equal(Number(agg.sopr_num), 50 * 200);
  assert.equal(Number(agg.sopr_den), 50 * 100);
  assert.equal(Number(agg.realized_profit), 5_000);
  assert.equal(Number(agg.realized_loss), 0);
  assert.equal(Number(agg.transfer_vol_sat), 50 * SAT);

  // Age: created D1 06:00, spent D2 09:00 = 27h = 1.125 days -> CDD = 56.25.
  assert.ok(Math.abs(Number(agg.cdd) - 50 * 1.125) < 1e-6, `cdd=${agg.cdd}`);
  // VDD = CDD × spot ($200).
  assert.ok(Math.abs(Number(agg.vdd_usd) - 56.25 * 200) < 1e-3);

  // Aged 27h ≥ 1h so the spend also counts in adjusted SOPR; and it is STH (<155d).
  assert.equal(Number(agg.asopr_num), 50 * 200);
  assert.equal(Number(agg.sth_sopr_num), 50 * 200);
  assert.equal(Number(agg.lth_sopr_num), 0);

  // Realized cap delta: -50×$100 (destroyed basis) +50.001×$200 (new coinbase)
  // +49.999×$200 (spend outputs re-created at $200) = +15,000.
  assert.ok(Math.abs(Number(agg.realized_cap_delta) - 15_000) < 1e-6);

  const rc = await getState(pool, 'realized_cap_usd');
  assert.ok(Math.abs(rc - 25_000) < 1e-6, 'RC: 50@100 held + 100@200 rotated/minted');

  const supply = await getState(pool, 'circulating_supply_sat');
  assert.equal(supply, 150 * SAT, 'fees are recycled, only subsidy adds supply');

  const spent = await pool.query('SELECT spent_height FROM utxos WHERE txid=$1', [Buffer.from(txidA, 'hex')]);
  assert.equal(spent.rows[0].spent_height, 3, 'input marked spent, retained for reorg safety');
});

test('day-2 finalization: MVRV, NUPL, SOPR, waves reflect the rotation', async () => {
  await snapshotAndRollupDay(D2, { info: () => {} });
  const r = (await pool.query('SELECT * FROM metrics_daily WHERE day=$1', [D2])).rows[0];

  assert.equal(Number(r.price), 200);
  assert.equal(Number(r.market_cap), 150 * 200);       // 30,000
  assert.ok(Math.abs(Number(r.realized_cap) - 25_000) < 1e-6);
  assert.ok(Math.abs(Number(r.mvrv) - 30_000 / 25_000) < 1e-9);
  assert.ok(Math.abs(Number(r.nupl) - (30_000 - 25_000) / 30_000) < 1e-9);

  assert.equal(Number(r.sopr), 2, 'the only spend realized a clean 2× SOPR');
  assert.equal(Number(r.realized_profit), 5_000);

  // In profit at $200: the held 50 BTC from day 1 (basis $100). The 100 BTC
  // created today at $200 sits exactly at basis (strict <), so 50/150.
  assert.ok(Math.abs(Number(r.supply_profit_pct) - 50 / 150) < 1e-9);

  // Everything is still under 155 days old.
  assert.equal(Number(r.sth_supply), 150);
  assert.equal(Number(r.lth_supply), 0);

  // STH cost basis: (50×100 + 100×200)/150 = $166.67
  assert.ok(Math.abs(Number(r.sth_cost_basis) - 25_000 / 150) < 1e-6);

  const waves = r.hodl_waves;
  const sum = Object.values(waves).reduce((a, b) => a + Number(b), 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
  // 100 BTC created day 2 (<24h at day-2 end) vs 50 BTC from day 1 (1d–1w).
  assert.ok(Math.abs(Number(waves['24h']) - 100 / 150) < 1e-9);
  assert.ok(Math.abs(Number(waves['1d–1w']) - 50 / 150) < 1e-9);
});

test('tier-1 metrics: cointime, cohort NUPL, sell-side risk, dormancy, price models', async () => {
  const r1 = (await pool.query('SELECT * FROM metrics_daily WHERE day=$1', [D1])).rows[0];
  const r2 = (await pool.query('SELECT * FROM metrics_daily WHERE day=$1', [D2])).rows[0];

  // Cointime at D2: liveliness = 56.25 / 250 = 0.225.
  //   investor cap = realized cap − thermocap = 25,000 − (10,000 + 50.001×200) = 4,999.8
  //   active cap   = 30,000 × 0.225 = 6,750
  assert.ok(Math.abs(Number(r2.aviv) - 6750 / 4999.8) < 1e-9, `aviv=${r2.aviv}`);
  assert.ok(Math.abs(Number(r2.true_market_mean) - 4999.8 / (0.225 * 150)) < 1e-6,
    'TMM = investor cap / active supply (= price / AVIV)');
  // At D1 realized cap equals thermocap exactly (all coins are fresh coinbases),
  // so investor cap is 0 and cointime metrics are undefined.
  assert.equal(r1.aviv, null);
  assert.equal(r1.true_market_mean, null);

  // Cohort NUPL: STH basis $166.67 vs $200 spot; no LTH supply exists yet.
  assert.ok(Math.abs(Number(r2.sth_nupl) - (200 - 25_000 / 150) / 200) < 1e-9);
  assert.equal(r2.lth_nupl, null);

  // Sell-side risk: $5,000 realized profit, $0 loss, on a $25,000 realized cap.
  assert.ok(Math.abs(Number(r2.sell_side_risk) - 0.2) < 1e-12);

  // Dormancy: 56.25 coin-days destroyed over 50 BTC moved = 1.125 days.
  assert.ok(Math.abs(Number(r2.dormancy) - 1.125) < 1e-9);

  // Terminal price: transferred price (11,250 / 250 = 45) × 21.
  assert.ok(Math.abs(Number(r2.terminal_price) - 945) < 1e-9);

  // Delta price: realized cap − mean market cap ((10k + 30k)/2), per coin.
  assert.ok(Math.abs(Number(r2.delta_price) - (25_000 - 20_000) / 150) < 1e-9);

  // RHODL undefined until a 1y–2y band exists; nothing is a year old yet.
  assert.equal(r2.rhodl, null);
  assert.equal(Number(r2.supply_1y_plus_pct), 0);

  // Hash ribbons: 30d/60d windows both cover exactly days 1–2 here.
  const expectHr = (Number(r1.hashrate_ehs) + Number(r2.hashrate_ehs)) / 2;
  assert.ok(Math.abs(Number(r2.hashrate_30d) - expectHr) < 1e-24);
  assert.ok(Math.abs(Number(r2.hashrate_60d) - expectHr) < 1e-24);
});

test('cohort supply in profit: STH breadth from the snapshot, LTH undefined pre-cohort', async () => {
  const r1 = (await pool.query('SELECT * FROM metrics_daily WHERE day=$1', [D1])).rows[0];
  const r2 = (await pool.query('SELECT * FROM metrics_daily WHERE day=$1', [D2])).rows[0];

  // D1: everything was created at the day's own close; strict < means 0% in profit.
  assert.equal(Number(r1.sth_profit_pct), 0);
  assert.equal(r1.lth_profit_pct, null, 'no LTH supply exists yet');

  // D2 at $200: the whole float (150 BTC) is STH; only the held 50 BTC from
  // day 1 (basis $100) is in profit -> 1/3 of the cohort.
  assert.ok(Math.abs(Number(r2.sth_profit_pct) - 50 / 150) < 1e-9);
  assert.equal(r2.lth_profit_pct, null);
});

test('URPD: supply bucketed by acquisition price, exact from the snapshot', async () => {
  // D2: top close so far is $200 -> 100 bins of $2. The held 50 BTC (basis
  // $100) lands at bin 50 (p=100); the 100 BTC created at $200 clamps into
  // the top bin (p=198).
  const r2 = (await pool.query('SELECT urpd FROM metrics_daily WHERE day=$1', [D2])).rows[0].urpd;
  assert.equal(r2.top, 200);
  assert.equal(r2.width, 2);
  assert.deepEqual(r2.buckets, [{ p: 100, v: 50 }, { p: 198, v: 100 }]);

  // D1: everything was acquired at the all-time-high close -> the top bin.
  const r1 = (await pool.query('SELECT urpd FROM metrics_daily WHERE day=$1', [D1])).rows[0].urpd;
  assert.equal(r1.width, 1);
  assert.deepEqual(r1.buckets, [{ p: 99, v: 100 }], 'ATH-priced coins clamp into the top bin');
});

test('/api/urpd serves the latest distribution; series/cycles reject the slug', async () => {
  const { app } = await import('../src/api.js');
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const r = await (await fetch(base + '/api/urpd')).json();
    assert.equal(r.slug, 'cost-basis-distribution');
    assert.equal(r.day, D2, 'latest finalized day wins');
    assert.equal(r.price, 200);
    assert.deepEqual(r.buckets, [{ p: 100, v: 50 }, { p: 198, v: 100 }]);

    const byDay = await (await fetch(base + `/api/urpd?day=${D1}`)).json();
    assert.equal(byDay.day, D1);

    assert.equal((await fetch(base + '/api/urpd?day=2030-01-01')).status, 404);
    assert.equal((await fetch(base + '/api/series/cost-basis-distribution')).status, 400,
      'the distribution is not a time series');
    assert.equal((await fetch(base + '/api/cycles/cost-basis-distribution')).status, 400);

    // /api/latest keeps the blob out of the dashboard payload.
    const latest = await (await fetch(base + '/api/latest')).json();
    assert.equal(latest.values['cost-basis-distribution'].value, null);
  } finally { srv.close(); }
});

test('finalization is idempotent (re-running a day is a no-op)', async () => {
  const beforeRow = (await pool.query('SELECT * FROM metrics_daily WHERE day=$1', [D2])).rows[0];
  await snapshotAndRollupDay(D2, { info: () => {} });
  const cnt = (await pool.query('SELECT COUNT(*)::int c FROM metrics_daily')).rows[0].c;
  assert.equal(cnt, 2, 'no duplicate day rows');
  const afterRow = (await pool.query('SELECT * FROM metrics_daily WHERE day=$1', [D2])).rows[0];
  assert.deepEqual(afterRow, beforeRow);
});

// ---------------------------------------------------------------------------
// Every key in chain_state, not just the ones this test knows about — so a new
// running counter added to processBlocks without a matching reversal in
// rollbackAbove() fails here instead of silently corrupting state at the next
// real reorg.
const allState = async () => {
  const r = await pool.query('SELECT key, value::float8 v FROM chain_state ORDER BY key');
  return Object.fromEntries(r.rows.map(({ key, v }) => [key, v]));
};

test('reorg: rollbackAbove restores every counter and the UTXO set exactly', async () => {
  // Advance into day 3 first.
  await processBlocks(chain().filter(b => dayOf(b.time) === D3));
  const rcBefore = await getState(pool, 'realized_cap_usd');
  const cddBefore = await getState(pool, 'cum_cdd');
  const supplyBefore = await getState(pool, 'circulating_supply_sat');
  const stateBefore = await allState();
  const unspentBefore = (await pool.query(
    'SELECT COUNT(*)::int c FROM utxos WHERE spent_height IS NULL')).rows[0].c;

  // A competing block 5 arrives, gets processed... and is then orphaned.
  await processBlocks([{
    height: 5, hash: 'h5-orphan', time: t(D3, 6), difficulty: 2, tx: [
      cb(txidR, 5, 50),
      { // spends the held day-1 coinbase at a loss vs its $200... no wait, $150 spot vs $100 basis
        txid: '99'.repeat(32),
        vin: [{ txid: txidB, vout: 0, prevout: { value: 50, height: 2 } }],
        vout: [{ n: 0, value: 49.9995, scriptPubKey: { type: 'witness_v0_keyhash' } }],
      },
    ],
  }]);
  assert.equal(await tipHeight(), 5);
  assert.notEqual(await getState(pool, 'realized_cap_usd'), rcBefore);
  const spentByOrphan = await pool.query(
    "SELECT encode(spent_txid,'hex') st FROM utxos WHERE txid=$1", [Buffer.from(txidB, 'hex')]);
  assert.equal(spentByOrphan.rows[0].st, '99'.repeat(32), 'spend attribution recorded');

  await rollbackAbove(4);

  assert.equal(await tipHeight(), 4);
  assert.ok(Math.abs(await getState(pool, 'realized_cap_usd') - rcBefore) < 1e-6, 'realized cap restored');
  assert.ok(Math.abs(await getState(pool, 'cum_cdd') - cddBefore) < 1e-9, 'cum CDD restored');
  assert.equal(await getState(pool, 'circulating_supply_sat'), supplyBefore, 'supply restored');

  const stateAfter = await allState();
  assert.deepEqual(Object.keys(stateAfter), Object.keys(stateBefore), 'no chain_state keys appeared/vanished');
  for (const [key, before] of Object.entries(stateBefore)) {
    const tol = Math.max(1e-6, Math.abs(before) * 1e-12);
    assert.ok(Math.abs(stateAfter[key] - before) < tol,
      `chain_state '${key}' not restored: ${before} -> ${stateAfter[key]} (missing reversal in rollbackAbove?)`);
  }

  const unspent = (await pool.query(
    'SELECT COUNT(*)::int c FROM utxos WHERE spent_height IS NULL')).rows[0].c;
  assert.equal(unspent, unspentBefore, 'orphaned creations gone, orphaned spends un-marked');

  const b = await pool.query('SELECT spent_height, spent_txid FROM utxos WHERE txid=$1', [Buffer.from(txidB, 'hex')]);
  assert.equal(b.rows[0].spent_height, null, 'txidB is live again');
  assert.equal(b.rows[0].spent_txid, null, 'spend attribution rolled back with it');

  const orphan = await pool.query('SELECT 1 FROM utxos WHERE txid=$1', [Buffer.from(txidR, 'hex')]);
  assert.equal(orphan.rows.length, 0, 'orphan coinbase removed');
  const agg5 = await pool.query('SELECT 1 FROM block_agg WHERE height=5');
  assert.equal(agg5.rows.length, 0, 'block_agg cascaded');
});

test('pruneSpent removes deeply-buried spent rows, keeps recent ones', async () => {
  // txidA was spent at height 3. With PRUNE_DEPTH=144 a tip of 4 keeps it...
  await pruneSpent(4);
  let a = await pool.query('SELECT 1 FROM utxos WHERE txid=$1', [Buffer.from(txidA, 'hex')]);
  assert.equal(a.rows.length, 1, 'recent spend retained for reorg safety');
  // ...and a (simulated) tip far in the future prunes it.
  await pruneSpent(3 + 144 + 1);
  a = await pool.query('SELECT 1 FROM utxos WHERE txid=$1', [Buffer.from(txidA, 'hex')]);
  assert.equal(a.rows.length, 0, 'deeply-buried spend pruned');
});

// ---------------------------------------------------------------------------
test('API serves catalog, latest, and series from the synced data', async () => {
  const { app } = await import('../src/api.js');
  const srv = app.listen(0);
  const port = srv.address().port;
  const j = (p) => fetch(`http://127.0.0.1:${port}${p}`).then(r => {
    assert.ok(r.ok, `${p} -> ${r.status}`);
    return r.json();
  });
  try {
    const health = await j('/api/health');
    assert.equal(health.ok, true);

    const status = await j('/api/status');
    assert.equal(Number(status.syncedHeight), 4);
    assert.equal(status.latestMetricsDay, D2);
    assert.equal(status.metricsDays, 2);

    const catalog = await j('/api/catalog');
    assert.ok(catalog.metrics.length >= 30);
    assert.ok(catalog.categories.length >= 5);

    const latest = await j('/api/latest');
    assert.equal(latest.day, D2);
    assert.equal(Number(latest.values.mvrv.value), 1.2);
    assert.equal(Number(latest.values.sopr.value), 2);
    // Percentile of the max over a 2-day history is 1.
    assert.equal(Number(latest.values.price.percentile), 1);

    const series = await j('/api/series/mvrv?price=1');
    assert.equal(series.rows.length, 2);
    assert.deepEqual(series.rows.map(r => r.day), [D1, D2]);
    assert.equal(Number(series.rows[1].price), 200);

    // Unknown slug is a clean 404, not a 500.
    const notFound = await fetch(`http://127.0.0.1:${port}/api/series/not-a-metric`);
    assert.equal(notFound.status, 404);

    // Malformed date params are ignored (fall back to defaults), never executed.
    const badDate = await fetch(`http://127.0.0.1:${port}/api/series/mvrv?from=DROP%20TABLE`);
    assert.equal(badDate.status, 200);
    assert.equal((await badDate.json()).rows.length, 2);

    // Downsampling long series: first and last points must always survive.
    await pool.query(`
      INSERT INTO metrics_daily (day, price, mvrv)
      SELECT ('2023-01-01'::date + i), 40000 + i, 1 + i * 0.01 FROM generate_series(0, 99) i`);
    const ds = await j('/api/series/mvrv?from=2023-01-01&to=2023-12-31&downsample=20');
    assert.ok(ds.rows.length <= 21 && ds.rows.length >= 20, `decimated to ~20, got ${ds.rows.length}`);
    assert.equal(ds.rows[0].day, '2023-01-01');
    assert.equal(ds.rows[ds.rows.length - 1].day, '2023-04-10');
    await pool.query(`DELETE FROM metrics_daily WHERE day < '2024-01-01'`);
  } finally {
    srv.close();
  }
});
