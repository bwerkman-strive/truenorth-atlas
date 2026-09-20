// Growth-feature suite: shareable chart cards, Resend alerts, cycle overlays.
// Runs against real Postgres with a mock Resend server capturing every email.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.PGSSLMODE = 'disable';
process.env.ALERT_SIGNUP_ENABLED = 'true';
process.env.NEWSLETTER_SIGNUP_ENABLED = 'true';
process.env.PUBLIC_SITE_URL = 'https://atlas.example.com';
process.env.PUBLIC_API_URL = ''; // set after the API port is known
process.env.RESEND_API_KEY = 're_test_key';
process.env.PUBLIC_RATE_LIMIT_PER_MIN = '200';

// ---- mock Resend ------------------------------------------------------------
const sentEmails = [];
const resendMock = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    if (req.headers.authorization !== 'Bearer re_test_key') {
      res.statusCode = 401; return res.end('{"error":"bad key"}');
    }
    sentEmails.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 'email_' + sentEmails.length }));
  });
});
await new Promise(r => resendMock.listen(0, '127.0.0.1', r));
process.env.RESEND_BASE_URL = `http://127.0.0.1:${resendMock.address().port}`;

const { pool, migrate } = await import('../src/db.js');
const { checkAlerts } = await import('../src/alerts.js');
const { app } = await import('../src/api.js');
const { config } = await import('../src/config.js');

let srv, base;
before(async () => {
  await migrate();
  await (await import('./guard.js')).assertScratchDb();
  await pool.query('TRUNCATE metrics_daily, alerts, prices');
  // Seed two epochs of metrics so cycles + cards have real data:
  // epoch 4 (2020-04-19 start): 30 days of mvrv 1.0->1.29
  // epoch 5 (2024-04-19 start): 30 days of mvrv 2.0->2.29
  await pool.query(`
    INSERT INTO metrics_daily (day, price, mvrv, mvrv_z)
    SELECT ('2020-04-19'::date + i), 7000 + i * 10, 1.0 + i * 0.01, 0.5 FROM generate_series(0, 29) i`);
  await pool.query(`
    INSERT INTO metrics_daily (day, price, mvrv, mvrv_z)
    SELECT ('2024-04-19'::date + i), 64000 + i * 100, 2.0 + i * 0.01, 2.0 FROM generate_series(0, 29) i`);
  srv = app.listen(0);
  base = `http://127.0.0.1:${srv.address().port}`;
  config.publicApiUrl = base;
});
after(async () => { srv.close(); resendMock.close(); await pool.end(); });

const j = async (p, init) => {
  const r = await fetch(base + p, init);
  return { status: r.status, headers: r.headers, body: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text() };
};

// ---------------------------------------------------------------------------
// 1) Shareable chart cards
test('OG card renders a real 1200×630 PNG with an hour of cache', async () => {
  const r = await fetch(base + '/og/mvrv.png');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.match(r.headers.get('cache-control'), /max-age=3600/);
  const buf = Buffer.from(await r.arrayBuffer());
  // PNG magic + IHDR dimensions (big-endian at offsets 16/20)
  assert.deepEqual([...buf.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'PNG magic');
  assert.equal(buf.readUInt32BE(16), 1200, 'width');
  assert.equal(buf.readUInt32BE(20), 630, 'height');
});

test('OG card 404s for unknown and stacked metrics', async () => {
  assert.equal((await fetch(base + '/og/not-a-metric.png')).status, 404);
  assert.equal((await fetch(base + '/og/hodl-waves.png')).status, 404);
});

test('share page carries OG/Twitter tags and redirects humans to the app', async () => {
  const { status, body } = await j('/share/mvrv');
  assert.equal(status, 200);
  assert.match(body, /og:image" content="[^"]+\/og\/mvrv\.png"/);
  // Middot, not an em-dash: user-facing copy avoids em-dashes, and this string
  // is the social preview title (matches "The Signal · True North Atlas").
  assert.match(body, /og:title" content="MVRV Ratio · True North Atlas"/);
  assert.match(body, /twitter:card" content="summary_large_image"/);
  assert.match(body, new RegExp('https://atlas\\.example\\.com/#/m/mvrv'));
  assert.equal((await fetch(base + '/share/nope')).status, 404);
});

// ---------------------------------------------------------------------------
// 2) Alerts — the full lifecycle
let confirmToken, unsubToken;

test('creating an alert validates input and sends a confirmation email', async () => {
  for (const [bad, why] of [
    [{ email: 'not-an-email', slug: 'mvrv', condition: 'above', threshold: 3 }, 'email'],
    [{ email: 'ben@example.com', slug: 'hodl-waves', condition: 'above', threshold: 3 }, 'stacked metric'],
    [{ email: 'ben@example.com', slug: 'mvrv', condition: 'sideways', threshold: 3 }, 'condition'],
    [{ email: 'ben@example.com', slug: 'mvrv', condition: 'above', threshold: 'high' }, 'threshold'],
  ]) {
    const r = await j('/api/alerts', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(bad) });
    assert.equal(r.status, 400, `rejects bad ${why}`);
  }

  const before = sentEmails.length;
  const r = await j('/api/alerts', { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'Ben@Example.com', slug: 'mvrv', condition: 'above', threshold: 2.25 }) });
  assert.equal(r.status, 201);
  assert.equal(sentEmails.length, before + 1);
  const mail = sentEmails.at(-1);
  assert.deepEqual(mail.to, ['ben@example.com'], 'email normalized to lowercase');
  assert.match(mail.subject, /Confirm your Atlas alert: MVRV Ratio/);
  const m = mail.html.match(/confirm\?token=([A-Za-z0-9_-]+)/);
  assert.ok(m, 'confirmation link present');
  confirmToken = m[1];
});

test('unconfirmed alerts never fire', async () => {
  const r = await checkAlerts();
  assert.equal(r.fired, 0);
});

test('confirming activates the alert and redirects into the app', async () => {
  const r = await fetch(base + `/api/alerts/confirm?token=${confirmToken}`, { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location'), /#\/m\/mvrv\?alert=confirmed/);
  // Token is single-use.
  assert.equal((await fetch(base + `/api/alerts/confirm?token=${confirmToken}`)).status, 404);
});

test('alert fires exactly once on a threshold crossing, with a working unsubscribe link', async () => {
  // Latest two days: 2.29 (today) vs 2.28 (yesterday) — both above 2.25 already,
  // so NO crossing yet:
  assert.equal((await checkAlerts()).fired, 0, 'no fresh cross, no email');

  // A new finalized day arrives BELOW the threshold, then one back above -> cross.
  await pool.query(`INSERT INTO metrics_daily (day, mvrv) VALUES ('2024-05-19', 2.10)`);
  assert.equal((await checkAlerts()).fired, 0, 'dipping below does not fire an "above" alert');
  await pool.query(`INSERT INTO metrics_daily (day, mvrv) VALUES ('2024-05-20', 2.40)`);

  const before = sentEmails.length;
  assert.equal((await checkAlerts()).fired, 1, 'crossing fires');
  assert.equal((await checkAlerts()).fired, 0, 'idempotent: same day never double-sends');

  const mail = sentEmails.at(-1);
  assert.equal(sentEmails.length, before + 1);
  assert.match(mail.subject, /Atlas alert: MVRV Ratio rises above 2\.25/);
  assert.match(mail.html, /2\.4/);
  const u = mail.html.match(/unsubscribe\?token=([A-Za-z0-9_-]+)/);
  assert.ok(u, 'unsubscribe link present in the alert email');
  unsubToken = u[1];
});

test('unsubscribe kills the alert immediately and permanently', async () => {
  const r = await fetch(base + `/api/alerts/unsubscribe?token=${unsubToken}`);
  assert.equal(r.status, 200);
  // A fresh crossing after unsubscribe sends nothing.
  await pool.query(`INSERT INTO metrics_daily (day, mvrv) VALUES ('2024-05-21', 2.00)`);
  await pool.query(`INSERT INTO metrics_daily (day, mvrv) VALUES ('2024-05-22', 2.50)`);
  assert.equal((await checkAlerts()).fired, 0);
  assert.equal((await fetch(base + `/api/alerts/unsubscribe?token=${unsubToken}`)).status, 404, 'second click is a clean 404');
});

// ---------------------------------------------------------------------------
// 3) Cycle overlays
test('cycles endpoint re-bases each epoch to days-since-halving', async () => {
  const { status, body } = await j('/api/cycles/mvrv');
  assert.equal(status, 200);
  const epochs = Object.fromEntries(body.epochs.map(e => [e.epoch, e]));
  assert.ok(epochs[4] && epochs[5], 'both seeded epochs present');
  assert.equal(epochs[4].start, '2020-04-19');
  assert.equal(epochs[5].start, '2024-04-19');
  // Day 0 of each epoch is the halving day itself; values align by cycle-day.
  assert.equal(epochs[4].values[0].d, 0);
  assert.equal(epochs[4].values[0].v, 1.0);
  assert.equal(epochs[5].values[0].d, 0);
  assert.equal(epochs[5].values[0].v, 2.0);
  // Same cycle-day, different epochs -> directly comparable.
  const d10e4 = epochs[4].values.find(x => x.d === 10);
  const d10e5 = epochs[5].values.find(x => x.d === 10);
  assert.ok(Math.abs(d10e4.v - 1.10) < 1e-9);
  assert.ok(Math.abs(d10e5.v - 2.10) < 1e-9);
});

test('cycles endpoint guards its inputs', async () => {
  assert.equal((await fetch(base + '/api/cycles/not-a-metric')).status, 404);
  assert.equal((await fetch(base + '/api/cycles/hodl-waves')).status, 400);
});

// ---------------------------------------------------------------------------
// Bear-market bottom comparison: /api/bottoms re-bases each epoch's cycle low.
test('bottoms endpoint finds the epoch low and serves aligned panels', async () => {
  // A stylised epoch-3 cycle: 600 -> 20,000 over 600 days, down to 3,000 by
  // day 900, recovering after. STH cost basis rides at 90% of price.
  await pool.query(`
    INSERT INTO metrics_daily (day, price, sth_cost_basis)
    SELECT ('2016-07-09'::date + i),
           p, p * 0.9
    FROM generate_series(0, 1299) i,
    LATERAL (SELECT CASE WHEN i <= 600 THEN 600 + 19400.0 * i / 600
                         WHEN i <= 900 THEN 20000 - 17000.0 * (i - 600) / 300
                         ELSE 3000 + 7000.0 * (i - 900) / 400 END AS p) x
    ON CONFLICT (day) DO NOTHING`);
  const { status, headers, body } = await j('/api/bottoms');
  assert.equal(status, 200);
  assert.match(headers.get('cache-control'), /max-age=/);
  assert.equal(body.slug, 'bottom-comparison');
  assert.deepEqual(Object.keys(body).sort(), ['cycles', 'minDrawdown', 'slug', 'smaDays', 'smoothDays', 'window']);
  const c = body.cycles.find(x => x.epoch === 3);
  assert.ok(c, 'epoch 3 cycle present');
  assert.deepEqual(Object.keys(c).sort(), ['bottom', 'drawdown', 'end', 'epoch', 'peak', 'provisional', 'start', 'values']);
  assert.equal(c.provisional, false);
  assert.equal(c.bottom.day, '2018-12-26'); // 2016-07-09 + 900 days
  assert.equal(c.bottom.price, 3000);
  assert.equal(c.peak.price, 20000);
  assert.ok(Math.abs(c.drawdown - 0.85) < 1e-9);
  assert.equal(c.values.length, 731);
  assert.deepEqual(Object.keys(c.values[0]).sort(), ['ath', 'd', 'day', 'price', 'sma', 'sth']);
  assert.equal(c.values[0].d, -365);
  assert.equal(c.values.find(v => v.d === 0).price, 3000);
  // The seeded epochs 4/5 only rise, so neither has a bear market to show.
  assert.ok(!body.cycles.some(x => x.epoch === 4 || x.epoch === 5));
});

test('the bottoms catalog entry is a panel set, not a line: no cycle overlay, no alerts', async () => {
  assert.equal((await fetch(base + '/api/cycles/bottom-comparison')).status, 400);
  const series = await j('/api/series/bottom-comparison?from=2018-12-01&to=2018-12-31');
  assert.equal(series.status, 200);
  assert.deepEqual(series.body.columns, ['price', 'sth_cost_basis']);
  const cat = (await j('/api/catalog')).body.metrics.find(m => m.slug === 'bottom-comparison');
  assert.equal(cat.kind, 'bottoms');
  const latest = (await j('/api/latest')).body.values['bottom-comparison'];
  assert.equal(latest.value, null);
  assert.equal(latest.spark, undefined);
  const r = await fetch(base + '/api/alerts', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.99' },
    body: JSON.stringify({ email: 'b@example.com', slug: 'bottom-comparison', condition: 'above', threshold: 1 }),
  });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /unsupported/);
});

// ---------------------------------------------------------------------------
// Bear-market rallies: /api/rallies shares the detector with /api/bottoms.
test('rallies endpoint serves the price history and each bear\'s rally off its running low', async () => {
  // Uses the epoch-3 cycle seeded by the bottoms test above (monotonic fall
  // from the peak, so the only rally is the recovery, which is not a bear).
  const { status, headers, body } = await j('/api/rallies');
  assert.equal(status, 200);
  assert.match(headers.get('cache-control'), /max-age=/);
  assert.equal(body.slug, 'bear-rallies');
  assert.deepEqual(Object.keys(body).sort(), ['bears', 'excluded', 'minDrawdown', 'price', 'slug', 'smoothDays']);
  assert.ok(body.price.length > 1000);
  assert.deepEqual(Object.keys(body.price[0]).sort(), ['day', 'p']);
  assert.ok(body.excluded.length >= 1 && body.excluded[0].from && body.excluded[0].to && body.excluded[0].reason);
  const b = body.bears.find(x => x.epoch === 3);
  assert.ok(b, 'epoch 3 bear present');
  assert.deepEqual(Object.keys(b).sort(),
    ['current', 'days', 'drawdown', 'end', 'epoch', 'low', 'maxRally', 'ongoing', 'peak', 'rally', 'start', 'through']);
  assert.equal(b.ongoing, false);
  assert.equal(b.peak.price, 20000);
  assert.equal(b.low.day, '2018-12-26');
  assert.equal(b.through, '2018-12-26');
  assert.equal(b.days, 300);
  assert.equal(b.rally.length, 301);
  assert.equal(b.maxRally.value, 0, 'a straight fall has no rally');
  assert.ok(b.rally.every(x => x.r === 0));
});

test('the rallies catalog entry is a panel set too: no cycle overlay, no alerts, no spark', async () => {
  assert.equal((await fetch(base + '/api/cycles/bear-rallies')).status, 400);
  const cat = (await j('/api/catalog')).body.metrics.find(m => m.slug === 'bear-rallies');
  assert.equal(cat.kind, 'rallies');
  const latest = (await j('/api/latest')).body.values['bear-rallies'];
  assert.equal(latest.value, null);
  assert.equal(latest.spark, undefined);
  const r = await fetch(base + '/api/alerts', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.98' },
    body: JSON.stringify({ email: 'b@example.com', slug: 'bear-rallies', condition: 'above', threshold: 1 }),
  });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /unsupported/);
});
