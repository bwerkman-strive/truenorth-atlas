// Admin-editable metric copy: overrides layer over catalog defaults on
// /api/catalog, the admin list prefills with effective text, text saved
// identical to the default clears the override (so catalog.js edits show
// through), and the whole surface requires admin auth.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PGSSLMODE = 'disable';
process.env.ADMIN_TOKEN = 'test-admin-secret';

const { pool, migrate } = await import('../src/db.js');
const { METRICS, bySlug } = await import('../src/catalog.js');
const { app } = await import('../src/api.js');

let srv, base;
const H = { authorization: 'Bearer test-admin-secret', 'content-type': 'application/json' };
const MVRV = bySlug['mvrv'];

const j = async (path, opts) => {
  const res = await fetch(base + path, opts);
  return { status: res.status, body: await res.json() };
};
const catalogMetric = async (slug) => {
  const { body } = await j('/api/catalog');
  return body.metrics.find(m => m.slug === slug);
};

before(async () => {
  await migrate();
  await (await import('./guard.js')).assertScratchDb();
  await pool.query('TRUNCATE metric_copy');
  srv = app.listen(0);
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(async () => {
  await pool.query('TRUNCATE metric_copy'); // leave nothing for later suites
  srv.close();
  await pool.end();
});

test('the surface requires admin credentials', async () => {
  assert.equal((await j('/api/admin/metric-copy')).status, 401);
  assert.equal((await j('/api/admin/metric-copy/mvrv', {
    method: 'PUT', headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' },
    body: JSON.stringify({ explain: 'x', method: 'y' }),
  })).status, 401);
});

test('list covers every catalog metric, prefilled with the displayed text', async () => {
  const { status, body } = await j('/api/admin/metric-copy', { headers: H });
  assert.equal(status, 200);
  assert.equal(body.metrics.length, METRICS.length);
  const m = body.metrics.find(x => x.slug === 'mvrv');
  assert.equal(m.explain, MVRV.explain);
  assert.equal(m.method, MVRV.method);
  assert.equal(m.overridden, false);
});

test('an override lands on /api/catalog and the admin list', async () => {
  const put = await j('/api/admin/metric-copy/mvrv', {
    method: 'PUT', headers: H,
    body: JSON.stringify({ explain: 'Custom explain text.', method: 'Custom method text.' }),
  });
  assert.equal(put.status, 200);
  assert.equal(put.body.overridden, true);

  const cat = await catalogMetric('mvrv');
  assert.equal(cat.explain, 'Custom explain text.');
  assert.equal(cat.method, 'Custom method text.');

  const { body } = await j('/api/admin/metric-copy', { headers: H });
  const m = body.metrics.find(x => x.slug === 'mvrv');
  assert.equal(m.overridden, true);
  assert.equal(m.updated_by, 'root');
});

test('a pane saved with the default text falls back to the catalog', async () => {
  await j('/api/admin/metric-copy/mvrv', {
    method: 'PUT', headers: H,
    body: JSON.stringify({ explain: 'Only explain changed.', method: MVRV.method }),
  });
  // Stored as NULL so future catalog.js method edits still show through.
  const row = (await pool.query('SELECT explain_text, method_text FROM metric_copy WHERE slug=$1', ['mvrv'])).rows[0];
  assert.equal(row.explain_text, 'Only explain changed.');
  assert.equal(row.method_text, null);
  const cat = await catalogMetric('mvrv');
  assert.equal(cat.explain, 'Only explain changed.');
  assert.equal(cat.method, MVRV.method);
});

test('saving both panes as the defaults clears the override entirely', async () => {
  const put = await j('/api/admin/metric-copy/mvrv', {
    method: 'PUT', headers: H,
    body: JSON.stringify({ explain: MVRV.explain, method: MVRV.method }),
  });
  assert.equal(put.body.overridden, false);
  const rows = await pool.query('SELECT 1 FROM metric_copy WHERE slug=$1', ['mvrv']);
  assert.equal(rows.rows.length, 0);
});

test('reset restores the catalog defaults and returns them for the editor', async () => {
  await j('/api/admin/metric-copy/sopr', {
    method: 'PUT', headers: H,
    body: JSON.stringify({ explain: 'Edited.', method: 'Also edited.' }),
  });
  const del = await j('/api/admin/metric-copy/sopr', { method: 'DELETE', headers: H });
  assert.equal(del.status, 200);
  assert.equal(del.body.explain, bySlug['sopr'].explain);
  assert.equal(del.body.method, bySlug['sopr'].method);
  const cat = await catalogMetric('sopr');
  assert.equal(cat.explain, bySlug['sopr'].explain);
});

test('validation: unknown slug, empty text, oversized text', async () => {
  assert.equal((await j('/api/admin/metric-copy/not-a-metric', {
    method: 'PUT', headers: H, body: JSON.stringify({ explain: 'x', method: 'y' }),
  })).status, 404);
  assert.equal((await j('/api/admin/metric-copy/mvrv', {
    method: 'PUT', headers: H, body: JSON.stringify({ explain: '   ', method: 'y' }),
  })).status, 400);
  assert.equal((await j('/api/admin/metric-copy/mvrv', {
    method: 'PUT', headers: H, body: JSON.stringify({ explain: 'x', method: 'y'.repeat(4001) }),
  })).status, 400);
});
