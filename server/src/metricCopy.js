// Admin-editable metric copy.
//
// The catalog (catalog.js) remains the single source of truth for metric
// defaults; this table stores per-slug overrides for the two prose panes on
// the metric detail page: "What it tells you" (explain) and "How it's
// computed" (method). /api/catalog merges overrides over the defaults, so
// every consumer of catalog copy follows automatically.
//
// A NULL column means "use the catalog default". Text saved identical to the
// default is stored as NULL so later catalog.js copy edits are not silently
// masked, and a row with both columns NULL is deleted outright.
import express from 'express';
import { pool } from './db.js';
import { METRICS, bySlug } from './catalog.js';
import { adminAuth } from './keys.js';

const MAX_COPY_LEN = 4000;

// slug -> { explain, method } (values may be null = no override for that pane)
export async function getCopyOverrides() {
  const r = await pool.query('SELECT slug, explain_text, method_text FROM metric_copy');
  const map = {};
  for (const row of r.rows) map[row.slug] = { explain: row.explain_text, method: row.method_text };
  return map;
}

export function metricCopyAdminRouter() {
  const r = express.Router();
  r.use(express.json());
  r.use(adminAuth);

  // Every metric with its effective copy (override when present, catalog
  // default otherwise); the admin panel prefills its editor straight from this.
  r.get('/', async (_req, res) => {
    try {
      const rows = await pool.query(
        'SELECT slug, explain_text, method_text, updated_by, updated_at FROM metric_copy');
      const overrides = Object.fromEntries(rows.rows.map(x => [x.slug, x]));
      res.json({
        metrics: METRICS.map(m => {
          const o = overrides[m.slug];
          return {
            slug: m.slug, name: m.name, category: m.category,
            explain: o?.explain_text ?? m.explain,
            method: o?.method_text ?? m.method,
            overridden: !!o,
            updated_by: o?.updated_by ?? null,
            updated_at: o?.updated_at ?? null,
          };
        }),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  r.put('/:slug', async (req, res) => {
    const m = bySlug[req.params.slug];
    if (!m) return res.status(404).json({ error: 'unknown metric' });
    const clean = (v, label) => {
      if (typeof v !== 'string' || !v.trim()) throw new Error(`${label} text required`);
      if (v.length > MAX_COPY_LEN) throw new Error(`${label} text too long (max ${MAX_COPY_LEN} chars)`);
      return v.trim();
    };
    let explain, method;
    try {
      explain = clean(req.body?.explain, 'explain');
      method = clean(req.body?.method, 'method');
    } catch (e) { return res.status(400).json({ error: e.message }); }
    const ex = explain === m.explain ? null : explain;
    const me = method === m.method ? null : method;
    try {
      if (ex === null && me === null) {
        await pool.query('DELETE FROM metric_copy WHERE slug = $1', [m.slug]);
      } else {
        await pool.query(
          `INSERT INTO metric_copy (slug, explain_text, method_text, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, now())
           ON CONFLICT (slug) DO UPDATE
             SET explain_text = EXCLUDED.explain_text, method_text = EXCLUDED.method_text,
                 updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [m.slug, ex, me, req.admin.name]);
      }
      res.json({ slug: m.slug, explain, method, overridden: !(ex === null && me === null) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Reset both panes to the catalog defaults (returned so the editor can refill).
  r.delete('/:slug', async (req, res) => {
    const m = bySlug[req.params.slug];
    if (!m) return res.status(404).json({ error: 'unknown metric' });
    try {
      await pool.query('DELETE FROM metric_copy WHERE slug = $1', [m.slug]);
      res.json({ slug: m.slug, explain: m.explain, method: m.method, overridden: false });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return r;
}
