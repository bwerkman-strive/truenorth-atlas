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
const { bustPriceCache, priceForDay, assertNoPriceGaps } = await import('../src/prices.js');

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

const cb = (txid, height, valueBtc, addr) => ({
  txid,
  vin: [{ coinbase: '01' }],
  vout: [{ n: 0, value: valueBtc, scriptPubKey: { type: 'witness_v0_keyhash', address: addr } }],
});

function chain() {
  return [
    { height: 1, hash: 'h1', time: t(D1, 6), difficulty: 1, weight: 1000, tx: [cb(txidA, 1, 50, 'addrA')] },
    // h2 deliberately reports no weight: day-1's avg_feerate must stay NULL
    // rather than compute from a partial denominator.
    { height: 2, hash: 'h2', time: t(D1, 12), difficulty: 1, tx: [cb(txidB, 2, 50, 'addrB')] },
    {
      height: 3, hash: 'h3', time: t(D2, 9), difficulty: 2, weight: 4000, tx: [
        cb(txidC, 3, 50.001, 'addrC'), // 50 BTC subsidy + 0.001 BTC fees claimed
        {
          txid: txidS,
          vsize: 250, // fee 100,000 sat / 250 vB = 400 sat/vB
          vin: [{ txid: txidA, vout: 0, prevout: {
            value: 50, height: 1, generated: true, // spends a coinbase output
            scriptPubKey: { address: 'addrA' },
          } }],
          vout: [
            { n: 0, value: 30, scriptPubKey: { type: 'witness_v0_keyhash', address: 'addrD' } },
            { n: 1, value: 19.999, scriptPubKey: { type: 'witness_v0_keyhash', address: 'addrF' } },
            // 6-byte OP_RETURN payload script (6a 04 de ad be ef)
            { n: 2, value: 0, scriptPubKey: { type: 'nulldata', hex: '6a04deadbeef' } },
          ],
        },
      ],
    },
    { height: 4, hash: 'h4', time: t(D3, 3), difficulty: 2, tx: [cb(txidE, 4, 50, 'addrE')] },
  ];
}

before(async () => {
  await migrate();
  // Clean slate (idempotent re-runs).
  await (await import('./guard.js')).assertScratchDb();
  await pool.query(`TRUNCATE blocks, block_agg, utxos, prices, metrics_daily, chain_state, day_active_addresses`);
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

  // Hashprice: day-2 revenue (50.001 BTC × $200) per PH/s of the
  // difficulty-implied hashrate (difficulty 2 -> 2×2³²/600 H/s).
  const hrPh2 = 2 * 2 ** 32 / 600 / 1e15; // PH/s
  assert.ok(Math.abs(Number(r2.hashprice_usd_ph) / (50.001 * 200 / hrPh2) - 1) < 1e-12,
    `hashprice=${r2.hashprice_usd_ph}`);
  // Day 1: 100 BTC minted at $100 over a difficulty-1 day.
  const hrPh1 = 2 ** 32 / 600 / 1e15;
  assert.ok(Math.abs(Number(r1.hashprice_usd_ph) / (100 * 100 / hrPh1) - 1) < 1e-12,
    `hashprice=${r1.hashprice_usd_ph}`);
});

test('fee metrics: total fees in USD and day-level average fee rate', async () => {
  const r1 = (await pool.query('SELECT * FROM metrics_daily WHERE day=$1', [D1])).rows[0];
  const r2 = (await pool.query('SELECT * FROM metrics_daily WHERE day=$1', [D2])).rows[0];

  // Day 1: two fee-less coinbases. $0 in fees; avg_feerate is NULL because
  // h2 carries no weight (partial denominators must not produce a number).
  assert.equal(Number(r1.fees_usd), 0);
  assert.equal(r1.avg_feerate, null);

  // Day 2: 0.001 BTC of fees at the $200 close = $0.20. Fee rate:
  // 100,000 sats over h3's weight 4000 (vsize 1000) = 100 sat/vB.
  assert.ok(Math.abs(Number(r2.fees_usd) - 0.2) < 1e-9, `fees_usd=${r2.fees_usd}`);
  assert.ok(Math.abs(Number(r2.avg_feerate) - 100) < 1e-9, `avg_feerate=${r2.avg_feerate}`);

  // The schema backfill must reproduce the same values for rows finalized
  // before the columns existed (simulated by nulling them out).
  await pool.query('UPDATE metrics_daily SET fees_usd=NULL, avg_feerate=NULL WHERE day=$1', [D2]);
  await migrate();
  const rb = (await pool.query('SELECT * FROM metrics_daily WHERE day=$1', [D2])).rows[0];
  assert.ok(Math.abs(Number(rb.fees_usd) - 0.2) < 1e-9, 'backfill restores fees_usd');
  assert.ok(Math.abs(Number(rb.avg_feerate) - 100) < 1e-9, 'backfill restores avg_feerate');
});

test('capacity metrics: block fullness and annualized issuance rate', async () => {
  const r1 = (await pool.query('SELECT * FROM metrics_daily WHERE day=$1', [D1])).rows[0];
  const r2 = (await pool.query('SELECT * FROM metrics_daily WHERE day=$1', [D2])).rows[0];

  // Day 1: h2 has no weight, so fullness must stay NULL (no partial
  // denominators). Issuance: 100 BTC subsidy annualized over 100 BTC supply.
  assert.equal(r1.block_fullness_pct, null);
  assert.ok(Math.abs(Number(r1.issuance_rate) - 365) < 1e-9, `issuance=${r1.issuance_rate}`);

  // Day 2: one block of weight 4000 against the 4M limit = 0.001 fullness.
  // Issuance: 50 BTC subsidy (fees excluded) × 365 over 150 BTC supply.
  assert.ok(Math.abs(Number(r2.block_fullness_pct) - 0.001) < 1e-12, `fullness=${r2.block_fullness_pct}`);
  assert.ok(Math.abs(Number(r2.issuance_rate) - 50 * 365 / 150) < 1e-9, `issuance=${r2.issuance_rate}`);

  // Schema backfill reproduces the rollup's values for pre-column rows.
  await pool.query('UPDATE metrics_daily SET block_fullness_pct=NULL, issuance_rate=NULL WHERE day=$1', [D2]);
  await migrate();
  const rb = (await pool.query('SELECT * FROM metrics_daily WHERE day=$1', [D2])).rows[0];
  assert.ok(Math.abs(Number(rb.block_fullness_pct) - 0.001) < 1e-12, 'backfill restores fullness');
  assert.ok(Math.abs(Number(rb.issuance_rate) - 50 * 365 / 150) < 1e-9, 'backfill restores issuance');
});

test('bundle block deltas: OP_RETURN, miner outflow, spend-age bands, feerate histogram', async () => {
  const agg = (await pool.query('SELECT * FROM block_agg WHERE height=3')).rows[0];

  // txidS carries one 6-byte OP_RETURN, so its whole 100,000-sat fee attributes.
  assert.equal(Number(agg.op_return_fees_sat), 100_000);
  assert.equal(Number(agg.op_return_count), 1);
  assert.equal(Number(agg.op_return_bytes), 6);

  // txidS spends the height-1 coinbase (prevout.generated): 50 BTC of miner outflow.
  assert.equal(Number(agg.miner_outflow_sat), 50 * SAT);

  // The spent coins were 1.125 days old: all 50 BTC land in the 1d–1w band.
  assert.deepEqual(agg.spent_age_bands, { '1d–1w': 50 });

  // 100,000 sat / 250 vB = 400 sat/vB -> bucket 20 (the 300–500 bucket).
  assert.deepEqual(agg.feerate_hist, { 20: 1 });

  // Fee-less day-1 coinbase blocks carry empty deltas.
  const agg1 = (await pool.query('SELECT * FROM block_agg WHERE height=1')).rows[0];
  assert.equal(Number(agg1.op_return_fees_sat), 0);
  assert.equal(Number(agg1.miner_outflow_sat), 0);
  assert.equal(agg1.spent_age_bands, null);
  assert.equal(agg1.feerate_hist, null);
});

test('bundle day rollup: activity, unrealized P&L, miner supply, cohorts, medians', async () => {
  const r1 = (await pool.query('SELECT * FROM metrics_daily WHERE day=$1', [D1])).rows[0];
  const r2 = (await pool.query('SELECT * FROM metrics_daily WHERE day=$1', [D2])).rows[0];

  // Day 1: two coinbase receivers (addrA, addrB); nothing spent, no fees.
  assert.equal(Number(r1.active_addresses), 2);
  assert.equal(Number(r1.op_return_fees_usd), 0);
  assert.equal(r1.median_feerate, null, 'no non-coinbase txs -> no median');
  assert.equal(r1.spent_age_bands, null);
  assert.equal(Number(r1.revived_supply_1y), 0);
  assert.equal(Number(r1.miner_outflow_btc), 0);
  // Both coins created at the $100 close: zero unrealized P&L either way.
  assert.equal(Number(r1.unrealized_profit_usd), 0);
  assert.equal(Number(r1.unrealized_loss_usd), 0);
  assert.equal(Number(r1.miner_unmoved_supply), 100);
  assert.equal(Number(r1.wholecoiner_count), 2);
  assert.ok(Math.abs(Number(r1.balance_bands['10–100']) - 1) < 1e-9, 'all supply in the 10–100 band');
  // URPD at D1: 100 BTC in the p=99 bucket (top $100, width $1) -> 99.5 interpolated.
  assert.ok(Math.abs(Number(r1.median_cost_basis) - 99.5) < 1e-9, `median=${r1.median_cost_basis}`);

  // Day 2: addrC (coinbase), addrA (sender), addrD + addrF (receivers) = 4.
  assert.equal(Number(r2.active_addresses), 4);
  // 0.001 BTC of OP_RETURN-tx fees at the $200 close.
  assert.ok(Math.abs(Number(r2.op_return_fees_usd) - 0.2) < 1e-9);
  // One tx at 400 sat/vB -> median is its bucket midpoint, (300+500)/2.
  assert.equal(Number(r2.median_feerate), 400);
  assert.ok(Math.abs(Number(r2.spent_age_bands['1d–1w']) - 1) < 1e-9, 'all spent volume aged 1d–1w');
  assert.equal(Number(r2.revived_supply_1y), 0);
  assert.equal(Number(r2.miner_outflow_btc), 50);
  // Held 50 BTC with a $100 basis at $200 spot; today's coins sit at basis.
  assert.equal(Number(r2.unrealized_profit_usd), 5_000);
  assert.equal(Number(r2.unrealized_loss_usd), 0);
  // Live coinbase outputs: txidB (50) + txidC (50.001); txidA was spent.
  assert.ok(Math.abs(Number(r2.miner_unmoved_supply) - 100.001) < 1e-9);
  // addrB 50, addrC 50.001, addrD 30, addrF 19.999: all four are wholecoiners
  // and all sit in the 10–100 band.
  assert.equal(Number(r2.wholecoiner_count), 4);
  assert.ok(Math.abs(Number(r2.balance_bands['10–100']) - 1) < 1e-9);
  // URPD at D2 (top $200, width $2): 50 BTC at p=100, 100 BTC at p=198;
  // the 75-BTC midpoint interpolates to 198 + 2 x 25/100 = 198.5.
  assert.ok(Math.abs(Number(r2.median_cost_basis) - 198.5) < 1e-9, `median=${r2.median_cost_basis}`);

  // Staging rows are consumed by finalization.
  const staged = (await pool.query(
    'SELECT COUNT(*)::int c FROM day_active_addresses WHERE day <= $1', [D2])).rows[0].c;
  assert.equal(staged, 0, 'finalized days leave no staging rows behind');
});

// The 2015-08-26 incident: one missing day in prices made priceForDay fall
// back to the NEWEST close in the table, valuing 2015 blocks at a 2026 price.
// Three defenses now exist; all must hold.
test('price-gap defenses: bounded fallback, gap assertion, finalization refusal', async () => {
  await assertNoPriceGaps(); // D1..D3 is contiguous

  await pool.query('DELETE FROM prices WHERE day=$1', [D2]);
  bustPriceCache();

  // 1. A mid-history hole resolves to the PREVIOUS day's close, never a later one.
  assert.equal(await priceForDay(D2), 100);

  // 2. The worker's boot/refresh check refuses to run over a hole.
  await assert.rejects(assertNoPriceGaps(), /missing day/);

  // 3. Day finalization refuses outright rather than writing price-0 metrics.
  //    (D4 is unfinalized, so it reaches the price check.)
  await assert.rejects(
    snapshotAndRollupDay('2024-06-04', { info: () => {} }), /prices table has a gap/);

  await pool.query('INSERT INTO prices (day, close_usd) VALUES ($1, 200)', [D2]);
  bustPriceCache();
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
    // avg = the day's realized price: $25,000 realized cap over 150 BTC.
    assert.ok(Math.abs(r.avg - 25_000 / 150) < 1e-6, `avg=${r.avg}`);

    const byDay = await (await fetch(base + `/api/urpd?day=${D1}`)).json();
    assert.equal(byDay.day, D1);
    assert.equal(byDay.avg, 100, 'D1 realized price: all coins minted at the $100 close');

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

  // Day-3 staging so far: addrE alone (the h4 coinbase receiver).
  const stagedBefore = (await pool.query(
    "SELECT COUNT(*)::int c FROM day_active_addresses WHERE day=$1", [D3])).rows[0].c;
  assert.equal(stagedBefore, 1);

  // A competing block 5 arrives, gets processed... and is then orphaned.
  await processBlocks([{
    height: 5, hash: 'h5-orphan', time: t(D3, 6), difficulty: 2, tx: [
      cb(txidR, 5, 50, 'addrR'),
      { // spends the held day-1 coinbase at a loss vs its $200... no wait, $150 spot vs $100 basis
        txid: '99'.repeat(32),
        vin: [{ txid: txidB, vout: 0, prevout: {
          value: 50, height: 2, generated: true, scriptPubKey: { address: 'addrB' },
        } }],
        vout: [{ n: 0, value: 49.9995, scriptPubKey: { type: 'witness_v0_keyhash', address: 'addrG' } }],
      },
    ],
  }]);
  assert.equal((await pool.query(
    "SELECT COUNT(*)::int c FROM day_active_addresses WHERE day=$1", [D3])).rows[0].c, 4,
    'orphan block staged addrR, addrB, addrG alongside addrE');
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

  const stagedAfter = (await pool.query(
    "SELECT address FROM day_active_addresses WHERE day=$1 ORDER BY address", [D3])).rows;
  assert.deepEqual(stagedAfter.map(r => r.address), ['addrE'],
    'addresses first seen only in the orphaned block are gone; addrE (h4) survives');

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

    const statusRes = await fetch(`http://127.0.0.1:${port}/api/status`);
    // /api/status backs the header's live sync counter — short cache only.
    assert.match(statusRes.headers.get('cache-control'), /max-age=30\b/);
    const status = await statusRes.json();
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

    // Supply with projection: history from metrics_daily, the future from the
    // consensus schedule anchored at the synthetic tip (h4 @ D3 03:00, 200 BTC
    // minted), and halving markers estimated at 600 s/block from that tip.
    const sup = await j('/api/series/circulating-supply?project=1');
    assert.deepEqual(sup.rows.map(r => [r.day, Number(r.circulating_supply)]),
      [[D1, 100], [D2, 150]]);
    assert.equal(sup.projection[0].day, D3);
    assert.equal(Number(sup.projection[0].circulating_supply), 200);
    const projLast = sup.projection[sup.projection.length - 1];
    assert.ok(Number(projLast.circulating_supply) < 21_000_000);
    assert.equal(sup.halvings[0].height, 210_000);
    assert.equal(sup.halvings[0].estimated, true, 'synthetic tip is pre-halving: all markers estimated');
    assert.equal(sup.halvings[0].day,
      new Date((t(D3, 3) + (210_000 - 4) * 600) * 1000).toISOString().slice(0, 10));
    // The projection runs until issuance ends: the final marker is the
    // boundary where the subsidy reaches zero.
    assert.equal(sup.halvings[sup.halvings.length - 1].height, 6_930_000);
    // Without ?project=1 the payload stays lean.
    const plain = await j('/api/series/circulating-supply');
    assert.equal(plain.projection, undefined);
    assert.equal(plain.halvings, undefined);

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
