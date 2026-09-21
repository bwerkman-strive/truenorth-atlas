import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heatColor, clipValue, intensity, yForPrice, priceTicks, yearColumns, cellAt, columnTotal, stackLabels } from '../src/heatmapRows.js';
import { mvrvColor, angleOf, polar, arcPath, ringRadii, ringSegments } from '../src/clockRows.js';
import { heatmapHeadline, clockHeadline } from '../src/panelHeadlines.js';

test('heatColor: transparent at zero, orange mid, warm white at one', () => {
  assert.equal(heatColor(0), 'rgba(247, 148, 29, 0)');
  assert.match(heatColor(0.3), /^rgba\(247, 148, 29, 0\.\d+\)$/);
  assert.equal(heatColor(0.55), 'rgb(247, 148, 29)');
  assert.equal(heatColor(1), 'rgb(255, 241, 220)');
  assert.equal(heatColor(5), heatColor(1), 'clamped');
});

test('clipValue is the 99th percentile of non-zero cell SHARES; intensity is linear and clipped', () => {
  const cols = [{ cells: [0, 1, 4, 9], floor: 6 }, { cells: [16, 0, 0, 100], floor: 84 }];
  assert.equal(columnTotal(cols[0]), 20);
  assert.equal(columnTotal(cols[1]), 200);
  assert.equal(clipValue(cols), 0.5, '100 of 200 is the largest share');
  assert.equal(clipValue([{ cells: [0, 0], floor: 0 }], 7), 7);
  assert.deepEqual(stackLabels([100, 104, 300], 24, 0), [100, 124, 300]);
  assert.deepEqual(stackLabels([10, 5], 24, 20), [20, 44], 'never above the minimum');
  assert.equal(intensity(25, 100), 0.25);
  assert.equal(intensity(400, 100), 1);
  assert.equal(intensity(0, 100), 0);
});

test('log price geometry: top of the grid is y=0, bottom is h; decade ticks fall inside', () => {
  const levels = [1, 10, 100, 1000];
  assert.equal(yForPrice(1000, levels, 300), 0);
  assert.equal(yForPrice(1, levels, 300), 300);
  assert.ok(Math.abs(yForPrice(10, levels, 300) - 200) < 1e-9);
  assert.equal(yForPrice(0, levels, 300), 300, 'no price sits on the floor');
  assert.deepEqual(priceTicks(levels), [1, 10, 100, 1000]);
  assert.deepEqual(priceTicks([0.05, 140000]), [0.1, 1, 10, 100, 1000, 10000, 100000]);
});

test('yearColumns and cellAt map samples and pixels onto the grid', () => {
  const cols = [{ day: '2010-07-18' }, { day: '2010-12-26' }, { day: '2011-01-02' }];
  assert.deepEqual(yearColumns(cols), [{ i: 0, year: '2010' }, { i: 2, year: '2011' }]);
  assert.deepEqual(cellAt(5, 95, 10, 4, 100, 100), { ci: 0, ri: 0 }, 'bottom-left pixel is the first column, lowest row');
  assert.deepEqual(cellAt(99, 1, 10, 4, 100, 100), { ci: 9, ri: 3 });
  assert.equal(cellAt(-1, 5, 10, 4, 100, 100), null);
  assert.equal(cellAt(5, 100, 10, 4, 100, 100), null);
});

test('mvrvColor: clamps at the ends and interpolates between stops', () => {
  assert.equal(mvrvColor(0.2), 'rgb(96, 165, 250)');
  assert.equal(mvrvColor(1.5), 'rgb(156, 163, 175)');
  assert.equal(mvrvColor(9), 'rgb(248, 113, 113)');
  assert.equal(mvrvColor(2), 'rgb(204, 177, 106)', 'halfway between neutral and amber');
  assert.match(mvrvColor(null), /^rgba/);
});

test('clock geometry: twelve o\'clock is straight up, arcs close, rings nest outward', () => {
  assert.ok(Math.abs(angleOf(0) + Math.PI / 2) < 1e-12);
  const [x, y] = polar(100, 100, 50, 0);
  assert.ok(Math.abs(x - 100) < 1e-9 && Math.abs(y - 50) < 1e-9);
  const [x3, y3] = polar(100, 100, 50, 0.25);
  assert.ok(Math.abs(x3 - 150) < 1e-9 && Math.abs(y3 - 100) < 1e-9, 'a quarter turn is three o\'clock');
  const d = arcPath(100, 100, 40, 50, 0, 0.25);
  assert.match(d, /^M .* A 50\.00 50\.00 0 0 1 .* L .* A 40\.00 40\.00 0 0 0 .* Z$/);
  assert.match(arcPath(100, 100, 40, 50, 0, 0.75), / A 50\.00 50\.00 0 1 1 /, 'large-arc flag past half a turn');
  const rings = ringRadii(3, { inner: 10, outer: 100, gap: 5 });
  assert.equal(rings.length, 3);
  assert.equal(rings[0].r0, 10);
  assert.ok(Math.abs(rings[2].r1 - 100) < 1e-9);
  assert.ok(rings[1].r0 > rings[0].r1 && rings[2].r0 > rings[1].r1);
  assert.ok(rings[2].r1 - rings[2].r0 > rings[0].r1 - rings[0].r0, 'outer rings are thicker');
  assert.deepEqual(ringRadii(0), []);
});

test('ringSegments spans each sample to the next, coloring by its MVRV', () => {
  const segs = ringSegments([{ t: 0, mvrv: 0.5 }, { t: 0.5, mvrv: 4 }, { t: 0.9, mvrv: 1.5 }]);
  assert.equal(segs.length, 3);
  assert.deepEqual([segs[0].t0, segs[0].t1], [0, 0.5]);
  assert.equal(segs[0].color, 'rgb(96, 165, 250)');
  assert.equal(segs[1].color, 'rgb(248, 113, 113)');
  assert.ok(Math.abs(segs[2].t1 - 0.904) < 1e-9, 'the last sample gets a short segment');
});

test('heatmapHeadline names the densest cluster and the share of supply in profit', () => {
  const h = heatmapHeadline({
    columns: [{}],
    latest: { day: '2026-09-20', price: 81160, inProfit: 0.714, width: 1247, floor: 3.7e6, clusters: [
      { from: 95000, to: 105000, btc: 2100000, position: 'underwater' },
      { from: 60000, to: 66000, btc: 900000, position: 'in profit' },
    ] },
  });
  assert.equal(h.value, '2.10M BTC');
  assert.equal(h.sub, 'densest cluster, acquired $95,000 to $105,000, underwater');
  assert.equal(h.takeaway,
    'As of 09/20/2026, the densest cost-basis cluster holds 2.10M BTC acquired between $95,000 and $105,000, underwater at the $81,160 close. '
    + 'The next holds 900.0K BTC between $60,000 and $66,000, in profit. 71% of supply is in profit.');
  assert.equal(h.asOf, '2026-09-20');
  assert.equal(heatmapHeadline({ columns: [], latest: null }), null);
});

test('clockHeadline states block progress, the readings at this hour, and where turns have fallen', () => {
  const h = clockHeadline({
    asOf: '2026-09-20',
    epochs: [
      { epoch: 3, open: false, peak: { t: 0.38 }, low: { t: 0.65, provisional: false } },
      { epoch: 4, open: false, peak: { t: 0.39 }, low: { t: 0.65, provisional: false } },
      { epoch: 5, open: true, peak: { t: 0.37 }, low: { t: 0.55, provisional: true } },
    ],
    today: { epoch: 5, t: 0.61, progress: 0.6098, blocksIn: 128054, mvrv: 1.52 },
    atHour: [{ epoch: 3, mvrv: 3.1 }, { epoch: 4, mvrv: 2.4 }],
  });
  assert.equal(h.value, '61%');
  assert.equal(h.sub, 'of epoch 5 complete, block 128,054 of 210,000');
  assert.equal(h.takeaway,
    'Epoch 5 is 61% complete by blocks (128,054 of 210,000). MVRV reads 1.52 at this hour; at the same hour, epochs 3 and 4 read 3.10 and 2.40. '
    + 'Cycle peaks have fallen between 38% and 39% of the way through an epoch, lows between 65% and 65%.');
  assert.equal(clockHeadline({ epochs: [] }), null);
});
