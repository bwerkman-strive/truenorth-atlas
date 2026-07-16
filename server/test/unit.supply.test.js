// The supply projection is pure consensus math anchored at a tip — verify it
// against block-by-block summation, the 21M cap, and exact halving placement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issuanceBetweenSat, projectSupply } from '../src/supply.js';
import { blockSubsidySat } from '../src/rpc.js';

test('issuanceBetweenSat matches block-by-block summation across a halving', () => {
  const from = 209_990, to = 210_010;
  let sum = 0;
  for (let h = from + 1; h <= to; h++) sum += blockSubsidySat(h);
  assert.equal(issuanceBetweenSat(from, to), sum);
  assert.equal(issuanceBetweenSat(from, from), 0);
});

test('projection anchors exactly at the tip and stays under 21M forever', () => {
  // Anchor supply straight off the schedule: total issuance for heights 0..tip.
  const tipSupplySat = issuanceBetweenSat(-1, 903_000);
  const tip = { tipHeight: 903_000, tipTimeSec: 1_752_537_600, tipSupplySat };
  const { points } = projectSupply({ ...tip, halvingsAhead: 40 });
  assert.equal(points[0].supply, tipSupplySat / 1e8);
  assert.equal(points[0].day, new Date(tip.tipTimeSec * 1000).toISOString().slice(0, 10));
  for (let i = 1; i < points.length; i++) {
    assert.ok(points[i].supply >= points[i - 1].supply, 'supply is monotonic');
    assert.ok(points[i].day >= points[i - 1].day, 'days are monotonic');
  }
  assert.ok(points[points.length - 1].supply < 21_000_000);
});

test('future halvings land on exact 210,000 boundaries, dated at 600 s/block', () => {
  const tipTimeSec = 1_752_537_600;
  const { halvings, points } = projectSupply({
    tipHeight: 903_000, tipTimeSec, tipSupplySat: 19_890_000e8,
  });
  // Default horizon: every remaining halving through the end of issuance,
  // i.e. epochs 6..34 (the subsidy hits zero at block 6,930,000, ~2141).
  assert.equal(halvings.length, 29);
  assert.deepEqual(halvings.slice(0, 3).map(h => h.height), [1_050_000, 1_260_000, 1_470_000]);
  assert.deepEqual(halvings.slice(0, 3).map(h => h.epoch), [6, 7, 8]);
  assert.equal(halvings[halvings.length - 1].height, 6_930_000);
  assert.equal(halvings[halvings.length - 1].epoch, 34);
  assert.ok(halvings.every(h => h.estimated));
  // Nothing left to issue past the horizon: the curve is flat after 6,930,000.
  assert.equal(issuanceBetweenSat(6_930_000, 7_500_000), 0);
  assert.equal(issuanceBetweenSat(6_929_998, 6_929_999), 1, 'the last block with a subsidy mints 1 sat');
  const expDay = new Date((tipTimeSec + (1_050_000 - 903_000) * 600) * 1000)
    .toISOString().slice(0, 10);
  assert.equal(halvings[0].day, expDay);
  // The curve carries a sample exactly at each halving so the kink renders.
  for (const h of halvings) assert.ok(points.some(p => p.day === h.day), `no point at ${h.day}`);
});

test('issuance splits exactly at the 2028 boundary (heights 1,049,999 / 1,050,000)', () => {
  assert.equal(issuanceBetweenSat(1_049_998, 1_049_999), 3_1250_0000, 'last epoch-5 block');
  assert.equal(issuanceBetweenSat(1_049_999, 1_050_000), 1_5625_0000, 'first epoch-6 block');
  // 1,000 blocks straddling the boundary: 499 pre-halving + 501 post-halving.
  assert.equal(issuanceBetweenSat(1_049_500, 1_050_500),
    499 * 3_1250_0000 + 501 * 1_5625_0000);
});
