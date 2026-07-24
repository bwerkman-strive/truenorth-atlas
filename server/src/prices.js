// Daily BTC/USD close history. On-chain valuation metrics (realized cap, SOPR,
// cost basis) key every UTXO to the close of its creation day, so we need a
// continuous daily series from genesis to today.
//
// Providers:
//  - cryptocompare: full history back to 2010-07 (free; API key raises limits)
//  - coinbase: exchange candles, 2015-07 onward (no key) — fallback/verification
// Days before the first market print (genesis .. 2010-07-16) are stored as 0,
// which is the economically correct cost basis for pre-market coins.
import { request } from 'undici';
import { pool } from './db.js';
import { config } from './config.js';

const GENESIS_DAY = '2009-01-03';
const dayStr = (d) => d.toISOString().slice(0, 10);

async function getJson(url, headers = {}) {
  const res = await request(url, { headers });
  if (res.statusCode >= 400) throw new Error(`HTTP ${res.statusCode} for ${url}`);
  return res.body.json();
}

async function fetchCryptoCompare(toTs) {
  const headers = config.cryptocompareApiKey
    ? { authorization: `Apikey ${config.cryptocompareApiKey}` } : {};
  const url = `${config.cryptocompareBaseUrl}/data/v2/histoday?fsym=BTC&tsym=USD&limit=2000&toTs=${toTs}`;
  const json = await getJson(url, headers);
  if (json.Response !== 'Success') throw new Error(`CryptoCompare: ${json.Message}`);
  return json.Data.Data.map(r => ({ day: dayStr(new Date(r.time * 1000)), close: r.close }));
}

// Massive daily aggregates: X:BTCUSD, one call covers the whole range (limit 50k).
async function fetchMassive(fromDay, toDay) {
  const url = `${config.massiveBaseUrl}/v2/aggs/ticker/X:BTCUSD/range/1/day/${fromDay}/${toDay}` +
    `?adjusted=true&sort=asc&limit=50000&apiKey=${config.massiveApiKey}`;
  const json = await getJson(url);
  if (json.status === 'ERROR') throw new Error(`Massive: ${json.error ?? 'aggregates error'}`);
  return (json.results ?? []).map(r => ({ day: dayStr(new Date(r.t)), close: r.c }));
}

async function fetchCoinbase(startISO, endISO) {
  const url = `${config.coinbaseBaseUrl}/products/BTC-USD/candles?granularity=86400&start=${startISO}&end=${endISO}`;
  const rows = await getJson(url, { 'user-agent': 'truenorth-atlas/1.0' });
  return rows.map(([t, , , , close]) => ({ day: dayStr(new Date(t * 1000)), close }));
}

// Providers may legitimately revise a candle while it finalizes; beyond that
// window a stored close is IMMUTABLE. Every UTXO's cost basis was stamped from
// the close at ingestion time and spends re-read this table, so a silent
// historical revision desyncs the two and corrupts realized cap permanently.
// Refusals are loud (error log) but non-fatal: one bad provider row must not
// wedge the whole price sync.
const REVISION_WINDOW_DAYS = 5;

export async function upsertPrices(rows, log) {
  if (!rows.length) return;
  const existing = await pool.query(
    'SELECT day::text AS day, close_usd FROM prices WHERE day = ANY($1::date[])',
    [rows.map(r => r.day)]);
  const stored = new Map(existing.rows.map(r => [r.day, Number(r.close_usd)]));
  const revisable = dayStr(new Date(Date.now() - REVISION_WINDOW_DAYS * 86400e3));

  const accepted = [];
  for (const r of rows) {
    const close = Number(r.close);
    if (!Number.isFinite(close) || close < 0) {
      log?.error({ day: r.day, close: r.close }, 'price guard: refusing non-finite/negative close');
      continue;
    }
    const cur = stored.get(r.day);
    if (cur !== undefined && r.day < revisable && Math.abs(close - cur) > Math.abs(cur) * 1e-9) {
      log?.error({ day: r.day, stored: cur, incoming: close },
        'price guard: refusing revision of a finalized close (closes are immutable)');
      continue;
    }
    accepted.push(r);
  }
  if (!accepted.length) return;

  const values = [];
  const params = [];
  accepted.forEach((r, i) => {
    values.push(`($${i * 2 + 1}::date, $${i * 2 + 2}::numeric)`);
    params.push(r.day, r.close);
  });
  await pool.query(
    `INSERT INTO prices(day, close_usd) VALUES ${values.join(',')}
     ON CONFLICT (day) DO UPDATE SET close_usd = EXCLUDED.close_usd`, params);
}

export async function syncPrices(log) {
  // 1) Zero-fill the pre-market era once.
  const preMarket = [];
  for (let d = new Date(GENESIS_DAY); dayStr(d) < '2010-07-17'; d.setUTCDate(d.getUTCDate() + 1)) {
    preMarket.push({ day: dayStr(d), close: 0 });
  }
  await pool.query(
    `INSERT INTO prices(day, close_usd)
     SELECT x.day::date, x.close FROM jsonb_to_recordset($1::jsonb) AS x(day text, close numeric)
     ON CONFLICT (day) DO NOTHING`, [JSON.stringify(preMarket)]);

  // 2) Find our latest stored day and pull forward to today.
  const today = dayStr(new Date());
  const r = await pool.query(`SELECT COALESCE(MAX(day), '2010-07-16')::text AS d FROM prices WHERE close_usd > 0
                              UNION ALL SELECT '2010-07-16' LIMIT 1`);
  let cursor = r.rows[0].d;

  if (config.massiveApiKey) {
    // Hybrid: CryptoCompare backfills the deep era our cost-basis engine
    // needs (2010 -> massiveCryptoStart); Massive is canonical from there.
    const start = config.massiveCryptoStart;
    while (cursor < start) {
      const toTs = Math.floor(Math.min(
        new Date(cursor + 'T00:00:00Z').getTime() + 2000 * 86400e3,
        new Date(start + 'T00:00:00Z').getTime()) / 1000);
      const rows = (await fetchCryptoCompare(toTs)).filter(x => x.close > 0 && x.day < start);
      await upsertPrices(rows, log);
      const maxDay = rows.reduce((m, x) => (x.day > m ? x.day : m), cursor);
      if (maxDay <= cursor) break;
      cursor = maxDay;
      log?.info({ cursor }, 'price sync (cryptocompare backfill)');
    }
    const from = cursor > start ? cursor : start;
    const rows = (await fetchMassive(from, today)).filter(x => x.close > 0);
    await upsertPrices(rows, log);
    log?.info({ from, rows: rows.length }, 'price sync (massive)');
    return;
  }

  if (config.priceProvider === 'coinbase') {
    while (cursor < today) {
      const start = new Date(cursor + 'T00:00:00Z');
      const end = new Date(Math.min(start.getTime() + 290 * 86400e3, Date.now()));
      const rows = await fetchCoinbase(start.toISOString(), end.toISOString());
      await upsertPrices(rows, log);
      cursor = dayStr(end);
      log?.info({ cursor }, 'price sync (coinbase)');
    }
  } else {
    // CryptoCompare pages backward from toTs; walk forward in 2000-day windows.
    while (cursor < today) {
      const toTs = Math.floor(Math.min(
        new Date(cursor + 'T00:00:00Z').getTime() + 2000 * 86400e3, Date.now()) / 1000);
      const rows = (await fetchCryptoCompare(toTs)).filter(x => x.close > 0);
      await upsertPrices(rows, log);
      const maxDay = rows.reduce((m, x) => (x.day > m ? x.day : m), cursor);
      if (maxDay <= cursor) break; // no forward progress => done
      cursor = maxDay;
      log?.info({ cursor }, 'price sync (cryptocompare)');
    }
  }
}

// In-memory day->price map for the sync hot path (refreshes lazily).
const priceCache = new Map();
export async function priceForDay(day) {
  if (priceCache.has(day)) return priceCache.get(day);
  const r = await pool.query('SELECT close_usd FROM prices WHERE day=$1', [day]);
  if (!r.rows.length) {
    // Tip block on a brand-new UTC day before the daily candle exists: use the
    // latest close ON OR BEFORE the requested day. At the tip that is
    // yesterday's close, same as before — but for a mid-history hole it is the
    // previous day's close instead of the newest close in the table. The old
    // unbounded form valued all of 2015-08-26 at a 2026 price during the July
    // 2026 replay (the prices table had exactly one missing day) and poisoned
    // every downstream cost basis; see assertNoPriceGaps, which now makes a
    // hole fail loudly instead.
    const p = await pool.query(
      'SELECT close_usd FROM prices WHERE day <= $1 ORDER BY day DESC LIMIT 1', [day]);
    const v = p.rows.length ? Number(p.rows[0].close_usd) : 0;
    // Durable marker: cost bases stamped from this fallback are PROVISIONAL.
    // Day finalization (metricsDaily.repriceProvisionalDay) re-stamps them
    // with the true close once it exists, keeping the realized-cap books
    // exact at the tip. chain_state survives worker restarts, so a mid-day
    // restart cannot orphan half-provisional stamps.
    await pool.query(
      `INSERT INTO chain_state (key, value) VALUES ($1, 1) ON CONFLICT (key) DO NOTHING`,
      ['provisional:' + day]);
    priceCache.set(day, v);
    return v;
  }
  const v = Number(r.rows[0].close_usd);
  priceCache.set(day, v);
  return v;
}
export function bustPriceCache() { priceCache.clear(); }

// A hole in the daily series silently corrupts cost bases (every metric keys
// UTXOs to their creation-day close), so the worker refuses to sync while one
// exists. Providers have skipped days before (2015-08-26); this turns that
// class of failure from silent poison into a loud boot error.
export async function assertNoPriceGaps() {
  const r = await pool.query(`
    SELECT d::date::text AS day
    FROM generate_series((SELECT MIN(day) FROM prices), (SELECT MAX(day) FROM prices), '1 day') d
    EXCEPT SELECT day::text FROM prices
    ORDER BY 1 LIMIT 10`);
  if (r.rows.length) {
    throw new Error(
      `prices table has ${r.rows.length}${r.rows.length === 10 ? '+' : ''} missing day(s): ` +
      r.rows.map(x => x.day).join(', ') +
      ' — fill them (INSERT INTO prices) before syncing');
  }

  // A zero/negative close after the first market print is provider garbage,
  // not economics (only the pre-market zero-fill era is legitimately 0).
  const z = await pool.query(`
    SELECT day::text AS day, close_usd FROM prices
    WHERE close_usd <= 0
      AND day > (SELECT MIN(day) FROM prices WHERE close_usd > 0)
    ORDER BY day LIMIT 5`);
  if (z.rows.length) {
    throw new Error(`prices table has non-positive close(s) after market start: ` +
      z.rows.map(x => `${x.day}=${x.close_usd}`).join(', '));
  }

  // No adjacent-day close has ever legitimately moved 10x; a jump that size is
  // a mis-dated or corrupt candle. (Both sides must be > 0: the pre-market ->
  // first-print boundary is exempt by construction.)
  const j = await pool.query(`
    SELECT day::text AS day, close_usd, prev FROM (
      SELECT day, close_usd, LAG(close_usd) OVER (ORDER BY day) AS prev
      FROM prices) t
    WHERE close_usd > 0 AND prev > 0
      AND (close_usd / prev > 10 OR prev / close_usd > 10)
    ORDER BY day LIMIT 5`);
  if (j.rows.length) {
    throw new Error(`prices table has implausible day-over-day jump(s): ` +
      j.rows.map(x => `${x.day}: ${x.prev} -> ${x.close_usd}`).join(', '));
  }
}

// ---------------------------------------------------------------------------
// Live spot price (Massive last trade), cached briefly in memory. Display-only:
// daily closes remain canonical for every metric and cost basis.
let spotCache = { price: null, at: 0 };
export async function getSpot() {
  if (config.massiveApiKey) {
    if (Date.now() - spotCache.at < config.spotCacheMs && spotCache.price !== null) {
      return { price: spotCache.price, at: spotCache.at, source: 'massive_live' };
    }
    try {
      const json = await getJson(
        `${config.massiveBaseUrl}/v2/last/trade/X:BTCUSD?apiKey=${config.massiveApiKey}`);
      const p = json?.results?.p;
      if (typeof p === 'number' && p > 0) {
        spotCache = { price: p, at: Date.now() };
        return { price: p, at: spotCache.at, source: 'massive_live' };
      }
    } catch { /* fall through to daily close */ }
  }
  const r = await pool.query(
    `SELECT close_usd::float p, day::text d FROM prices WHERE close_usd > 0 ORDER BY day DESC LIMIT 1`);
  return r.rows.length
    ? { price: r.rows[0].p, at: Date.parse(r.rows[0].d), source: 'daily_close' }
    : { price: null, at: null, source: 'none' };
}
export function bustSpotCache() { spotCache = { price: null, at: 0 }; }
