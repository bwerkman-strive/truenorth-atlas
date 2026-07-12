// Massive (Polygon) integration: hybrid daily-close sync, live spot with
// caching and fallback, and the new pricing-models composite — all against a
// mock Massive + mock CryptoCompare.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.PGSSLMODE = 'disable';
process.env.MASSIVE_API_KEY = 'mk_test';
process.env.MASSIVE_CRYPTO_START = '2015-01-01';
process.env.SPOT_CACHE_MS = '60000';
process.env.PUBLIC_RATE_LIMIT_PER_MIN = '200';

let massiveAggCalls = 0, massiveTradeCalls = 0, ccCalls = 0;
let spotPrice = 108250.5;

const mock = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  res.setHeader('content-type', 'application/json');

  // Massive daily aggregates
  if (url.pathname.startsWith('/v2/aggs/ticker/X:BTCUSD/range/1/day/')) {
    massiveAggCalls++;
    assert.equal(url.searchParams.get('apiKey'), 'mk_test');
    const [, from, to] = url.pathname.match(/day\/(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})/);
    const results = [];
    const end = new Date(Math.min(Date.parse(to), Date.parse(from) + 9 * 86400e3));
    for (let d = new Date(from + 'T00:00:00Z'); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      results.push({ t: d.getTime(), c: 50_000 + d.getUTCDate() }); // distinguishable "massive" closes
    }
    return res.end(JSON.stringify({ status: 'OK', results }));
  }

  // Massive last trade
  if (url.pathname === '/v2/last/trade/X:BTCUSD') {
    massiveTradeCalls++;
    return res.end(JSON.stringify({ status: 'OK', results: { p: spotPrice, t: Date.now() * 1e6 } }));
  }

  // CryptoCompare histoday (deep backfill era only)
  if (url.pathname.startsWith('/data/v2/histoday')) {
    ccCalls++;
    const toTs = Number(url.searchParams.get('toTs'));
    const out = [];
    for (let i = 6; i >= 0; i--) {
      out.push({ time: toTs - i * 86400, close: 400 + i }); // "cryptocompare" closes
    }
    return res.end(JSON.stringify({ Response: 'Success', Data: { Data: out } }));
  }
  res.statusCode = 404; res.end('{}');
});
await new Promise(r => mock.listen(0, '127.0.0.1', r));
const port = mock.address().port;
process.env.MASSIVE_BASE_URL = `http://127.0.0.1:${port}`;
process.env.CRYPTOCOMPARE_BASE_URL = `http://127.0.0.1:${port}`;

const { pool, migrate } = await import('../src/db.js');
const { syncPrices, getSpot, bustSpotCache, bustPriceCache } = await import('../src/prices.js');
const { config } = await import('../src/config.js');
const { app } = await import('../src/api.js');

let srv, base;
before(async () => {
  await migrate();
  await pool.query('TRUNCATE prices, metrics_daily');
  bustPriceCache(); bustSpotCache();
  srv = app.listen(0);
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(async () => { srv.close(); mock.close(); await pool.end(); });

// ---------------------------------------------------------------------------
test('hybrid sync: CryptoCompare backfills pre-2015 only, Massive is canonical after', async () => {
  // Seed the cursor near the boundary so both providers are exercised quickly.
  await pool.query(`INSERT INTO prices (day, close_usd) VALUES ('2014-12-20', 350)`);
  await syncPrices(null);

  assert.ok(ccCalls >= 1, 'deep-history provider used for the pre-Massive era');
  assert.ok(massiveAggCalls >= 1, 'Massive used from its start date');

  // Boundary integrity: everything >= 2015-01-01 carries Massive closes (50k+),
  // everything before carries backfill closes (hundreds).
  const post = await pool.query(
    `SELECT MIN(close_usd)::float lo FROM prices WHERE day >= '2015-01-01' AND close_usd > 0`);
  assert.ok(post.rows[0].lo >= 50_000, `post-boundary rows are Massive's (min=${post.rows[0].lo})`);
  const pre = await pool.query(
    `SELECT MAX(close_usd)::float hi FROM prices WHERE day < '2015-01-01' AND close_usd > 0`);
  assert.ok(pre.rows[0].hi < 1000, 'pre-boundary rows are backfill');
  const dupes = await pool.query(`SELECT day FROM prices GROUP BY day HAVING COUNT(*) > 1`);
  assert.equal(dupes.rows.length, 0);
});

test('live spot: Massive last trade, served from cache within the TTL', async () => {
  bustSpotCache();
  const before = massiveTradeCalls;
  const s1 = await getSpot();
  assert.equal(s1.source, 'massive_live');
  assert.equal(s1.price, 108250.5);
  spotPrice = 999_999; // provider moves, but our cache is fresh
  const s2 = await getSpot();
  assert.equal(s2.price, 108250.5, 'served from cache');
  assert.equal(massiveTradeCalls, before + 1, 'exactly one upstream call');
});

test('/api/spot endpoint shape and short cache header', async () => {
  const r = await fetch(base + '/api/spot');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('cache-control'), /max-age=15/);
  const body = await r.json();
  assert.equal(body.source, 'massive_live');
  assert.equal(typeof body.price, 'number');
});

test('spot falls back to the latest daily close when Massive is unavailable', async () => {
  const saved = config.massiveApiKey;
  config.massiveApiKey = '';
  bustSpotCache();
  const s = await getSpot();
  config.massiveApiKey = saved;
  assert.equal(s.source, 'daily_close');
  assert.ok(s.price > 0, 'still returns a price');
});

// ---------------------------------------------------------------------------
test('pricing-models composite: price + three on-chain floors on one chart', async () => {
  await pool.query(`
    INSERT INTO metrics_daily (day, price, realized_price, balanced_price, sth_cost_basis)
    VALUES ('2024-06-01', 64000, 31000, 24000, 58000), ('2024-06-02', 65000, 31100, 24100, 58500)`);
  const r = await (await fetch(base + '/api/series/pricing-models')).json();
  assert.deepEqual(r.columns, ['price', 'realized_price', 'balanced_price', 'sth_cost_basis']);
  assert.equal(Number(r.rows[1].price), 65000);
  assert.equal(Number(r.rows[1].sth_cost_basis), 58500);

  // Same-axis metrics include price as a sibling column — no double fetch.
  const rp = await (await fetch(base + '/api/series/realized-price')).json();
  assert.deepEqual(rp.columns, ['realized_price', 'price']);

  // Composite excluded from alerts (semantically ambiguous).
  process.env.ALERT_SIGNUP_ENABLED = 'true';
  config.alertSignupEnabled = true;
  const alert = await fetch(base + '/api/alerts', { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'x@example.com', slug: 'pricing-models', condition: 'above', threshold: 1 }) });
  assert.equal(alert.status, 400);
});
