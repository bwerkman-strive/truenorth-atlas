// Newsletters + subscriber list + email audit surface.
//
// Public (rate-limited):
//   POST /api/subscribe {email}          double-opt-in signup
//   GET  /api/subscribe/confirm?token=
//   GET  /api/subscribe/unsubscribe?token=
//
// Admin (root or any named admin — this is the employee workflow):
//   POST   /api/admin/newsletters                 create draft {subject, preheader?, body_md, charts[]}
//   GET    /api/admin/newsletters                 list with stats
//   GET    /api/admin/newsletters/:id             full draft
//   PUT    /api/admin/newsletters/:id             edit (draft/scheduled only)
//   POST   /api/admin/newsletters/:id/test        send a test to one address
//   POST   /api/admin/newsletters/:id/schedule    {send_at: ISO | "now"}
//   POST   /api/admin/newsletters/:id/cancel      scheduled -> draft
//   GET    /api/admin/email-log?kind=&limit=      the full audit trail
//
// processNewsletters() runs on the API's checker interval: any newsletter
// whose scheduled_at has passed is sent to every confirmed subscriber, one
// audited email at a time, with a per-recipient unsubscribe link.
import crypto from 'node:crypto';
import express from 'express';
import { pool } from './db.js';
import { bySlug } from './catalog.js';
import { config } from './config.js';
import { sendEmail, renderEmail, mdLite, chartBlock } from './email.js';
import { adminAuth } from './keys.js';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest();
const token = () => crypto.randomBytes(24).toString('base64url');
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;

// ---------------------------------------------------------------------------
export function subscribeRouter(rateLimiter) {
  const r = express.Router();
  r.use(express.json());

  r.post('/', rateLimiter, async (req, res) => {
    if (!config.newsletterSignupEnabled) {
      return res.status(403).json({ error: 'Newsletter signups are not open yet — follow @TNorth for the launch.' });
    }
    try {
      const email = String(req.body?.email ?? '').trim().toLowerCase();
      if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'valid email required' });

      const existing = await pool.query(
        `SELECT id, confirmed_at FROM subscribers WHERE email = $1 AND unsubscribed_at IS NULL`, [email]);
      if (existing.rows[0]?.confirmed_at) {
        return res.json({ ok: true, message: 'You are already on course — this address is subscribed.' });
      }

      const confirmT = token();
      if (existing.rows.length) {
        await pool.query(`UPDATE subscribers SET confirm_hash = $1 WHERE id = $2`,
          [sha256(confirmT), existing.rows[0].id]);
      } else {
        await pool.query(
          `INSERT INTO subscribers (email, confirm_hash, unsub_token) VALUES ($1,$2,$3)`,
          [email, sha256(confirmT), token()]);
      }

      const apiOrigin = config.publicApiUrl || `${req.protocol}://${req.get('host')}`;
      await sendEmail({
        to: email,
        kind: 'subscribe_confirm',
        subject: 'Confirm your Atlas subscription',
        html: renderEmail({
          eyebrow: 'Stay on course',
          title: 'Confirm your subscription',
          preheader: 'One click and the signal starts arriving.',
          bodyHtml: `<p style="margin:0 0 18px;line-height:1.7;color:#c6d2e4">Confirm and you'll
            receive the Atlas newsletter — chart-driven reads on where the Bitcoin ledger stands,
            straight from a fully-validating node. No spam, unsubscribe any time.</p>`,
          cta: { label: 'Confirm subscription', url: `${apiOrigin}/api/subscribe/confirm?token=${confirmT}` },
          unsubUrl: null,
        }),
      });
      res.status(201).json({ ok: true, message: 'Check your inbox to confirm.' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  r.get('/confirm', async (req, res) => {
    const t = String(req.query.token ?? '');
    const r2 = await pool.query(
      `UPDATE subscribers SET confirmed_at = now()
       WHERE confirm_hash = $1 AND confirmed_at IS NULL AND unsubscribed_at IS NULL RETURNING id`,
      [sha256(t)]);
    if (!r2.rows.length) return res.status(404).send('Link invalid, expired, or already used.');
    res.redirect(`${config.publicSiteUrl}/#/?subscribed=1`);
  });

  r.get('/unsubscribe', async (req, res) => {
    const t = String(req.query.token ?? '');
    const r2 = await pool.query(
      `UPDATE subscribers SET unsubscribed_at = now()
       WHERE unsub_token = $1 AND unsubscribed_at IS NULL RETURNING id`, [t]);
    if (!r2.rows.length) return res.status(404).send('Link invalid or already unsubscribed.');
    res.send('You are unsubscribed. Fair winds.');
  });

  return r;
}

// ---------------------------------------------------------------------------
function validateCharts(charts) {
  if (!Array.isArray(charts)) return 'charts must be an array of metric slugs';
  if (charts.length > 8) return 'at most 8 charts per newsletter';
  for (const s of charts) {
    const m = bySlug[s];
    if (!m || m.kind === 'stacked') return `unknown or unsupported chart: ${s}`;
  }
  return null;
}

function renderNewsletter(n, unsubUrl) {
  const chartsHtml = (n.charts ?? [])
    .map(slug => chartBlock(slug, bySlug[slug]?.name ?? slug)).join('');
  return renderEmail({
    eyebrow: 'The Signal · True North Atlas',
    title: n.subject,
    preheader: n.preheader || undefined,
    bodyHtml: mdLite(n.body_md) + chartsHtml,
    cta: { label: 'Open Atlas', url: config.publicSiteUrl },
    unsubUrl,
  });
}

export function newslettersAdminRouter() {
  const r = express.Router();
  r.use(express.json());
  r.use(adminAuth);

  r.post('/', async (req, res) => {
    const subject = String(req.body?.subject ?? '').trim();
    const preheader = String(req.body?.preheader ?? '').trim() || null;
    const bodyMd = String(req.body?.body_md ?? '');
    const charts = req.body?.charts ?? [];
    if (!subject || subject.length > 200) return res.status(400).json({ error: 'subject required (≤200 chars)' });
    const chartErr = validateCharts(charts);
    if (chartErr) return res.status(400).json({ error: chartErr });
    const ins = await pool.query(
      `INSERT INTO newsletters (subject, preheader, body_md, charts, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, status, created_at`,
      [subject, preheader, bodyMd, charts, req.admin.name]);
    res.status(201).json({ id: ins.rows[0].id, status: 'draft' });
  });

  r.get('/', async (_req, res) => {
    const r2 = await pool.query(
      `SELECT id, subject, status, charts, created_by, created_at, scheduled_at, sent_at,
              sent_count, failed_count
       FROM newsletters ORDER BY id DESC LIMIT 100`);
    const subs = await pool.query(
      `SELECT COUNT(*)::int c FROM subscribers WHERE confirmed_at IS NOT NULL AND unsubscribed_at IS NULL`);
    res.json({ newsletters: r2.rows, confirmedSubscribers: subs.rows[0].c });
  });

  r.get('/:id', async (req, res) => {
    const r2 = await pool.query(`SELECT * FROM newsletters WHERE id = $1`, [req.params.id]);
    if (!r2.rows.length) return res.status(404).json({ error: 'not found' });
    res.json(r2.rows[0]);
  });

  r.put('/:id', async (req, res) => {
    const subject = String(req.body?.subject ?? '').trim();
    const preheader = String(req.body?.preheader ?? '').trim() || null;
    const bodyMd = String(req.body?.body_md ?? '');
    const charts = req.body?.charts ?? [];
    if (!subject || subject.length > 200) return res.status(400).json({ error: 'subject required (≤200 chars)' });
    const chartErr = validateCharts(charts);
    if (chartErr) return res.status(400).json({ error: chartErr });
    const r2 = await pool.query(
      `UPDATE newsletters SET subject=$1, preheader=$2, body_md=$3, charts=$4
       WHERE id=$5 AND status IN ('draft','scheduled') RETURNING id`,
      [subject, preheader, bodyMd, charts, req.params.id]);
    if (!r2.rows.length) return res.status(409).json({ error: 'not editable (already sending or sent)' });
    res.json({ ok: true });
  });

  r.post('/:id/test', async (req, res) => {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'valid email required' });
    const r2 = await pool.query(`SELECT * FROM newsletters WHERE id = $1`, [req.params.id]);
    if (!r2.rows.length) return res.status(404).json({ error: 'not found' });
    const n = r2.rows[0];
    try {
      await sendEmail({
        to: email,
        kind: 'newsletter_test',
        refId: n.id,
        subject: `[TEST] ${n.subject}`,
        html: renderNewsletter(n, null),
      });
      res.json({ ok: true, message: `Test sent to ${email}` });
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  r.post('/:id/schedule', async (req, res) => {
    const raw = req.body?.send_at;
    const when = raw === 'now' ? new Date() : new Date(String(raw ?? ''));
    if (Number.isNaN(when.getTime())) return res.status(400).json({ error: 'send_at must be an ISO datetime or "now"' });
    if (raw !== 'now' && when.getTime() < Date.now() - 60_000) {
      return res.status(400).json({ error: 'send_at is in the past' });
    }
    const r2 = await pool.query(
      `UPDATE newsletters SET status='scheduled', scheduled_at=$1
       WHERE id=$2 AND status IN ('draft','scheduled') RETURNING id`,
      [when.toISOString(), req.params.id]);
    if (!r2.rows.length) return res.status(409).json({ error: 'not schedulable (already sending or sent)' });
    res.json({ ok: true, scheduled_at: when.toISOString() });
  });

  r.post('/:id/cancel', async (req, res) => {
    const r2 = await pool.query(
      `UPDATE newsletters SET status='draft', scheduled_at=NULL
       WHERE id=$1 AND status='scheduled' RETURNING id`, [req.params.id]);
    if (!r2.rows.length) return res.status(409).json({ error: 'only scheduled newsletters can be canceled' });
    res.json({ ok: true });
  });

  return r;
}

export function emailLogRouter() {
  const r = express.Router();
  r.use(adminAuth);
  r.get('/', async (req, res) => {
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit ?? '200', 10) || 200));
    const kind = typeof req.query.kind === 'string' && /^[a-z_]+$/.test(req.query.kind) ? req.query.kind : null;
    const r2 = kind
      ? await pool.query(`SELECT * FROM email_log WHERE kind=$1 ORDER BY id DESC LIMIT $2`, [kind, limit])
      : await pool.query(`SELECT * FROM email_log ORDER BY id DESC LIMIT $1`, [limit]);
    const stats = await pool.query(
      `SELECT kind, status, COUNT(*)::int c FROM email_log GROUP BY kind, status ORDER BY kind`);
    res.json({ entries: r2.rows, stats: stats.rows });
  });
  return r;
}

// ---------------------------------------------------------------------------
export async function processNewsletters(log) {
  const due = await pool.query(
    `UPDATE newsletters SET status='sending'
     WHERE status='scheduled' AND scheduled_at <= now()
     RETURNING *`);
  let totalSent = 0;
  for (const n of due.rows) {
    const subs = await pool.query(
      `SELECT email, unsub_token FROM subscribers
       WHERE confirmed_at IS NOT NULL AND unsubscribed_at IS NULL ORDER BY id`);
    let sent = 0, failed = 0;
    for (const s of subs.rows) {
      const apiOrigin = config.publicApiUrl || config.publicSiteUrl;
      const unsubUrl = `${apiOrigin}/api/subscribe/unsubscribe?token=${s.unsub_token}`;
      try {
        await sendEmail({
          to: s.email, kind: 'newsletter', refId: n.id,
          subject: n.subject, html: renderNewsletter(n, unsubUrl),
        });
        sent++;
      } catch (e) {
        failed++; // already logged as failed by sendEmail
        log?.error?.({ err: e.message, newsletter: n.id, to: s.email }, 'newsletter send failed');
      }
      await new Promise(r => setTimeout(r, 60)); // stay well under provider rate limits
    }
    await pool.query(
      `UPDATE newsletters SET status='sent', sent_at=now(), sent_count=$1, failed_count=$2 WHERE id=$3`,
      [sent, failed, n.id]);
    totalSent += sent;
    log?.info?.({ newsletter: n.id, sent, failed }, 'newsletter dispatched');
  }
  return { newsletters: due.rows.length, sent: totalSent };
}
