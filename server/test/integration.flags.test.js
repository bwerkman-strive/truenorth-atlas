// Signup kill switches: OFF by default. New signups are blocked, but nothing
// that matters to existing users or compliance ever stops working —
// unsubscribe links, pending confirmations, and confirmed alerts all survive.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';

process.env.PGSSLMODE = 'disable';
process.env.RESEND_API_KEY = 're_test_key';
process.env.PUBLIC_SITE_URL = 'https://atlas.example.com';
process.env.PUBLIC_RATE_LIMIT_PER_MIN = '200';
// Deliberately NOT setting ALERT_SIGNUP_ENABLED / NEWSLETTER_SIGNUP_ENABLED.

const sentEmails = [];
const resendMock = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    sentEmails.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.setHeader('content-type', 'application/json');
    res.end('{"id":"re_flag_test"}');
  });
});
await new Promise(r => resendMock.listen(0, '127.0.0.1', r));
process.env.RESEND_BASE_URL = `http://127.0.0.1:${resendMock.address().port}`;

const { pool, migrate } = await import('../src/db.js');
const { checkAlerts } = await import('../src/alerts.js');
const { config } = await import('../src/config.js');
const { app } = await import('../src/api.js');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest();
let srv, base;

before(async () => {
  await migrate();
  await (await import('./guard.js')).assertScratchDb();
  await pool.query('TRUNCATE metrics_daily, alerts, subscribers, email_log');
  srv = app.listen(0);
  base = `http://127.0.0.1:${srv.address().port}`;
  config.publicApiUrl = base;
});
after(async () => { srv.close(); resendMock.close(); await pool.end(); });

test('both flags default to OFF and are visible on /api/status', async () => {
  assert.equal(config.alertSignupEnabled, false);
  assert.equal(config.newsletterSignupEnabled, false);
  const status = await (await fetch(base + '/api/status')).json();
  assert.deepEqual(status.features, { alertSignup: false, newsletterSignup: false });
});

test('new signups are refused with a friendly 403 while off', async () => {
  const alert = await fetch(base + '/api/alerts', { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'ben@example.com', slug: 'mvrv', condition: 'above', threshold: 3 }) });
  assert.equal(alert.status, 403);
  assert.match((await alert.json()).error, /not open yet/);

  const sub = await fetch(base + '/api/subscribe', { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'ben@example.com' }) });
  assert.equal(sub.status, 403);
  assert.equal(sentEmails.length, 0, 'no confirmation emails leak while off');
});

test('existing confirmed alerts still fire while signups are off', async () => {
  await pool.query(
    `INSERT INTO alerts (email, metric_slug, condition, threshold, confirm_hash, unsub_token, confirmed_at)
     VALUES ('holder@example.com','mvrv','above',2.5,$1,'stable-unsub-token', now())`,
    [sha256('pre-existing')]);
  await pool.query(`INSERT INTO metrics_daily (day, mvrv) VALUES ('2024-06-01', 2.4), ('2024-06-02', 2.6)`);
  const r = await checkAlerts();
  assert.equal(r.fired, 1, 'grandfathered alert crossed and fired');
  assert.match(sentEmails.at(-1).subject, /rises above 2\.5/);
});

test('unsubscribe links keep working while signups are off (compliance)', async () => {
  await pool.query(
    `INSERT INTO subscribers (email, confirm_hash, unsub_token, confirmed_at)
     VALUES ('reader@example.com', $1, 'sub-unsub-token', now())`, [sha256('x')]);
  assert.equal((await fetch(base + '/api/alerts/unsubscribe?token=stable-unsub-token')).status, 200);
  assert.equal((await fetch(base + '/api/subscribe/unsubscribe?token=sub-unsub-token')).status, 200);
});
