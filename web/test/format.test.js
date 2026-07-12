import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmt, compact } from '../src/format.js';

test('null/undefined/NaN render as em-dash (pre-sync state)', () => {
  assert.equal(fmt(null, 'usd'), '—');
  assert.equal(fmt(undefined, 'ratio'), '—');
  assert.equal(fmt(NaN, 'percent'), '—');
});

test('usd: cents below $1,000, whole dollars above', () => {
  assert.equal(fmt(0.08, 'usd'), '$0.08');        // 2010-era prices must not round to $0
  assert.equal(fmt(999.5, 'usd'), '$999.50');
  assert.equal(fmt(64123.4, 'usd'), '$64,123');
});

test('usd_compact scales through K/M/B/T', () => {
  assert.equal(fmt(1_260_000_000_000, 'usd_compact'), '$1.26T'); // market cap
  assert.equal(fmt(650_000_000_000, 'usd_compact'), '$650.00B'); // realized cap
  assert.equal(fmt(2_500_000, 'usd_compact'), '$2.50M');
});

test('percent renders fraction as human percentage', () => {
  assert.equal(fmt(0.734, 'percent'), '73.4%');   // supply in profit
  assert.equal(fmt(0, 'percent'), '0.0%');
  assert.equal(fmt(1, 'percent'), '100.0%');
});

test('ratio: two decimals in normal range, whole numbers when large', () => {
  assert.equal(fmt(2.4567, 'ratio'), '2.46');     // MVRV
  assert.equal(fmt(-0.25, 'ratio'), '-0.25');     // NUPL capitulation
  assert.equal(fmt(150.4, 'ratio'), '150');       // large NVT-style values
});

test('number appends unit', () => {
  assert.equal(fmt(912.3, 'number', 'EH/s'), '912 EH/s');
  assert.equal(fmt(645_000, 'number', 'BTC'), '645.0K BTC');
});

test('compact edge behavior', () => {
  assert.equal(compact(9.87), '9.87');
  assert.equal(compact(42), '42');
  assert.equal(compact(-3_200_000), '-3.20M');
  assert.equal(compact(999), '999');
  assert.equal(compact(1000), '1.0K');
});
