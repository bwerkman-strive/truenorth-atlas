import { test } from 'node:test';
import assert from 'node:assert/strict';
import { smaByDay } from '../src/sma.js';

const day = (i) => `2024-01-${String(i).padStart(2, '0')}`;
const rows = (vals) => vals.map((v, i) => ({ day: day(i + 1), price: v }));

test('emits nothing until a full window is available, then the rolling mean', () => {
  const m = smaByDay(rows([1, 2, 3, 4, 5]), 'price', 3);
  assert.equal(m.has(day(1)), false);
  assert.equal(m.has(day(2)), false);
  assert.equal(m.get(day(3)), 2);
  assert.equal(m.get(day(4)), 3);
  assert.equal(m.get(day(5)), 4);
});

test('coerces the API string serialization of numeric columns', () => {
  const m = smaByDay(rows(['10.5', '11.5', '12.5']), 'price', 2);
  assert.equal(m.get(day(2)), 11);
  assert.equal(m.get(day(3)), 12);
});

test('a non-numeric gap restarts the window rather than averaging around it', () => {
  const m = smaByDay(rows([1, 2, null, 4, 6]), 'price', 2);
  assert.equal(m.get(day(2)), 1.5);
  assert.equal(m.has(day(3)), false); // gap
  assert.equal(m.has(day(4)), false); // window restarted, not yet full
  assert.equal(m.get(day(5)), 5);
});

test('zeros are values, not gaps (pre-market days)', () => {
  const m = smaByDay(rows([0, 0, 3]), 'price', 3);
  assert.equal(m.get(day(3)), 1);
});

test('degenerate windows produce nothing', () => {
  assert.equal(smaByDay(rows([1, 2, 3]), 'price', 0).size, 0);
  assert.equal(smaByDay(rows([1, 2, 3]), 'price', -1).size, 0);
  assert.equal(smaByDay(rows([1, 2, 3]), 'price', 2.5).size, 0);
});

test('a 200-week window over daily data needs 1400 daily rows', () => {
  const many = Array.from({ length: 1400 }, (_, i) => ({ day: `d${i}`, price: 2 }));
  const m = smaByDay(many, 'price', 1400);
  assert.equal(m.size, 1);
  assert.equal(m.get('d1399'), 2);
});
