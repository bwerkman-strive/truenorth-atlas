import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockSubsidySat } from '../src/rpc.js';

test('genesis-era subsidy is 50 BTC', () => {
  assert.equal(blockSubsidySat(0), 50_0000_0000);
  assert.equal(blockSubsidySat(209_999), 50_0000_0000);
});

test('halvings step exactly at 210,000-block intervals', () => {
  assert.equal(blockSubsidySat(210_000), 25_0000_0000);
  assert.equal(blockSubsidySat(420_000), 12_5000_0000);
  assert.equal(blockSubsidySat(630_000), 6_2500_0000);
  assert.equal(blockSubsidySat(840_000), 3_1250_0000);   // 2024 halving
  assert.equal(blockSubsidySat(1_050_000), 1_5625_0000); // 2028 halving
});

test('sub-satoshi truncation matches consensus (floor, not round)', () => {
  // 10th halving: 50e8 / 1024 = 4882812.5 -> consensus floors to 4882812
  assert.equal(blockSubsidySat(10 * 210_000), 4_882_812);
});

test('subsidy reaches zero after 64 halvings', () => {
  assert.equal(blockSubsidySat(64 * 210_000), 0);
  assert.equal(blockSubsidySat(100 * 210_000), 0);
});

test('total issuance converges just under 21M BTC', () => {
  let total = 0;
  for (let h = 0; h < 64; h++) total += 210_000 * blockSubsidySat(h * 210_000);
  assert.ok(total / 1e8 < 21_000_000);
  assert.ok(total / 1e8 > 20_999_000);
});
