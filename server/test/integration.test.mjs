// Integration test: spins up a mock Bitcoin Core RPC serving a 4-day synthetic
// chain with hand-computed expected metrics, runs the real sync worker against
// a real Postgres, and asserts the finalized metrics_daily rows.
//
// Chain (all values BTC; block time = noon UTC of its day):
//   day1 $100 : blk1 coinbase 50 -> A
//   day2 $200 : blk2 coinbase 50.1 (incl. 0.1 fee); tx spends A(50 @100, age 1d)
//               -> outputs 30 + 19.9 (fee 0.1)
//   day3 $150 : blk3 coinbase 50.05 (incl. 0.05 fee); tx spends the 30 @200 (age 1d)
//               -> output 29.95 (fee 0.05)
//   day4 $150 : blk4 coinbase 50 (empty) — exists only to finalize day3
//
// Expected (day2): supply 100.1, RC 20000, SOPR 2, CDD 50, realized profit 4990
// Expected (day3): supply 150.15, RC 26000, SOPR 0.75, CDD 30, realized loss 1500,
//                  supply-in-profit 0, MVRV 22522.5/26000
import http from 'node:http';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = 'postgres://app:app@localhost:5432/onchain';
process.env.PGSSLMODE = 'disable';
process.env.BITCOIN_RPC_URL = 'http://127.0.0.1:18443';
process.env.SKIP_PRICE_SYNC = '1';
process.env.SYNC_EXIT_AT_TIP = '1';
process.env.SYNC_BATCH_BLOCKS = '2'; // force day boundaries across batch edges
process.env.LOG_LEVEL = 'warn';

const { pool, migrate } = await import('../src/db.js');
const { main } = await import('../src/sync.js');

const T = (d, h = 12) => Math.floor(Date.parse(`2024-01-0${d}T${String(h).padStart(2, '0')}:00:00Z`) / 1000);
const txid = (n) => n.toString(16).padStart(64, '0');

const chain = [
  { hash: 'h0', height: 0, time: T(1, 0), difficulty: 1,
    tx: [{ txid: txid(1000), vin: [{ coinbase: '00' }], vout: [{ value: 50, n: 0, scriptPubKey: { type: 'pubkey' } }] }] },
  { hash: 'h1', height: 1, time: T(1), difficulty: 1,
    tx: [{ txid: txid(1), vin: [{ coinbase: '01' }], vout: [{ value: 50, n: 0, scriptPubKey: { type: 'pubkey' } }] }] },
  { hash: 'h2', height: 2, time: T(2), difficulty: 2,
    tx: [
      { txid: txid(2), vin: [{ coinbase: '02' }], vout: [{ value: 50.1, n: 0, scriptPubKey: { type: 'pubkey' } }] },
      { txid: txid(3), vin: [{ txid: txid(1), vout: 0, prevout: { value: 50, height: 1 } }],
        vout: [{ value: 30, n: 0, scriptPubKey: { type: 'pubkeyhash' } }, { value: 19.9, n: 1, scriptPubKey: { type: 'pubkeyhash' } }] },
    ] },
  { hash: 'h3', height: 3, time: T(3), difficulty: 2,
    tx: [
      { txid: txid(4), vin: [{ coinbase: '03' }], vout: [{ value: 50.05, n: 0, scriptPubKey: { type: 'pubkey' } }] },
      { txid: txid(5), vin: [{ txid: txid(3), vout: 0, prevout: { value: 30, height: 2 } }],
        vout: [{ value: 29.95, n: 0, scriptPubKey: { type: 'pubkeyhash' } }] },
    ] },
  { hash: 'h4', height: 4, time: T(4), difficulty: 3,
    tx: [{ txid: txid(6), vin: [{ coinbase: '04' }], vout: [{ value: 50, n: 0, scriptPubKey: { type: 'pubkey' } }] }] },
];

const rpcServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const { id, method, params } = JSON.parse(body);
    const reply = (result) => res.end(JSON.stringify({ id, result, error: null }));
    if (method === 'getblockchaininfo') return reply({ blocks: 4 });
    if (method === 'getblockhash') return reply(chain[params[0]].hash);
    if (method === 'getblock') return reply(chain.find((b) => b.hash === params[0]));
    res.end(JSON.stringify({ id, result: null, error: { message: 'unknown', code: -1 } }));
  });
});
await new Promise((r) => rpcServer.listen(18443, r));

// Fresh schema + seeded prices
await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
await migrate();
await pool.query(`INSERT INTO prices(day, close_usd) VALUES
  ('2024-01-01',100),('2024-01-02',200),('2024-01-03',150),('2024-01-04',150)`);

await main(); // sync to tip, finalize days 1-3, exit

const near = (a, b, eps = 1e-6, msg) => assert.ok(Math.abs(a - b) < eps, `${msg}: got ${a}, want ${b}`);
const row = async (d) => (await pool.query('SELECT * FROM metrics_daily WHERE day=$1', [d])).rows[0];

const d2 = await row('2024-01-02');
assert.ok(d2, 'day2 row exists');
near(+d2.circulating_supply, 100.0, 1e-9, 'd2 supply');
near(+d2.realized_cap, 20000, 1e-6, 'd2 realized cap');
near(+d2.realized_price, 20000 / 100.0, 1e-6, 'd2 realized price');
near(+d2.mvrv, (100.0 * 200) / 20000, 1e-9, 'd2 mvrv');
near(+d2.sopr, 2, 1e-9, 'd2 sopr');
assert.equal(d2.lth_sopr, null, 'd2 lth_sopr null (no old spends)');
near(+d2.cdd, 50, 1e-6, 'd2 cdd');
near(+d2.realized_profit, 5000, 1e-6, 'd2 realized profit');
near(+d2.realized_loss, 0, 1e-9, 'd2 realized loss');
near(+d2.sth_cost_basis, 200, 1e-6, 'd2 sth cost basis');
near(+d2.transfer_vol_btc, 50, 1e-9, 'd2 volume');
assert.equal(d2.hodl_waves['24h'] > 0.999, true, 'd2 waves all <24h');

const d3 = await row('2024-01-03');
near(+d3.circulating_supply, 150.0, 1e-9, 'd3 supply');
near(+d3.realized_cap, 26000, 1e-6, 'd3 realized cap');
near(+d3.mvrv, (150.0 * 150) / 26000, 1e-9, 'd3 mvrv');
near(+d3.sopr, 0.75, 1e-9, 'd3 sopr');
near(+d3.cdd, 30, 1e-6, 'd3 cdd');
near(+d3.realized_loss, 1500, 1e-6, 'd3 realized loss');
near(+d3.supply_profit_pct, 0, 1e-9, 'd3 supply in profit');
near(+d3.nupl, (150.0 * 150 - 26000) / (150.0 * 150), 1e-9, 'd3 nupl');
near(+d3.hodl_waves["24h"], 80 / 150.0, 1e-6, 'd3 wave 24h');
near(+d3.hodl_waves['1d–1w'], 70.0 / 150.0, 1e-6, 'd3 wave 1d-1w');
near(+d3.fees_pct_rev, 0.05 / 50.05, 1e-9, 'd3 fees pct');
near(+d3.hashrate_ehs, 2 * 2 ** 32 / 600 / 1e18, 1e-12, 'd3 hashrate');

// SOPR sanity on the UTXO table itself
const live = await pool.query('SELECT COUNT(*)::int c, SUM(value_sat)::bigint s FROM utxos WHERE spent_height IS NULL');
assert.equal(live.rows[0].c, 5, 'live utxo count'); // 19.9, 50.1, 29.95, 50.05, 50(blk4)
near(Number(live.rows[0].s) / 1e8, 200.0, 1e-9, 'live utxo sum');

console.log('✅ ALL INTEGRATION ASSERTIONS PASSED');
rpcServer.close();
await pool.end();
process.exit(0);
