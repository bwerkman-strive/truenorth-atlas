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
