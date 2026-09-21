// Pure-function coverage for sprint 2: the cost-basis heatmap re-binning and
// the cycle clock's rings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logLevels, rebin, topClusters, buildHeatmap } from '../src/heatmap.js';
import { buildClock, BLOCKS_PER_EPOCH } from '../src/clock.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

test('logLevels: geometric edges from min to max', () => {
  const lv = logLevels(1, 1000, 3);
  assert.equal(lv.length, 4);
  assert.ok(near(lv[0], 1) && near(lv[1], 10) && near(lv[2], 100) && near(lv[3], 1000));
});

test('rebin spreads a bucket across rows by linear overlap and sends the zero bucket to the floor', () => {
  const levels = [1, 10, 100, 1000];
  // Bucket [50, 150) with 100 BTC: half its width lies in [10,100), half in [100,1000).
  const { cells, floor, width } = rebin({ width: 100, buckets: [{ p: 50, v: 100 }, { p: 0, v: 7 }] }, levels);
  assert.equal(width, 100);
  assert.equal(floor, 7);
  assert.ok(near(cells[0], 0));
  assert.ok(near(cells[1], 50));
  assert.ok(near(cells[2], 50));
  // A bucket entirely inside one row lands whole; one past the top edge is clipped.
  const r2 = rebin({ width: 5, buckets: [{ p: 20, v: 10 }, { p: 998, v: 10 }] }, levels);
  assert.ok(near(r2.cells[1], 10));
  assert.ok(near(r2.cells[2], 4), 'only [998,1000) of [998,1003) overlaps the grid');
  // Numeric strings (JSONB numbers arrive as numbers, but be safe) and empties.
  const r3 = rebin({ width: '10', buckets: [{ p: '15', v: '3' }] }, levels);
  assert.ok(near(r3.cells[1], 3));
  assert.deepEqual(rebin(null, levels).cells, [0, 0, 0]);
});

test('topClusters merges adjacent dense rows and ranks by supply', () => {
  const levels = [1, 2, 4, 8, 16, 32, 64];
  const cells = [1, 90, 100, 5, 60, 55];
  const cl = topClusters(cells, levels, { k: 2, share: 0.5 });
  assert.deepEqual(topClusters(cells, levels), [{ from: 2, to: 8, btc: 190 }], 'the default 70% share keeps only the peak band');
  assert.deepEqual(cl, [
    { from: 2, to: 8, btc: 190 },
    { from: 16, to: 64, btc: 115 },
  ]);
  assert.deepEqual(topClusters([0, 0], levels), []);
});

test('buildHeatmap: one column per sampled day on a shared grid, with the latest column summarised', () => {
  const rows = [
    { day: '2024-01-07', price: 100, supply_profit_pct: 0.5, urpd: { top: 120, width: 1.2, buckets: [{ p: 0, v: 50 }, { p: 96, v: 300 }, { p: 60, v: 40 }] } },
    { day: '2024-01-14', price: 130, supply_profit_pct: 0.9, urpd: { top: 130, width: 1.3, buckets: [{ p: 0, v: 50 }, { p: 96.2, v: 300 }, { p: 126.1, v: 500 }] } },
    { day: '2024-01-21', price: null, urpd: { top: 130, width: 1.3, buckets: [] } },
  ];
  const out = buildHeatmap(rows, { rows: 40, minPrice: 1 });
  assert.equal(out.slug, 'cost-basis-heatmap');
  assert.equal(out.levels.length, 41);
  assert.ok(near(out.levels[0], 1) && near(out.levels[40], 130 * 1.1, 1e-3));
  assert.equal(out.columns.length, 2, 'the unpriced day is skipped');
  const c0 = out.columns[0];
  assert.deepEqual(Object.keys(c0).sort(), ['cells', 'day', 'floor', 'price', 'width']);
  assert.equal(c0.floor, 50);
  assert.equal(c0.cells.length, 40);
  assert.equal(c0.cells.reduce((s, v) => s + v, 0), 340, 'all priced supply lands on the grid');
  // The 500-BTC bucket straddles a grid edge, so the peak cell holds most,
  // not all, of it; the column still sums to the whole supply.
  assert.ok(out.maxCell > 400 && out.maxCell <= 500);
  assert.equal(out.columns[1].cells.reduce((s, v) => s + v, 0), 800);
  assert.equal(out.latest.day, '2024-01-14');
  assert.equal(out.latest.price, 130);
  assert.equal(out.latest.inProfit, 0.9);
  assert.ok(out.latest.clusters[0].btc > 400);
  assert.equal(out.latest.clusters[0].position, 'straddling the close', 'the dense row runs from 126 past the 130 close to the grid top');
  assert.equal(buildHeatmap([]).latest, null);
});

// Two epochs of daily rows: epoch 3 (1380 days) with a peak at day 600 and a
// low at day 900; epoch 4 open, 700 days in.
const E3 = '2016-07-09', E4 = '2020-04-19';
const dayAt = (start, i) => new Date(Date.parse(start) + i * 86400e3).toISOString().slice(0, 10);
function synthetic() {
  const rows = [];
  const total = 1380 + 700;
  for (let i = 0; i < total; i++) {
    let price;
    if (i <= 600) price = 600 + (20000 - 600) * (i / 600);
    else if (i <= 900) price = 20000 - 17000 * ((i - 600) / 300);
    else price = 3000 + 7000 * ((i - 900) / 1180);
    rows.push({ day: dayAt(E3, i), price, mvrv: i < 10 ? null : price / 5000 });
  }
  return rows;
}
const HALVINGS = [{ epoch: 3, start: E3 }, { epoch: 4, start: E4 }];

test('buildClock: closed rings map days to their actual length; the open ring projects from block progress', () => {
  const tip = 3 * BLOCKS_PER_EPOCH + 105_000; // epoch 4 half done by blocks
  const out = buildClock(synthetic(), HALVINGS, { tipHeight: tip });
  assert.equal(out.slug, 'cycle-clock');
  assert.equal(out.epochs.length, 2);
  const [e3, e4] = out.epochs;
  assert.equal(e3.open, false);
  assert.equal(e3.days, 1380);
  assert.equal(e3.progress, 1);
  assert.ok(near(e3.peak.t, 600 / 1380, 1e-3));
  assert.ok(near(e3.low.t, 900 / 1380, 1e-3));
  assert.equal(e3.low.provisional, false);
  assert.equal(e3.samples[0].day, dayAt(E3, 12), 'first sample with a non-null MVRV');
  assert.ok(e3.samples.every(s => s.t >= 0 && s.t <= 1));
  assert.equal(e3.samples[e3.samples.length - 1].day, dayAt(E3, 1379), 'the last day of the ring is always sampled');
  assert.equal(e4.open, true);
  assert.equal(e4.progress, 0.5);
  assert.equal(e4.days, Math.round(699 / 0.5), 'projected length = elapsed / block progress');
  assert.equal(e4.peak, null, 'no bear yet in the open epoch');
  assert.equal(out.today.epoch, 4);
  assert.equal(out.today.blocksIn, 105_000);
  assert.ok(near(out.today.t, 699 / 1398, 1e-3));
  assert.equal(out.atHour.length, 1);
  assert.equal(out.atHour[0].epoch, 3);
  // Epoch 3's reading near t = 0.5 is day ~690, on the way down: price ~14,900 -> mvrv ~2.98.
  assert.ok(Math.abs(out.atHour[0].mvrv - 2.98) < 0.1);
  assert.equal(out.asOf, dayAt(E3, 2079));
});

test('buildClock: without a tip the open ring assumes four years', () => {
  const out = buildClock(synthetic(), HALVINGS, { tipHeight: null });
  assert.equal(out.epochs[1].days, 1461);
  assert.equal(out.today.blocksIn, null);
  assert.equal(out.today.progress, null);
});
