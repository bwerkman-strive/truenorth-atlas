// Email platform suite: audit trail completeness, the standard template,
// subscriber double-opt-in, and the full newsletter draft->schedule->send
// lifecycle — against real Postgres and a mock Resend that can also fail on
// demand (to prove failures are audited too).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.PGSSLMODE = 'disable';
process.env.ALERT_SIGNUP_ENABLED = 'true';
process.env.NEWSLETTER_SIGNUP_ENABLED = 'true';
process.env.PUBLIC_SITE_URL = 'https://atlas.example.com';
process.env.RESEND_API_KEY = 're_test_key';
process.env.PUBLIC_RATE_LIMIT_PER_MIN = '500';
process.env.ADMIN_TOKEN = 'test-admin-secret';

const sentEmails = [];
let failFor = null; // recipient address the mock should 500 on
const resendMock = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString());
    res.setHeader('content-type', 'application/json');
    if (failFor && body.to.includes(failFor)) {
      res.statusCode = 500;
      return res.end('{"error":"provider exploded"}');
    }
    sentEmails.push(body);
    res.end(JSON.stringify({ id: 're_msg_' + sentEmails.length }));
  });
});
await new Promise(r => resendMock.listen(0, '127.0.0.1', r));
process.env.RESEND_BASE_URL = `http://127.0.0.1:${resendMock.address().port}`;

const { pool, migrate } = await import('../src/db.js');
const { mdLite, renderEmail, sendEmail } = await import('../src/email.js');
const { processNewsletters } = await import('../src/newsletters.js');
const { app } = await import('../src/api.js');
const { config } = await import('../src/config.js');

let srv, base;
const ROOT = { authorization: 'Bearer test-admin-secret', 'content-type': 'application/json' };
const j = async (p, init) => {
  const r = await fetch(base + p, init);
  const ct = r.headers.get('content-type') ?? '';
  return { status: r.status, headers: r.headers, body: ct.includes('json') ? await r.json() : await r.text() };
};

before(async () => {
  await migrate();
  await (await import('./guard.js')).assertScratchDb();
  await pool.query('TRUNCATE metrics_daily, alerts, subscribers, newsletters, email_log, admins');
  await pool.query(`
    INSERT INTO metrics_daily (day, price, mvrv)
    SELECT ('2024-04-19'::date + i), 64000 + i * 100, 2.0 + i * 0.01 FROM generate_series(0, 29) i`);
  srv = app.listen(0);
  base = `http://127.0.0.1:${srv.address().port}`;
  config.publicApiUrl = base;
});
after(async () => { srv.close(); resendMock.close(); await pool.end(); });

// ---------------------------------------------------------------------------
// Standard format + markdown-lite
test('mdLite: paragraphs, headings, bold, links, bullets — and no HTML injection', () => {
  const html = mdLite('## The read\n\nMVRV is **stretched** — see [the chart](https://atlas.example.com).\n\n- point one\n- point two');
  assert.match(html, /<h2[^>]*>The read<\/h2>/);
  assert.match(html, /<strong>stretched<\/strong>/);
  assert.match(html, /<a href="https:\/\/atlas\.example\.com"/);
  assert.match(html, /<li[^>]*>point one<\/li>/);
  const evil = mdLite('<script>alert(1)</script> & <img onerror=x>');
  assert.ok(!evil.includes('<script>'), 'script tags escaped');
  assert.ok(evil.includes('&lt;script&gt;'), 'shown as text, not markup');
});

test('the standard template carries the brand, disclaimer, and unsubscribe', () => {
  const html = renderEmail({
    eyebrow: 'Signal', title: 'Test', preheader: 'Preview line',
    bodyHtml: '<p>body</p>', cta: { label: 'Open Atlas', url: 'https://atlas.example.com' },
    unsubUrl: 'https://x/unsub?token=t',
  });
  for (const needle of ['TRUE NORTH', 'ATLAS', 'Navigating the Bitcoin Ledger',
    'investment advice', 'Unsubscribe', 'Powered by Strive', 'Preview line', 'Open Atlas']) {
    assert.ok(html.includes(needle), `template contains "${needle}"`);
  }
});

// ---------------------------------------------------------------------------
// Audit trail: EVERY send is recorded, including failures
test('sendEmail logs successes with the provider message id', async () => {
  await sendEmail({ to: 'audit@example.com', subject: 'Audit check', html: '<p>x</p>', kind: 'newsletter_test' });
  const row = (await pool.query(
    `SELECT * FROM email_log WHERE recipient='audit@example.com'`)).rows[0];
  assert.equal(row.status, 'sent');
  assert.equal(row.kind, 'newsletter_test');
  assert.match(row.provider_id, /^re_msg_/);
  assert.equal(row.error, null);
});

test('sendEmail logs FAILURES too — the audit trail has no blind spots', async () => {
  failFor = 'doomed@example.com';
  await assert.rejects(() => sendEmail({
    to: 'doomed@example.com', subject: 'Will fail', html: '<p>x</p>', kind: 'newsletter_test' }));
  failFor = null;
  const row = (await pool.query(
    `SELECT * FROM email_log WHERE recipient='doomed@example.com'`)).rows[0];
  assert.equal(row.status, 'failed');
  assert.match(row.error, /Resend 500/);
  assert.equal(row.provider_id, null);
});

test('the email-log endpoint is admin-only and filterable', async () => {
  assert.equal((await fetch(base + '/api/admin/email-log')).status, 401);
  const all = await j('/api/admin/email-log', { headers: ROOT });
  assert.equal(all.status, 200);
  assert.ok(all.body.entries.length >= 2);
  assert.ok(all.body.stats.some(s => s.status === 'failed' && s.c >= 1), 'failure visible in stats');
  const filtered = await j('/api/admin/email-log?kind=alert_fire', { headers: ROOT });
  assert.ok(filtered.body.entries.every(e => e.kind === 'alert_fire'));
});

// ---------------------------------------------------------------------------
// Subscribers
const subTokens = {};
async function subscribeAndConfirm(email) {
  await j('/api/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }) });
  const mail = sentEmails.findLast(m => m.to.includes(email));
  const t = mail.html.match(/confirm\?token=([A-Za-z0-9_-]+)/)[1];
  await fetch(base + `/api/subscribe/confirm?token=${t}`, { redirect: 'manual' });
}

test('subscribe: double opt-in; unconfirmed addresses receive nothing later', async () => {
  const r = await j('/api/subscribe', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'bad' }) });
  assert.equal(r.status, 400);

  await subscribeAndConfirm('crew1@example.com');
  await subscribeAndConfirm('crew2@example.com');
  // crew3 signs up but never confirms:
  await j('/api/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'crew3@example.com' }) });

  const confirmed = (await pool.query(
    `SELECT COUNT(*)::int c FROM subscribers WHERE confirmed_at IS NOT NULL`)).rows[0].c;
  assert.equal(confirmed, 2);
  // Audit: all three confirmation sends recorded.
  const logs = (await pool.query(
    `SELECT COUNT(*)::int c FROM email_log WHERE kind='subscribe_confirm'`)).rows[0].c;
  assert.equal(logs, 3);
});

// ---------------------------------------------------------------------------
// Newsletter lifecycle
let nlId;
test('draft: create, validate charts, edit', async () => {
  const bad = await j('/api/admin/newsletters', { method: 'POST', headers: ROOT,
    body: JSON.stringify({ subject: 'x', charts: ['hodl-waves'] }) });
  assert.equal(bad.status, 400, 'stacked charts rejected');

  const r = await j('/api/admin/newsletters', { method: 'POST', headers: ROOT,
    body: JSON.stringify({
      subject: 'The Weekly Bearing',
      preheader: 'Where the ledger stands.',
      body_md: '## The read\n\nMVRV is **stretched**.\n\n- watch the 2.5 line',
      charts: ['mvrv', 'price'],
    }) });
  assert.equal(r.status, 201);
  nlId = r.body.id;

  const upd = await j(`/api/admin/newsletters/${nlId}`, { method: 'PUT', headers: ROOT,
    body: JSON.stringify({ subject: 'The Weekly Bearing — Edition 1', preheader: 'Where the ledger stands.',
      body_md: '## The read\n\nMVRV is **stretched**.', charts: ['mvrv'] }) });
  assert.equal(upd.status, 200);
});

test('test-send renders the full format with the chart card embedded', async () => {
  const r = await j(`/api/admin/newsletters/${nlId}/test`, { method: 'POST', headers: ROOT,
    body: JSON.stringify({ email: 'ben@example.com' }) });
  assert.equal(r.status, 200);
  const mail = sentEmails.at(-1);
  assert.equal(mail.subject, '[TEST] The Weekly Bearing — Edition 1');
  assert.match(mail.html, /og\/mvrv\.png/, 'chart card embedded');
  assert.match(mail.html, /#\/m\/mvrv/, 'chart links back to the site');
  assert.match(mail.html, /<strong>stretched<\/strong>/, 'markdown rendered');
  assert.ok(mail.html.includes('The Signal · True North Atlas'.toUpperCase().slice(0, 3)) || mail.html.includes('The Signal'), 'eyebrow present');
});

test('scheduled send: every confirmed subscriber, per-recipient unsubscribe, full audit', async () => {
  // Schedule in the past -> rejected; "now" -> accepted.
  const past = await j(`/api/admin/newsletters/${nlId}/schedule`, { method: 'POST', headers: ROOT,
    body: JSON.stringify({ send_at: '2020-01-01T00:00:00Z' }) });
  assert.equal(past.status, 400);
  const now = await j(`/api/admin/newsletters/${nlId}/schedule`, { method: 'POST', headers: ROOT,
    body: JSON.stringify({ send_at: 'now' }) });
  assert.equal(now.status, 200);

  const before = sentEmails.length;
  const result = await processNewsletters();
  assert.equal(result.newsletters, 1);
  assert.equal(result.sent, 2, 'confirmed subscribers only — crew3 excluded');
  assert.equal(sentEmails.length, before + 2);

  const [m1, m2] = sentEmails.slice(-2);
  assert.notEqual(
    m1.html.match(/unsubscribe\?token=([A-Za-z0-9_-]+)/)[1],
    m2.html.match(/unsubscribe\?token=([A-Za-z0-9_-]+)/)[1],
    'each recipient gets their own unsubscribe token');

  const n = (await pool.query(`SELECT * FROM newsletters WHERE id=$1`, [nlId])).rows[0];
  assert.equal(n.status, 'sent');
  assert.equal(n.sent_count, 2);
  assert.equal(n.failed_count, 0);

  // Audit: one email_log row per recipient, tied to the newsletter id.
  const audit = await pool.query(
    `SELECT recipient, status FROM email_log WHERE kind='newsletter' AND ref_id=$1 ORDER BY recipient`, [nlId]);
  assert.deepEqual(audit.rows, [
    { recipient: 'crew1@example.com', status: 'sent' },
    { recipient: 'crew2@example.com', status: 'sent' },
  ]);

  // Sent newsletters are immutable.
  const edit = await j(`/api/admin/newsletters/${nlId}`, { method: 'PUT', headers: ROOT,
    body: JSON.stringify({ subject: 'rewrite history', body_md: '', charts: [] }) });
  assert.equal(edit.status, 409);
  assert.equal((await processNewsletters()).newsletters, 0, 'never sends twice');
});

test('partial provider failure: delivered mail audited sent, failure audited failed, counts split', async () => {
  await subscribeAndConfirm('crew4@example.com');
  const r = await j('/api/admin/newsletters', { method: 'POST', headers: ROOT,
    body: JSON.stringify({ subject: 'Edition 2', body_md: 'Short one.', charts: [] }) });
  await j(`/api/admin/newsletters/${r.body.id}/schedule`, { method: 'POST', headers: ROOT,
    body: JSON.stringify({ send_at: 'now' }) });

  failFor = 'crew2@example.com';
  const result = await processNewsletters();
  failFor = null;
  assert.equal(result.sent, 2, 'crew1 + crew4 delivered');

  const n = (await pool.query(`SELECT * FROM newsletters WHERE id=$1`, [r.body.id])).rows[0];
  assert.equal(n.status, 'sent');
  assert.equal(n.sent_count, 2);
  assert.equal(n.failed_count, 1);
  const failedRow = (await pool.query(
    `SELECT * FROM email_log WHERE kind='newsletter' AND ref_id=$1 AND status='failed'`, [r.body.id])).rows[0];
  assert.equal(failedRow.recipient, 'crew2@example.com');
});

test('newsletter unsubscribe removes a recipient from future sends', async () => {
  const anyNewsletterMail = sentEmails.findLast(m => m.to.includes('crew1@example.com') && m.html.includes('unsubscribe'));
  const t = anyNewsletterMail.html.match(/unsubscribe\?token=([A-Za-z0-9_-]+)/)[1];
  assert.equal((await fetch(base + `/api/subscribe/unsubscribe?token=${t}`)).status, 200);

  const r = await j('/api/admin/newsletters', { method: 'POST', headers: ROOT,
    body: JSON.stringify({ subject: 'Edition 3', body_md: 'x', charts: [] }) });
  await j(`/api/admin/newsletters/${r.body.id}/schedule`, { method: 'POST', headers: ROOT,
    body: JSON.stringify({ send_at: 'now' }) });
  const result = await processNewsletters();
  assert.equal(result.sent, 2, 'crew2 + crew4 only; crew1 is gone');
  const recipients = (await pool.query(
    `SELECT recipient FROM email_log WHERE kind='newsletter' AND ref_id=$1`, [r.body.id])).rows.map(x => x.recipient);
  assert.ok(!recipients.includes('crew1@example.com'));
});

test('scheduling and composing are admin-gated', async () => {
  for (const [method, path] of [
    ['POST', '/api/admin/newsletters'],
    ['GET', '/api/admin/newsletters'],
    ['POST', `/api/admin/newsletters/${nlId}/schedule`],
  ]) {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json' },
      body: method === 'POST' ? '{}' : undefined });
    assert.equal(r.status, 401, `${method} ${path} requires admin`);
  }
});
