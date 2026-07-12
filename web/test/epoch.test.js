// The header mark is a live instrument: the coin's position IS the chain's
// progress through the current halving epoch. This suite pins the math.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BLOCKS_PER_EPOCH, epochInfo, coinXY, epochLabel } from '../src/epoch.js';

test('epoch boundaries land exactly on halvings', () => {
  assert.equal(epochInfo(0).epoch, 1);
  assert.equal(epochInfo(209_999).epoch, 1);
  assert.equal(epochInfo(210_000).epoch, 2);
  assert.equal(epochInfo(840_000).epoch, 5);          // April 2024 halving opened epoch 5
  assert.equal(epochInfo(1_049_999).epoch, 5);
  assert.equal(epochInfo(1_050_000).epoch, 6);        // 2028 halving
});

test('progress is a clean [0,1) fraction of the epoch', () => {
  assert.equal(epochInfo(840_000).progress, 0);
  assert.equal(epochInfo(840_000 + 105_000).progress, 0.5);
  assert.equal(epochInfo(840_000).blocksLeft, BLOCKS_PER_EPOCH);
  const nearEnd = epochInfo(1_049_999);
  assert.equal(nearEnd.blocksLeft, 1);
  assert.ok(nearEnd.progress < 1);
});

test('invalid heights return null (logo falls back to idle orbit)', () => {
  assert.equal(epochInfo(null), null);
  assert.equal(epochInfo(undefined), null);
  assert.equal(epochInfo(-5), null);
  assert.equal(epochInfo('not-a-height'), null);
});

test('coin geometry: 0 = true north, clockwise, always on the ring', () => {
  const north = coinXY(0);
  assert.ok(Math.abs(north.x - 120) < 1e-9 && Math.abs(north.y - 26) < 1e-9);
  const east = coinXY(0.25);
  assert.ok(Math.abs(east.x - 214) < 1e-9 && Math.abs(east.y - 120) < 1e-9);
  const south = coinXY(0.5);
  assert.ok(Math.abs(south.x - 120) < 1e-9 && Math.abs(south.y - 214) < 1e-9);
  // Every position is exactly radius 94 from center — the orbit cannot drift.
  for (let p = 0; p < 1; p += 0.07) {
    const { x, y } = coinXY(p);
    const r = Math.hypot(x - 120, y - 120);
    assert.ok(Math.abs(r - 94) < 1e-9, `progress ${p.toFixed(2)}: r=${r}`);
  }
});

test('tooltip label reads like an instrument', () => {
  const label = epochLabel(945_000); // halfway through epoch 5
  assert.match(label, /^Epoch 5 · 50\.0% complete · 105,000 blocks to the halving$/);
  assert.equal(epochLabel(null), 'True North Atlas');
});
