// True North Atlas :: read API
// Small surface, aggressively cacheable:
//   GET /api/health           liveness probe (Render health check)
//   GET /api/status           sync progress + freshness
//   GET /api/catalog          categories + metric metadata (drives the UI)
//   GET /api/latest           most recent value of every metric (dashboard)
//   GET /api/series/:slug     time series ?from=YYYY-MM-DD&to=&downsample=
import express from 'express';
import cors from 'cors';
import compression from 'compression';
import pino from 'pino';
import { pool, migrate, getState } from './db.js';
import { projectSupply } from './supply.js';
import { CATEGORIES, METRICS, bySlug } from './catalog.js';
import { config } from './config.js';
import { explorerRouter, publicRateLimit } from './explorer.js';
import { adminRouter, requireApiKey } from './keys.js';
import { ogRouter } from './og.js';
import { alertsRouter, startAlertChecker } from './alerts.js';
import { subscribeRouter, newslettersAdminRouter, emailLogRouter, processNewsletters } from './newsletters.js';
import { getSpot } from './prices.js';

const log = pino({ level: process.env.LOG_LEVEL || 'info' });
const app = express();
app.use(cors({ origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(',') }));
app.use(compression());
app.set('etag', 'strong');

const cache = (res) => res.set('Cache-Control', `public, max-age=${config.apiCacheSeconds}`);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const IDENT_RE = /^[a-z_0-9]+$/; // column names come only from our catalog, but belt-and-braces

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Live BTC spot for the header (Massive last-trade when configured; falls back
// to the latest daily close). Short-lived by nature — no long cache headers.
app.get('/api/spot', async (_req, res) => {
  try {
    res.set('Cache-Control', 'public, max-age=15');
    res.json(await getSpot());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Shareable chart cards (OG images + crawler share pages) ---------------
app.use('/', ogRouter());
// ---- Metric alerts (double opt-in via Resend) --------------------------------
app.use('/api/alerts', alertsRouter(publicRateLimit));
// ---- Newsletter subscriptions (public) + composer/scheduler + audit (admin) ---
app.use('/api/subscribe', subscribeRouter(publicRateLimit));
app.use('/api/admin/newsletters', newslettersAdminRouter());
app.use('/api/admin/email-log', emailLogRouter());

// ---- Halving-cycle overlays ---------------------------------------------------
// GET /api/cycles/:slug -> the metric re-based to days-since-halving, one
// series per epoch, so cycles can be compared on a single chart.
const HALVINGS = [
  { epoch: 1, start: '2009-01-03' },
  { epoch: 2, start: '2012-11-28' },
  { epoch: 3, start: '2016-07-09' },
  { epoch: 4, start: '2020-04-19' },
  { epoch: 5, start: '2024-04-19' },
];
app.get('/api/cycles/:slug', async (req, res) => {
  const m = bySlug[req.params.slug];
  if (!m) return res.status(404).json({ error: 'unknown metric' });
  if (m.kind === 'stacked' || m.kind === 'urpd') return res.status(400).json({ error: 'cycle overlays are for line metrics' });
  const col = (Array.isArray(m.column) ? m.column[0] : m.column);
  if (!IDENT_RE.test(col)) return res.status(400).json({ error: 'bad metric' });
  try {
    const r = await pool.query(
      `SELECT day::text AS day, ${col}::float AS v FROM metrics_daily
       WHERE ${col} IS NOT NULL ORDER BY day ASC`);
    const epochs = HALVINGS.map((h, i) => ({
      epoch: h.epoch, start: h.start,
      end: HALVINGS[i + 1]?.start ?? '9999-12-31', values: [],
    }));
    for (const row of r.rows) {
      const e = epochs.findLast(x => row.day >= x.start && row.day < x.end);
      if (!e) continue;
      const d = Math.round((Date.parse(row.day) - Date.parse(e.start)) / 86400e3);
      e.values.push({ d, v: row.v });
    }
    // Downsample each epoch independently to <= 500 points
    for (const e of epochs) {
      if (e.values.length > 500) {
        const step = e.values.length / 500;
        const keep = [];
        for (let i = 0; i < e.values.length; i += step) keep.push(e.values[Math.floor(i)]);
        if (keep[keep.length - 1] !== e.values[e.values.length - 1]) keep.push(e.values[e.values.length - 1]);
        e.values = keep;
      }
    }
    cache(res);
    res.json({
      slug: m.slug,
      epochs: epochs.filter(e => e.values.length > 0)
        .map(({ epoch, start, values }) => ({ epoch, start, values })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Cost-basis distribution (URPD) ----------------------------------------
// GET /api/urpd[?day=YYYY-MM-DD] -> supply bucketed by acquisition price for
// one finalized day (default: the latest). Snapshotted daily; not a series.
app.get('/api/urpd', async (req, res) => {
  const day = DAY_RE.test(req.query.day ?? '') ? req.query.day : null;
  try {
    const r = await pool.query(
      `SELECT day::text AS day, price::float AS price, realized_price::float AS avg, urpd
       FROM metrics_daily
       WHERE urpd IS NOT NULL ${day ? 'AND day = $1' : ''}
       ORDER BY day DESC LIMIT 1`, day ? [day] : []);
    if (!r.rows.length) return res.status(404).json({ error: 'no finalized distribution for that day yet' });
    const row = r.rows[0];
    cache(res);
    // avg: the supply-weighted mean of the distribution = realized price,
    // taken from the same finalized row rather than re-derived from buckets.
    res.json({ slug: 'cost-basis-distribution', day: row.day, price: row.price, avg: row.avg, ...row.urpd });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Block explorer -------------------------------------------------------
// Free public surface (rate-limited per IP) — powers the website.
app.use('/api/explorer', publicRateLimit, explorerRouter());
// Private programmatic surface — identical data, requires an active API key.
app.use('/v1', requireApiKey, explorerRouter());
// Key administration (create/list/revoke), gated by ADMIN_TOKEN.
app.use('/api/admin', adminRouter());

app.get('/api/status', async (_req, res) => {
  try {
    const [tip, day, cnt] = await Promise.all([
      pool.query('SELECT MAX(height) h, MAX(time) t FROM blocks'),
      pool.query('SELECT MAX(day)::text d FROM metrics_daily'),
      pool.query('SELECT COUNT(*)::int c FROM metrics_daily'),
    ]);
    // Shorter TTL than the general API cache: the header polls this for the
    // live sync height, and three MAX/COUNT lookups are cheap to serve.
    res.set('Cache-Control', `public, max-age=${config.statusCacheSeconds}`);
    res.json({
      features: {
        alertSignup: config.alertSignupEnabled,
        newsletterSignup: config.newsletterSignupEnabled,
      },
      syncedHeight: tip.rows[0].h,
      syncedBlockTime: tip.rows[0].t,
      latestMetricsDay: day.rows[0].d,
      metricsDays: cnt.rows[0].c,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/catalog', (_req, res) => {
  cache(res);
  res.json({
    categories: CATEGORIES,
    metrics: METRICS.map(({ slug, name, category, format, unit, short, explain, method, zones, kind, logDefault, overlayPrice, unitToggle, projection }) => ({
      slug, name, category, format, unit, short, explain, method,
      zones: zones ?? [], kind: kind ?? 'line',
      logDefault: !!logDefault, overlayPrice: !!overlayPrice,
      unitToggle: unitToggle ?? null, projection: !!projection,
    })),
  });
});

app.get('/api/latest', async (_req, res) => {
  try {
    const r = await pool.query('SELECT * FROM metrics_daily ORDER BY day DESC LIMIT 1');
    if (!r.rows.length) return res.json({ day: null, values: {} });
    const row = r.rows[0];
    const spark = await pool.query(
      `SELECT * FROM metrics_daily ORDER BY day DESC LIMIT 30`);
    // Full-history percentile of the latest value per metric, one scan.
    const nonScalar = (m) => m.kind === 'stacked' || m.kind === 'urpd';
    const numericCols = [...new Set(METRICS.filter(m => !nonScalar(m)).map(m => m.column))]
      .filter(c => IDENT_RE.test(c));
    const pctSql = numericCols.map(c =>
      `CASE WHEN COUNT(${c}) > 1 THEN
         COUNT(*) FILTER (WHERE ${c} <= (SELECT ${c} FROM metrics_daily ORDER BY day DESC LIMIT 1))::float
         / COUNT(${c}) END AS ${c}`).join(', ');
    const pctR = await pool.query(`SELECT ${pctSql} FROM metrics_daily`);
    const pct = pctR.rows[0] ?? {};

    const values = {};
    for (const m of METRICS) {
      values[m.slug] = {
        // The urpd blob is fetched on demand via /api/urpd; keep /api/latest light.
        value: m.kind === 'urpd' ? null
          : row[m.column] !== null ? Number(row[m.column]) || row[m.column] : null,
        percentile: nonScalar(m) ? undefined
          : (pct[m.column] === null || pct[m.column] === undefined ? null : Number(pct[m.column])),
        spark: nonScalar(m) ? undefined
          : spark.rows.map(s => (s[m.column] === null ? null : Number(s[m.column]))).reverse(),
      };
    }
    cache(res);
    res.json({ day: row.day.toISOString().slice(0, 10), price: Number(row.price), values });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/series/:slug', async (req, res) => {
  const m = bySlug[req.params.slug];
  if (!m) return res.status(404).json({ error: 'unknown metric' });
  if (m.kind === 'urpd') return res.status(400).json({ error: 'not a time series; use /api/urpd' });
  const from = DAY_RE.test(req.query.from ?? '') ? req.query.from : '2010-01-01';
  const to = DAY_RE.test(req.query.to ?? '') ? req.query.to : '2100-01-01';
  const cols = (m.columns ?? [m.column]).filter(c => IDENT_RE.test(c));
  const withPrice = m.overlayPrice || req.query.price === '1';
  try {
    const sel = ['day::text AS day', ...cols, ...(withPrice && !cols.includes('price') ? ['price'] : [])];
    const r = await pool.query(
      `SELECT ${sel.join(', ')} FROM metrics_daily
       WHERE day BETWEEN $1 AND $2 ORDER BY day ASC`, [from, to]);
    // Optional decimation for very long ranges (keeps payloads light on mobile).
    let rows = r.rows;
    const target = parseInt(req.query.downsample ?? '0', 10);
    if (target > 0 && rows.length > target * 1.5) {
      const step = rows.length / target;
      const keep = [];
      for (let i = 0; i < rows.length; i += step) keep.push(rows[Math.floor(i)]);
      if (keep[keep.length - 1] !== rows[rows.length - 1]) keep.push(rows[rows.length - 1]);
      rows = keep;
    }
    const payload = { slug: m.slug, columns: cols, rows };

    // Projection (?project=1, catalog metrics with `projection` only): extend
    // the series past the tip on the consensus issuance schedule, plus every
    // halving marker — dated ones from HALVINGS, future ones at 600 s/block.
    if (m.projection && req.query.project === '1') {
      const tip = (await pool.query(
        'SELECT MAX(height)::int h, EXTRACT(EPOCH FROM MAX(time))::float8 t FROM blocks')).rows[0];
      if (tip.h !== null) {
        const tipSupplySat = await getState(pool, 'circulating_supply_sat');
        const { points, halvings } = projectSupply({
          tipHeight: tip.h, tipTimeSec: tip.t, tipSupplySat,
        });
        const past = HALVINGS.slice(1) // epoch 1 starts at genesis, not a halving
          .map((x, i) => ({ height: (i + 1) * 210_000, epoch: x.epoch, day: x.start, estimated: false }))
          .filter(x => x.height <= tip.h);
        payload.projection = points.map(p => ({ day: p.day, [cols[0]]: p.supply }));
        payload.halvings = [...past, ...halvings];
      }
    }
    cache(res);
    res.json(payload);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export { app };

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  migrate()
    .then(() => {
      app.listen(config.port, () => log.info({ port: config.port }, 'api listening'));
      startAlertChecker(log);
      if (config.resendApiKey) {
        const tick = () => processNewsletters(log).catch(e => log.error({ err: e.message }, 'newsletter tick failed'));
        tick();
        setInterval(tick, Math.min(config.alertsCheckIntervalMs, 60_000));
      }
    })
    .catch((e) => { log.fatal(e); process.exit(1); });
}
