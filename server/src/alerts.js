// Metric alerts: "email me when MVRV-Z crosses 5."
//
// Flow: POST /api/alerts (public, rate-limited) -> confirmation email via
// Resend (double opt-in) -> GET /api/alerts/confirm?token= activates.
// Every email carries a one-click GET /api/alerts/unsubscribe?token= link.
//
// Firing semantics: crossing detection on finalized daily data. An alert
// fires when the newest day satisfies the condition AND the previous day did
// not (or was null). It will not re-fire while the condition simply keeps
// holding — only on a fresh cross. checkAlerts() runs on an interval inside
// the API service.
import crypto from 'node:crypto';
import express from 'express';
import { pool } from './db.js';
import { bySlug } from './catalog.js';
import { config } from './config.js';
import { sendEmail, renderEmail, chartBlock } from './email.js';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest();
const token = () => crypto.randomBytes(24).toString('base64url');
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;

// ---------------------------------------------------------------------------
const describe = (a, m) =>
  `${m.name} ${a.condition === 'above' ? 'rises above' : 'falls below'} ${a.threshold}`;

// ---------------------------------------------------------------------------
export function alertsRouter(rateLimiter) {
  const r = express.Router();
  r.use(express.json());

  // Create (public, behind the shared rate limiter)
  r.post('/', rateLimiter, async (req, res) => {
    if (!config.alertSignupEnabled) {
      return res.status(403).json({ error: 'Alert signups are not open yet — follow @TNorth for the launch.' });
    }
    try {
      const email = String(req.body?.email ?? '').trim().toLowerCase();
      const slug = String(req.body?.slug ?? '');
      const condition = String(req.body?.condition ?? '');
      const threshold = Number(req.body?.threshold);
      const m = bySlug[slug];

      if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'valid email required' });
      if (!m || m.kind === 'stacked' || m.kind === 'multi' || m.kind === 'urpd') return res.status(400).json({ error: 'unknown or unsupported metric' });
      if (!['above', 'below'].includes(condition)) return res.status(400).json({ error: "condition must be 'above' or 'below'" });
      if (!Number.isFinite(threshold)) return res.status(400).json({ error: 'numeric threshold required' });

      const perAddress = await pool.query(
        `SELECT COUNT(*)::int c FROM alerts WHERE email = $1 AND unsubscribed_at IS NULL`, [email]);
      if (perAddress.rows[0].c >= 20) return res.status(429).json({ error: 'alert limit reached for this address' });

      const confirmT = token(), unsubT = token();
      await pool.query(
        `INSERT INTO alerts (email, metric_slug, condition, threshold, confirm_hash, unsub_token)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [email, slug, condition, threshold, sha256(confirmT), unsubT]);

      const apiOrigin = config.publicApiUrl || `${req.protocol}://${req.get('host')}`;
      const confirmUrl = `${apiOrigin}/api/alerts/confirm?token=${confirmT}`;
      await sendEmail({
        to: email,
        kind: 'alert_confirm',
        subject: `Confirm your Atlas alert: ${m.name}`,
        html: renderEmail({
          eyebrow: 'Confirm your alert',
          title: m.name,
          preheader: `One click and we'll watch ${m.name} for you.`,
          bodyHtml: `<p style="margin:0 0 18px;line-height:1.7;color:#c6d2e4">Confirm this alert and
            we'll email you when <strong>${describe({ condition, threshold }, m)}</strong> on
            finalized daily data. Didn't request this? Ignore this email and nothing will ever be sent.</p>`,
          cta: { label: 'Confirm alert', url: confirmUrl },
          unsubUrl: null,
        }),
      });

      res.status(201).json({ ok: true, message: 'Check your inbox to confirm the alert.' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  r.get('/confirm', async (req, res) => {
    const t = String(req.query.token ?? '');
    if (!t) return res.status(400).send('Missing token');
    const r2 = await pool.query(
      `UPDATE alerts SET confirmed_at = now()
       WHERE confirm_hash = $1 AND confirmed_at IS NULL AND unsubscribed_at IS NULL
       RETURNING metric_slug`, [sha256(t)]);
    if (!r2.rows.length) return res.status(404).send('Link invalid, expired, or already used.');
    res.redirect(`${config.publicSiteUrl}/#/m/${r2.rows[0].metric_slug}?alert=confirmed`);
  });

  r.get('/unsubscribe', async (req, res) => {
    const t = String(req.query.token ?? '');
    if (!t) return res.status(400).send('Missing token');
    const r2 = await pool.query(
      `UPDATE alerts SET unsubscribed_at = now()
       WHERE unsub_token = $1 AND unsubscribed_at IS NULL RETURNING id`, [t]);
    if (!r2.rows.length) return res.status(404).send('Link invalid or already unsubscribed.');
    res.send('You are unsubscribed from this alert. Fair winds.');
  });

  return r;
}

// ---------------------------------------------------------------------------
// Crossing detection over the two most recent finalized days, per metric.
export async function checkAlerts(log) {
  const active = await pool.query(
    `SELECT id, email, metric_slug, condition, threshold::float, unsub_token, last_fired_day::text
     FROM alerts WHERE confirmed_at IS NOT NULL AND unsubscribed_at IS NULL`);
  if (!active.rows.length) return { checked: 0, fired: 0 };

  const slugs = [...new Set(active.rows.map(a => a.metric_slug))];
  const latest = {};
  for (const slug of slugs) {
    const col = Array.isArray(bySlug[slug].column) ? bySlug[slug].column[0] : bySlug[slug].column;
    const r = await pool.query(
      `SELECT day::text AS d, ${col}::float AS v FROM metrics_daily
       WHERE ${col} IS NOT NULL ORDER BY day DESC LIMIT 2`);
    latest[slug] = r.rows; // [today, yesterday]
  }

  let fired = 0;
  for (const a of active.rows) {
    const rows = latest[a.metric_slug];
    if (!rows || rows.length === 0) continue;
    const [today, yesterday] = rows;
    const satisfies = (v) => (a.condition === 'above' ? v > a.threshold : v < a.threshold);
    const crossed = satisfies(today.v) && (yesterday === undefined || !satisfies(yesterday.v));
    if (!crossed) continue;
    if (a.last_fired_day === today.d) continue; // idempotent across checker runs

    const m = bySlug[a.metric_slug];
    try {
      const apiOrigin = config.publicApiUrl;
      // Stable token: the unsubscribe link in every email this alert ever
      // sends keeps working for the life of the alert.
      const unsubUrl = `${apiOrigin || config.publicSiteUrl}/api/alerts/unsubscribe?token=${a.unsub_token}`;
      await sendEmail({
        to: a.email,
        kind: 'alert_fire',
        refId: a.id,
        subject: `Atlas alert: ${describe(a, m)}`,
        html: renderEmail({
          eyebrow: 'Signal',
          title: `${m.name} crossed your threshold`,
          preheader: `${m.name} closed at ${today.v} on ${today.d}.`,
          bodyHtml: `<p style="margin:0 0 14px;line-height:1.7;color:#c6d2e4"><strong>${m.name}</strong>
            closed at <strong style="color:#4fe3a9">${today.v}</strong> on ${today.d} — crossing your
            ${a.condition} ${a.threshold} threshold.</p>
            ${chartBlock(m.slug, m.name)}
            <p style="margin:0 0 18px;color:#9db0c9;line-height:1.65">${m.short ?? ''}</p>`,
          cta: { label: 'Open the chart', url: `${config.publicSiteUrl}/#/m/${m.slug}` },
          unsubUrl,
        }),
      });
      await pool.query('UPDATE alerts SET last_fired_day = $1 WHERE id = $2', [today.d, a.id]);
      fired++;
    } catch (e) {
      log?.error?.({ err: e.message, alert: a.id }, 'alert send failed');
    }
  }
  return { checked: active.rows.length, fired };
}

export function startAlertChecker(log) {
  if (!config.resendApiKey) {
    log?.info?.('alerts: RESEND_API_KEY not set, checker disabled');
    return null;
  }
  const run = () => checkAlerts(log).then(
    r => r.fired && log?.info?.(r, 'alerts fired'),
    e => log?.error?.({ err: e.message }, 'alert check failed'));
  run();
  return setInterval(run, config.alertsCheckIntervalMs);
}
