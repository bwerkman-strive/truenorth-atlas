// The platform's single email path.
//
//   sendEmail() — the ONLY function that talks to Resend. Every send, success
//   or failure, is written to email_log with the provider's message id, so the
//   audit trail is complete by construction.
//
//   renderEmail() — the standard Atlas email format: ink card on ink, the
//   TRUE NORTH ATLAS lockup over an orange bar, generous type, a single
//   bone-pill CTA, and a compliance footer. Built from table-based HTML with inline
//   styles (the only thing mail clients reliably render); charts arrive as
//   hosted OG-card images so every email inherits the site's branding and
//   watermark for free.
//
//   mdLite() — the newsletter body language: paragraphs, ## headings, **bold**,
//   *italic*, [links](https://…), and "- " bullet lists. Input is HTML-escaped
//   first; authors cannot inject markup.
import { pool } from './db.js';
import { config } from './config.js';

// Strive brand system: ink surfaces, bone text/CTAs, slate secondary,
// hairlines, orange as the single reserved accent (eyebrows, links, the
// wordmark's one orange touch).
const INK = '#0b0c0e', PANEL = '#0f1013', LINE = '#333230';
const ORANGE = '#f7931a', BONE = '#f2ede3', BODY = '#d5cfc1', SLATE = '#918b7d', TEXT = '#f2ede3';

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------------------------------------------------------------------------
export function mdLite(md) {
  const inline = (s) => s
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      `<a href="$2" style="color:${ORANGE};text-decoration:none">$1</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');

  const blocks = esc(md).replace(/\r\n/g, '\n').split(/\n{2,}/);
  return blocks.map(b => {
    const lines = b.split('\n').filter(l => l.trim() !== '');
    if (!lines.length) return '';
    if (lines[0].startsWith('## ')) {
      return `<h2 style="font-size:20px;margin:26px 0 10px;color:${TEXT}">${inline(lines[0].slice(3))}</h2>`
        + (lines.length > 1 ? `<p style="margin:0 0 16px;line-height:1.7;color:${BODY}">${lines.slice(1).map(inline).join('<br>')}</p>` : '');
    }
    if (lines.every(l => l.startsWith('- '))) {
      return `<ul style="margin:0 0 16px;padding-left:22px;color:${BODY};line-height:1.7">`
        + lines.map(l => `<li style="margin:4px 0">${inline(l.slice(2))}</li>`).join('') + '</ul>';
    }
    return `<p style="margin:0 0 16px;line-height:1.7;color:${BODY}">${lines.map(inline).join('<br>')}</p>`;
  }).join('');
}

// ---------------------------------------------------------------------------
export function chartBlock(slug, name) {
  const api = config.publicApiUrl || config.publicSiteUrl;
  const img = `${api}/og/${slug}.png`;
  const link = `${config.publicSiteUrl}/#/m/${slug}`;
  return `<a href="${esc(link)}" style="display:block;margin:0 0 18px;text-decoration:none">
    <img src="${esc(img)}" width="536" alt="${esc(name)} — True North Atlas chart"
      style="display:block;width:100%;max-width:536px;border:1px solid ${LINE};border-radius:12px"/>
  </a>`;
}

export function renderEmail({ eyebrow, title, bodyHtml, cta, unsubUrl, preheader }) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:${INK}">
${preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader)}</div>` : ''}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${INK}">
<tr><td align="center" style="padding:40px 14px">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0"
    style="max-width:600px;width:100%;background:${PANEL};border:1px solid ${LINE};border-radius:16px">
    <tr><td style="padding:30px 32px 0;font-family:Helvetica,Arial,sans-serif">
      <div style="font-weight:700;font-size:17px;letter-spacing:.12em;color:${TEXT}">
        TRUE NORTH <span style="color:${ORANGE}">ATLAS</span></div>
      <div style="height:3px;width:64px;margin:12px 0 0;border-radius:2px;
        background:${ORANGE};font-size:0">&nbsp;</div>
    </td></tr>
    <tr><td style="padding:26px 32px 6px;font-family:Helvetica,Arial,sans-serif">
      ${eyebrow ? `<div style="font-size:11px;font-weight:700;letter-spacing:.16em;color:${ORANGE};text-transform:uppercase;margin:0 0 8px">${esc(eyebrow)}</div>` : ''}
      ${title ? `<h1 style="margin:0 0 16px;font-size:25px;line-height:1.3;color:${TEXT}">${esc(title)}</h1>` : ''}
      ${bodyHtml}
      ${cta ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 10px"><tr><td
        style="background:${BONE};border-radius:999px">
        <a href="${esc(cta.url)}" style="display:inline-block;padding:13px 26px;font-family:Helvetica,Arial,sans-serif;
        font-weight:700;font-size:14px;letter-spacing:.04em;color:${INK};text-decoration:none">${esc(cta.label)}</a></td></tr></table>` : ''}
    </td></tr>
    <tr><td style="padding:10px 32px 28px;font-family:Helvetica,Arial,sans-serif">
      <div style="border-top:1px solid ${LINE};padding-top:16px;color:${SLATE};font-size:12px;line-height:1.65">
        True North Atlas — Navigating the Bitcoin Ledger ·
        <a href="${esc(config.publicSiteUrl)}" style="color:${SLATE}">${esc(config.publicSiteUrl.replace(/^https?:\/\//, ''))}</a><br>
        For informational and educational purposes only — nothing here is investment advice or an
        offer of any security.${unsubUrl ? ` <a href="${esc(unsubUrl)}" style="color:${SLATE}">Unsubscribe</a>.` : ''}
      </div>
    </td></tr>
  </table>
  <div style="font-family:Helvetica,Arial,sans-serif;color:#6a655a;font-size:11px;padding:16px">
    A True North Media Network property · Powered by Strive</div>
</td></tr></table>
</body></html>`;
}

// ---------------------------------------------------------------------------
// The one and only sender. Logs every attempt to email_log.
export async function sendEmail({ to, subject, html, kind, refId = null }) {
  if (!config.resendApiKey) throw new Error('RESEND_API_KEY not configured');
  let status = 'sent', providerId = null, error = null;
  try {
    const res = await fetch(`${config.resendBaseUrl}/emails`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.resendApiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ from: config.alertsFromEmail, to: [to], subject, html }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Resend ${res.status}: ${body.slice(0, 300)}`);
    }
    providerId = (await res.json()).id ?? null;
  } catch (e) {
    status = 'failed';
    error = e.message;
  }
  await pool.query(
    `INSERT INTO email_log (recipient, subject, kind, ref_id, status, provider_id, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [to, subject, kind, refId, status, providerId, error]);
  if (status === 'failed') throw new Error(error);
  return providerId;
}
