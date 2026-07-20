// processBlocks batches every write to once per RUN rather than once per
// block (the per-block form cost ~22 round trips per block, which made a
// remote-database replay latency-bound to the tune of weeks). Batching is only
// safe because three orderings survive it; each is pinned here, because a
// regression in any of them is silent — the sync completes and the numbers are
// quietly wrong.
//
//   1. Creations are applied before spends, so a UTXO created AND spent inside
//      the same run still resolves. Per-block this was implicit; batched it
//      depends on statement order.
//   2. Creation array order is block order, so ON CONFLICT DO NOTHING keeps the
//      first occurrence (the BIP30 duplicate-coinbase behavior).
//   3. The five chain_state counters accumulate in memory across the run and
//      land before COMMIT, because the day snapshot that follows reads them as
//      exact end-of-day state.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PGSSLMODE = 'disable';

const { pool, migrate, getState } = await import('../src/db.js');
const { processBlocks, heightMeta } = await import('../src/sync.js');
const { bustPriceCache } = await import('../src/prices.js');

const SAT = 1e8;
const DAY = '2024-07-01';
const t = (hh) => Date.parse(`${DAY}T${String(hh).padStart(2, '0')}:00:00Z`) / 1000;

const cb = (txid, valueBtc) => ({
  txid,
  vin: [{ coinbase: '01' }],
  vout: [{ n: 0, value: valueBtc, scriptPubKey: { type: 'witness_v0_keyhash' } }],
});
const block = (height, hash, hour, txs) => ({
  height, hash, time: t(hour), difficulty: 1, tx: txs,
});

before(async () => {
  await migrate();
  await pool.query('TRUNCATE blocks, block_agg, utxos, prices, metrics_daily, chain_state');
  await pool.query(`INSERT INTO prices (day, close_usd) VALUES ($1, 100)
                    ON CONFLICT (day) DO UPDATE SET close_usd = 100`, [DAY]);
  bustPriceCache();
  heightMeta.length = 0;
});

after(async () => { await pool.end(); });

test('a UTXO created and spent inside the same run resolves', async () => {
  const created = '1a'.repeat(32);
  const spender = '1b'.repeat(32);
  // Block 1 mints it; block 2 spends it. Both are in ONE processBlocks call,
  // so the spend can only match if creations are inserted first.
  await processBlocks([
    block(1, 'h1', 0, [cb(created, 50)]),
    block(2, 'h2', 1, [
      cb('1c'.repeat(32), 50),
      {
        txid: spender,
        vin: [{ txid: created, vout: 0, prevout: { value: 50, height: 1 } }],
        vout: [{ n: 0, value: 49.9, scriptPubKey: { type: 'witness_v0_keyhash' } }],
      },
    ]),
  ]);

  const r = await pool.query(
    `SELECT spent_height, encode(spent_txid,'hex') AS sp FROM utxos
     WHERE txid = decode($1,'hex') AND vout = 0`, [created]);
  assert.equal(r.rows.length, 1, 'the created UTXO exists');
  assert.equal(r.rows[0].spent_height, 2, 'marked spent at the height that spent it');
  assert.equal(r.rows[0].sp, spender, 'attributed to the spending tx');
});

test('per-row created_height/created_time are preserved across a batched run', async () => {
  // These were per-block scalar parameters before batching; if they were
  // collapsed to a single value every UTXO in the run would share one height.
  const r = await pool.query(
    `SELECT created_height, COUNT(*)::int AS n FROM utxos
     WHERE created_height IN (1,2) GROUP BY created_height ORDER BY created_height`);
  assert.deepEqual(r.rows.map(x => x.created_height), [1, 2],
    'creations retain their own block heights, not the run tail');

  const times = await pool.query(
    `SELECT DISTINCT extract(epoch from created_time)::bigint::text AS ts
     FROM utxos WHERE created_height IN (1,2) ORDER BY ts`);
  assert.deepEqual(times.rows.map(x => x.ts), [String(t(0)), String(t(1))],
    'creation timestamps are per-block, not shared');
});

test('counters equal the sum of per-block deltas after a batched run', async () => {
  // The counters are accumulated in JS now; they must still agree exactly with
  // the block_agg rows that rollbackAbove() uses to reverse them (invariant 3).
  const agg = await pool.query(
    `SELECT COALESCE(SUM(realized_cap_delta),0)::text rc,
            COALESCE(SUM(cdd),0)::text cdd,
            COALESCE(SUM(vdd_usd),0)::text vdd,
            COALESCE(SUM(miner_rev_usd),0)::text mrev FROM block_agg`);
  const state = {
    rc: await getState(pool, 'realized_cap_usd'),
    cdd: await getState(pool, 'cum_cdd'),
    vdd: await getState(pool, 'cum_vdd_usd'),
    mrev: await getState(pool, 'cum_miner_rev_usd'),
  };
  assert.equal(state.rc, Number(agg.rows[0].rc), 'realized cap matches block_agg sum');
  assert.equal(state.cdd, Number(agg.rows[0].cdd), 'cum_cdd matches block_agg sum');
  assert.equal(state.vdd, Number(agg.rows[0].vdd), 'cum_vdd_usd matches block_agg sum');
  assert.equal(state.mrev, Number(agg.rows[0].mrev), 'thermocap matches block_agg sum');

  // Issuance is claimed subsidy only: two 50 BTC coinbases across blocks 1-2,
  // less the 0.1 BTC the spend tx paid in fees (fees in a coinbase are
  // recycled coins, not new supply).
  const supply = await getState(pool, 'circulating_supply_sat');
  assert.equal(supply, 9_990_000_000, 'issuance excludes recycled fees');
});

test('a duplicate (txid,vout) within one run keeps the first occurrence', async () => {
  // BIP30: the same coinbase txid appearing twice. Per-block the later insert
  // hit ON CONFLICT against a committed row; batched, both rows are in a single
  // statement and DO NOTHING must still keep the earlier one.
  const dup = '2a'.repeat(32);
  await processBlocks([
    block(3, 'h3', 2, [cb(dup, 50)]),
    block(4, 'h4', 3, [cb(dup, 25)]), // same txid/vout, different value
  ]);
  const r = await pool.query(
    `SELECT value_sat::text v, created_height FROM utxos
     WHERE txid = decode($1,'hex') AND vout = 0`, [dup]);
  assert.equal(r.rows.length, 1, 'exactly one row survives the duplicate');
  assert.equal(r.rows[0].created_height, 3, 'the FIRST occurrence is kept');
  assert.equal(r.rows[0].v, String(50 * SAT), 'with the first occurrence value');
});

test('an empty run is a no-op rather than an error', async () => {
  const before = await pool.query('SELECT COUNT(*)::int n FROM blocks');
  await processBlocks([]);
  const after = await pool.query('SELECT COUNT(*)::int n FROM blocks');
  assert.equal(after.rows[0].n, before.rows[0].n);
});
