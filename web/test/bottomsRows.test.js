import { test } from 'node:test';
import assert from 'node:assert/strict';
import { panelRows, windowTicks, dayLabel } from '../src/bottomsRows.js';

const v = (d, price, sma, sth, ath = false) => ({ d, day: `2018-0${1 + (d % 9)}-01`, price, sma, sth, ath });

test('panelRows splits the SMA/STH gap by sign into bear and bull ranges', () => {
  const rows = panelRows([v(-1, 100, 120, 90), v(0, 100, 80, 90), v(1, 100, 90, 90)], false);
  assert.deepEqual(rows[0].bear, [90, 120]);
  assert.equal(rows[0].bull, null);
  assert.equal(rows[1].bear, null);
  assert.deepEqual(rows[1].bull, [80, 90]);
  // Equal values count as "SMA above" so the band never has a hole at a touch.
  assert.deepEqual(rows[2].bear, [90, 90]);
});

test('panelRows leaves gaps where either input is missing and drops non-positives on log', () => {
  const rows = panelRows([v(0, 100, null, 90), v(1, 0, 50, 40), v(2, 100, 50, 40)], true);
  assert.equal(rows[0].bear, null);
  assert.equal(rows[0].bull, null);
  assert.equal(rows[0].sma, null);
  assert.equal(rows[1].price, null, 'zero close cannot be drawn on a log axis');
  assert.equal(rows[2].price, 100);
  // Linear keeps the zero.
  assert.equal(panelRows([v(1, 0, 50, 40)], false)[0].price, 0);
});

test('panelRows marks ATH days with the close and leaves every other day null', () => {
  const rows = panelRows([v(-3, 10, 1, 1, true), v(-2, 0, 1, 1, true), v(-1, 9, 1, 1, false), v(0, null, 1, 1, true)], false);
  assert.deepEqual(rows.map(r => r.ath), [10, null, null, null]);
});

test('windowTicks steps every 90 days from the low and includes both edges', () => {
  assert.deepEqual(windowTicks(365), [-365, -270, -180, -90, 0, 90, 180, 270, 365]);
  assert.deepEqual(windowTicks(180), [-180, -90, 0, 90, 180]);
});

test('dayLabel reads as a signed day count with the low named', () => {
  assert.equal(dayLabel(0), 'Day 0 (the low)');
  assert.equal(dayLabel(-120), 'Day −120');
  assert.equal(dayLabel(45), 'Day +45');
});
