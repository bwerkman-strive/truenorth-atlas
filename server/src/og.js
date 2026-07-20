// Shareable chart cards.
//
//   GET /og/:slug.png   — 1200×630 branded PNG: metric chart, latest value,
//                         percentile, the Epoch Rings mark. Built as SVG in
//                         code and rasterized with sharp — no headless browser.
//   GET /share/:slug    — a tiny HTML page whose only job is Open Graph /
//                         Twitter meta tags (crawlers read those; humans get
//                         redirected to the app's hash route). This is what
//                         the frontend's Share button copies, because hash
//                         fragments never reach crawlers.
//
// Cards cache in memory for an hour — they change once per finalized day.
import express from 'express';
import sharp from 'sharp';
import { pool } from './db.js';
import { bySlug } from './catalog.js';
import { config } from './config.js';

const W = 1200, H = 630;
// Strive brand system: ink surface, bone text, slate secondary, hairlines.
// Orange is the reserved accent; aurora green survives as the chart-data color.
const INK = '#0b0c0e', LINE = '#333230';
const AURORA = '#4fe3a9', SLATE = '#918b7d', TEXT = '#f2ede3', BTC = '#f7931a';

const cache = new Map(); // slug -> { png, at }
const TTL = 60 * 60 * 1000;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Display dates as MM/DD/YYYY (ISO "YYYY-MM-DD" in, US format out).
const usDay = (d) => (/^\d{4}-\d{2}-\d{2}/.test(d ?? '') ? `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}` : d);

function fmtValue(v, format, unit) {
  if (v === null || v === undefined) return '—';
  const n = Number(v);
  const compact = (x) => {
    const a = Math.abs(x);
    if (a >= 1e12) return (x / 1e12).toFixed(2) + 'T';
    if (a >= 1e9) return (x / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return (x / 1e6).toFixed(2) + 'M';
    if (a >= 1e3) return (x / 1e3).toFixed(1) + 'K';
    return a >= 10 ? x.toFixed(0) : x.toFixed(2);
  };
  switch (format) {
    case 'usd': return n < 1000 ? '$' + n.toFixed(2) : '$' + Math.round(n).toLocaleString('en-US');
    case 'usd_compact': return '$' + compact(n);
    case 'percent': return (n * 100).toFixed(1) + '%';
    case 'ratio': return Math.abs(n) >= 100 ? Math.round(n).toLocaleString('en-US') : n.toFixed(2);
    case 'number': return compact(n) + (unit ? ' ' + unit : '');
    default: return String(v);
  }
}

function epochRingsMark(x, y, s) {
  // s = size; drawn around center (x,y)
  const r = (f) => (s / 240) * f;
  return `<g>
    <circle cx="${x}" cy="${y}" r="${r(34)}" stroke="${LINE}" stroke-width="${r(9)}" fill="none"/>
    <circle cx="${x}" cy="${y}" r="${r(58)}" stroke="${LINE}" stroke-width="${r(8)}" fill="none"/>
    <circle cx="${x}" cy="${y}" r="${r(78)}" stroke="${LINE}" stroke-width="${r(7)}" fill="none"/>
    <circle cx="${x}" cy="${y}" r="${r(94)}" stroke="${TEXT}" stroke-width="${r(8)}" fill="none" stroke-opacity="0.9"/>
    <path d="M${x} ${y - r(114)} L${x + r(7)} ${y - r(100)} L${x + r(21)} ${y - r(96)} L${x + r(7)} ${y - r(92)} L${x} ${y - r(78)} L${x - r(7)} ${y - r(92)} L${x - r(21)} ${y - r(96)} L${x - r(7)} ${y - r(100)} Z" fill="${TEXT}"/>
    <circle cx="${x + r(94) * Math.sin(1.1)}" cy="${y - r(94) * Math.cos(1.1)}" r="${r(11)}" fill="${BTC}"/>
  </g>`;
}

function linePath(rows, x0, y0, w, h) {
  const vals = rows.map(r => r.v).filter(v => v !== null);
  if (!vals.length) return { path: '', area: '' };
  let min = Math.min(...vals), max = Math.max(...vals);
  if (min === max) { min -= 1; max += 1; }
  const pad = (max - min) * 0.08;
  min -= pad; max += pad;
  const pts = [];
  rows.forEach((r, i) => {
    if (r.v === null) return;
    const x = x0 + (i / Math.max(1, rows.length - 1)) * w;
    const y = y0 + h - ((r.v - min) / (max - min)) * h;
    pts.push([x, y]);
  });
  if (!pts.length) return { path: '', area: '' };
  const path = 'M ' + pts.map(p => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' L ');
  const area = path + ` L ${pts[pts.length - 1][0].toFixed(1)} ${y0 + h} L ${pts[0][0].toFixed(1)} ${y0 + h} Z`;
  return { path, area };
}

export async function buildCardSvg(slug) {
  const m = bySlug[slug];
  if (!m || m.kind === 'stacked' || m.kind === 'urpd') return null;
  const col = Array.isArray(m.column) ? m.column[0] : m.column;

  const [seriesR, latestR, pctR] = await Promise.all([
    pool.query(`SELECT ${col}::float AS v FROM (
        SELECT day, ${col} FROM metrics_daily WHERE day > now() - interval '4 years' ORDER BY day
      ) t`),
    pool.query(`SELECT day::text AS d, ${col}::float AS v FROM metrics_daily
                WHERE ${col} IS NOT NULL ORDER BY day DESC LIMIT 1`),
    pool.query(`SELECT CASE WHEN COUNT(${col}) > 1 THEN
        COUNT(*) FILTER (WHERE ${col} <= (SELECT ${col} FROM metrics_daily WHERE ${col} IS NOT NULL ORDER BY day DESC LIMIT 1))::float / COUNT(${col})
      END AS p FROM metrics_daily`),
  ]);

  // Downsample to ~360 points for a clean path
  let rows = seriesR.rows;
  if (rows.length > 360) {
    const step = rows.length / 360;
    rows = Array.from({ length: 360 }, (_, i) => rows[Math.floor(i * step)]);
  }
  const latest = latestR.rows[0] ?? { d: null, v: null };
  const pct = pctR.rows[0]?.p;

  const { path, area } = linePath(rows, 80, 250, 1040, 280);
  const valueStr = fmtValue(latest.v, m.format, m.unit);
  const pctStr = pct !== null && pct !== undefined
    ? `${Math.round(pct * 100)}th percentile of all history` : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${AURORA}" stop-opacity="0.28"/>
      <stop offset="1" stop-color="${AURORA}" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="${INK}"/>

  ${epochRingsMark(96, 92, 96)}
  <text x="168" y="78" font-family="'IBM Plex Sans', 'DejaVu Sans', sans-serif" font-weight="700" font-size="30" fill="${TEXT}" letter-spacing="3">TRUE NORTH <tspan fill="${BTC}">ATLAS</tspan></text>
  <text x="168" y="112" font-family="'IBM Plex Sans', 'DejaVu Sans', sans-serif" font-size="19" fill="${SLATE}" letter-spacing="3">NAVIGATING THE BITCOIN LEDGER</text>

  <text x="80" y="188" font-family="'IBM Plex Sans', 'DejaVu Sans', sans-serif" font-weight="700" font-size="46" fill="${TEXT}">${esc(m.name)}</text>
  <text x="1120" y="150" text-anchor="end" font-family="'IBM Plex Sans', 'DejaVu Sans', sans-serif" font-weight="700" font-size="58" fill="${TEXT}">${esc(valueStr)}</text>
  <text x="1120" y="186" text-anchor="end" font-family="'IBM Plex Sans', 'DejaVu Sans', sans-serif" font-size="21" fill="${SLATE}">${esc(pctStr)}</text>

  <g stroke="${LINE}" stroke-width="1" opacity="0.7">
    <line x1="80" y1="320" x2="1120" y2="320"/><line x1="80" y1="390" x2="1120" y2="390"/>
    <line x1="80" y1="460" x2="1120" y2="460"/>
  </g>
  ${area ? `<path d="${area}" fill="url(#fade)"/>` : ''}
  ${path ? `<path d="${path}" stroke="${AURORA}" stroke-width="4" fill="none" stroke-linejoin="round" stroke-linecap="round"/>` : ''}
  ${!path ? `<text x="600" y="400" text-anchor="middle" font-family="'IBM Plex Sans', 'DejaVu Sans', sans-serif" font-size="26" fill="${SLATE}">Syncing history from a fully-validating node…</text>` : ''}

  <line x1="80" y1="560" x2="1120" y2="560" stroke="${LINE}" stroke-width="2"/>
  <text x="80" y="596" font-family="'IBM Plex Sans', 'DejaVu Sans', sans-serif" font-size="20" fill="${SLATE}">${esc(latest.d ? `As of ${usDay(latest.d)} UTC · computed from a fully-validating Bitcoin node` : 'Computed from a fully-validating Bitcoin node')}</text>
  <text x="1120" y="596" text-anchor="end" font-family="'IBM Plex Sans', 'DejaVu Sans', sans-serif" font-weight="600" font-size="20" fill="${SLATE}">${esc(config.publicSiteUrl.replace(/^https?:\/\//, ''))}</text>
</svg>`;
}

export function ogRouter() {
  const r = express.Router();

  r.get('/og/:slug.png', async (req, res) => {
    const slug = req.params.slug;
    try {
      const hit = cache.get(slug);
      if (hit && Date.now() - hit.at < TTL) {
        res.set('Content-Type', 'image/png').set('Cache-Control', 'public, max-age=3600');
        return res.send(hit.png);
      }
      const svg = await buildCardSvg(slug);
      if (!svg) return res.status(404).json({ error: 'no card for that metric' });
      const png = await sharp(Buffer.from(svg)).png().toBuffer();
      cache.set(slug, { png, at: Date.now() });
      res.set('Content-Type', 'image/png').set('Cache-Control', 'public, max-age=3600');
      res.send(png);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  r.get('/share/:slug', (req, res) => {
    const m = bySlug[req.params.slug];
    if (!m) return res.status(404).send('Unknown metric');
    const apiOrigin = config.publicApiUrl || `${req.protocol}://${req.get('host')}`;
    const img = `${apiOrigin}/og/${m.slug}.png`;
    const dest = `${config.publicSiteUrl}/#/m/${m.slug}`;
    const title = `${m.name} · True North Atlas`;
    const desc = m.short ?? 'Bitcoin on-chain analytics from a fully-validating node.';
    res.set('Cache-Control', 'public, max-age=3600').send(`<!doctype html>
<html><head><meta charset="utf-8">
<title>${esc(title)}</title>
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(img)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${esc(dest)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${esc(img)}">
<meta http-equiv="refresh" content="0; url=${esc(dest)}">
</head><body>
<p>Redirecting to <a href="${esc(dest)}">${esc(title)}</a>…</p>
<script>location.replace(${JSON.stringify(dest)});</script>
</body></html>`);
  });

  return r;
}
