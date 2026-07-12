// Second integration group, isolated in its own process (node:test runs each
// file separately) so it can point config at mock HTTP providers/nodes before
// the modules load.
//
//   1. syncPrices against a mock CryptoCompare: pre-market zero-fill,
//      pagination, upsert idempotency, priceForDay fallback behavior
//   2. checkReorg against a mock Bitcoin node whose hashes diverge
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.PGSSLMODE = 'disable';
process.env.RPC_MAX_RETRIES = '0';

// ---- mock CryptoCompare + mock Bitcoin node, up before module import -------
let ccCalls = 0;
let nodeHashes = {}; // height -> hash the "node" reports

const mock = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  res.setHeader('content-type', 'application/json');

  if (url.pathname.startsWith('/data/v2/histoday')) {
    ccCalls++;
    const toTs = Number(url.searchParams.get('toTs'));
    // Serve a deterministic 5-day candle window ending at toTs.
    const out = [];
    for (let i = 4; i >= 0; i--) {
      const t = toTs - i * 86400;
      out.push({ time: t, close: 100 + (t % 7) });
    }
    res.end(JSON.stringify({ Response: 'Success', Data: { Data: out } }));
    return;
  }

  // JSON-RPC surface for the mock node
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (body.method === 'getblockhash') {
      const h = body.params[0];
      if (nodeHashes[h] === undefined) {
        res.end(JSON.stringify({ id: body.id, error: { code: -8, message: 'Block height out of range' } }));
      } else {
        res.end(JSON.stringify({ id: body.id, result: nodeHashes[h] }));
      }
      return;
    }
    res.end(JSON.stringify({ id: body.id, error: { code: -32601, message: 'not mocked' } }));
  });
});
await new Promise(r => mock.listen(0, '127.0.0.1', r));
const mockPort = mock.address().port;
process.env.CRYPTOCOMPARE_BASE_URL = `http://127.0.0.1:${mockPort}`;
process.env.BITCOIN_RPC_URL = `http://127.0.0.1:${mockPort}`;
process.env.PRICE_PROVIDER = 'cryptocompare';

const { pool, migrate } = await import('../src/db.js');
const { syncPrices, priceForDay, bustPriceCache } = await import('../src/prices.js');
const { processBlocks, checkReorg, loadHeightMeta, heightMeta, tipHeight } = await import('../src/sync.js');

before(async () => {
  await migrate();
  await pool.query('TRUNCATE blocks, block_agg, utxos, prices, metrics_daily, chain_state');
  bustPriceCache();
  heightMeta.length = 0;
});

after(async () => { mock.close(); await pool.end(); });

// ---------------------------------------------------------------------------
test('syncPrices zero-fills the pre-market era and pages to today', async () => {
  await syncPrices(null);
  assert.ok(ccCalls > 0, 'provider was called');

  const genesis = await pool.query(`SELECT close_usd::float c FROM prices WHERE day='2009-01-03'`);
  assert.equal(genesis.rows[0].c, 0, 'genesis day zero-filled (correct pre-market cost basis)');

  const preMarketCnt = (await pool.query(
    `SELECT COUNT(*)::int c FROM prices WHERE day < '2010-07-17' AND close_usd = 0`)).rows[0].c;
  assert.equal(preMarketCnt, 560, 'every pre-market day present exactly once');

  const today = new Date().toISOString().slice(0, 10);
  const latest = (await pool.query(`SELECT MAX(day)::text d FROM prices WHERE close_usd > 0`)).rows[0].d;
  assert.ok(latest >= new Date(Date.now() - 2 * 86400e3).toISOString().slice(0, 10),
    `paged to (near) today: ${latest} vs ${today}`);

  const dupes = (await pool.query(
    `SELECT day FROM prices GROUP BY day HAVING COUNT(*) > 1`)).rows;
  assert.equal(dupes.length, 0, 'primary key + upsert leaves no duplicate days');
});

test('syncPrices is idempotent on re-run', async () => {
  const before1 = (await pool.query('SELECT COUNT(*)::int c FROM prices')).rows[0].c;
  await syncPrices(null);
  const after1 = (await pool.query('SELECT COUNT(*)::int c FROM prices')).rows[0].c;
  assert.equal(after1, before1);
});

test('priceForDay: exact day, cache, and last-close fallback for brand-new days', async () => {
  await pool.query(`INSERT INTO prices(day, close_usd) VALUES ('2099-01-01', 123456)
                    ON CONFLICT (day) DO UPDATE SET close_usd = EXCLUDED.close_usd`);
  bustPriceCache();
  assert.equal(await priceForDay('2099-01-01'), 123456);
  // A day with no candle yet (tip block on a new UTC day) -> most recent close.
  assert.equal(await priceForDay('2099-01-02'), 123456);
  // Cached value survives underlying row changes until bust.
  await pool.query(`UPDATE prices SET close_usd = 1 WHERE day='2099-01-01'`);
  assert.equal(await priceForDay('2099-01-01'), 123456, 'served from cache');
  bustPriceCache();
  assert.equal(await priceForDay('2099-01-01'), 1, 'cache bust rereads');
  await pool.query(`DELETE FROM prices WHERE day >= '2099-01-01'`);
  bustPriceCache();
});

// ---------------------------------------------------------------------------
test('checkReorg: agrees with the node -> tip unchanged', async () => {
  const T = Date.parse('2024-06-01T06:00:00Z') / 1000;
  const cb = (txid, v) => ({ txid, vin: [{ coinbase: '01' }], vout: [{ n: 0, value: v, scriptPubKey: { type: 'witness_v0_keyhash' } }] });
  await processBlocks([
    { height: 1, hash: 'aa11', time: T, difficulty: 1, tx: [cb('11'.repeat(32), 50)] },
    { height: 2, hash: 'aa22', time: T + 600, difficulty: 1, tx: [cb('22'.repeat(32), 50)] },
    { height: 3, hash: 'aa33', time: T + 1200, difficulty: 1, tx: [cb('33'.repeat(32), 50)] },
  ]);
  nodeHashes = { 1: 'aa11', 2: 'aa22', 3: 'aa33' };
  assert.equal(await checkReorg(), 3, 'consistent chain, tip stays');
  assert.equal(await tipHeight(), 3);
});

test('checkReorg: node diverges at the tip -> rolls back to the fork point', async () => {
  nodeHashes = { 1: 'aa11', 2: 'aa22', 3: 'bb33-competing' };
  const newTip = await checkReorg();
  assert.equal(newTip, 2, 'rolled back to last agreed height');
  assert.equal(await tipHeight(), 2);
  const gone = await pool.query(`SELECT 1 FROM blocks WHERE height=3`);
  assert.equal(gone.rows.length, 0);
  const supply = (await pool.query(
    `SELECT value::float v FROM chain_state WHERE key='circulating_supply_sat'`)).rows[0].v;
  assert.equal(supply, 100e8, 'supply counter reversed with the rollback');
});

test('loadHeightMeta rebuilds the in-memory index from the DB', async () => {
  heightMeta.length = 0;
  await loadHeightMeta();
  assert.ok(heightMeta[1] && heightMeta[2], 'heights restored');
  assert.equal(heightMeta[2].d, '2024-06-01');
  assert.equal(heightMeta[3], undefined, 'rolled-back height absent');
});
