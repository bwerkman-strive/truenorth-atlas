// The catalog drives both the API's SQL (column names) and the UI. A typo in
// a column name would 500 at runtime, so we statically verify every metric
// against the actual schema.sql.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CATEGORIES, METRICS, bySlug } from '../src/catalog.js';

const schema = readFileSync(fileURLToPath(new URL('../src/schema.sql', import.meta.url)), 'utf8');

// Pull the column names out of the metrics_daily CREATE TABLE block.
function metricsDailyColumns() {
  const m = schema.match(/CREATE TABLE IF NOT EXISTS metrics_daily \(([\s\S]*?)\n\);/);
  assert.ok(m, 'metrics_daily table found in schema.sql');
  return new Set(
    m[1].split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('--') && !/^(PRIMARY|UNIQUE|CHECK|FOREIGN)/i.test(l))
      .map(l => l.split(/\s+/)[0].replace(/,$/, ''))
  );
}

const cols = metricsDailyColumns();
const catIds = new Set(CATEGORIES.map(c => c.id));
const VALID_FORMATS = new Set(['usd', 'usd_compact', 'percent', 'ratio', 'number', 'stacked_pct']);

test('every metric column exists in metrics_daily', () => {
  for (const m of METRICS) {
    for (const c of [].concat(m.column)) {
      assert.ok(cols.has(c), `metric "${m.slug}" references missing column "${c}"`);
    }
    for (const c of (m.columns ?? [])) {
      assert.ok(cols.has(c), `metric "${m.slug}" multi-series references missing column "${c}"`);
    }
  }
});

test('slugs are unique and URL-safe', () => {
  const seen = new Set();
  for (const m of METRICS) {
    assert.match(m.slug, /^[a-z0-9-]+$/, `slug "${m.slug}" not URL-safe`);
    assert.ok(!seen.has(m.slug), `duplicate slug "${m.slug}"`);
    seen.add(m.slug);
  }
});

test('every metric belongs to a declared category', () => {
  for (const m of METRICS) {
    assert.ok(catIds.has(m.category), `metric "${m.slug}" has unknown category "${m.category}"`);
  }
});

test('every metric has a valid format and complete copy', () => {
  for (const m of METRICS) {
    assert.ok(VALID_FORMATS.has(m.format), `metric "${m.slug}" has invalid format "${m.format}"`);
    assert.ok(m.name?.length > 2, `metric "${m.slug}" missing name`);
    assert.ok(m.short?.length > 20, `metric "${m.slug}" needs a one-line summary`);
    assert.ok(m.explain?.length > 80, `metric "${m.slug}" needs a real explanation`);
    assert.ok(m.method?.length > 15, `metric "${m.slug}" needs a methodology note`);
  }
});

test('zone bands are well-formed', () => {
  for (const m of METRICS) {
    for (const z of m.zones ?? []) {
      assert.ok(['hot', 'warm', 'cold', 'line'].includes(z.tone), `metric "${m.slug}" zone tone "${z.tone}"`);
      if (z.tone !== 'line') {
        assert.ok(typeof z.from === 'number' && typeof z.to === 'number' && z.from < z.to,
          `metric "${m.slug}" zone range invalid`);
      }
    }
  }
});

test('bySlug index matches the metric list', () => {
  for (const m of METRICS) assert.equal(bySlug[m.slug], m);
});

test('checkonchain coverage: the canonical metric families are all present', () => {
  const required = [
    'price', 'realized-price', 'mvrv', 'mvrv-z', 'mayer-multiple', 'nupl', 'sopr', 'asopr',
    'sth-sopr', 'lth-sopr', 'cdd', 'liveliness', 'reserve-risk', 'hodl-waves',
    'rc-hodl-waves', 'puell-multiple', 'hashrate', 'nvt', 'transfer-volume',
  ];
  for (const slug of required) {
    assert.ok(bySlug[slug], `expected core metric "${slug}" in catalog`);
  }
});
