// Pure-function coverage for the sprint-1 cycle charts (cycleCharts.js):
// bull runs off each low, drawdown from the all-time high, and the scorecard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRuns, buildUnderwater, buildScorecard } from '../src/cycleCharts.js';

const E3 = '2016-07-09', E4 = '2020-04-19', E5 = '2024-04-19';
const dayAt = (start, i) => new Date(Date.parse(start) + i * 86400e3).toISOString().slice(0, 10);
const HALVINGS = [{ epoch: 3, start: E3 }, { epoch: 4, start: E4 }, { epoch: 5, start: E5 }];
const lerp = (a, b, t) => a + (b - a) * t;

// Two cycles: epoch 3 peaks at 20,000 (day 600) and bottoms at 3,000 (day
// 900, with a 10k -> 15k bounce on the way down); epoch 4 runs to 60,000 on
// day 1800 and bottoms at 12,000 on day 2100, then climbs to 30,000 by day
// 2600 into epoch 5, which has no bear yet.
function synthetic(days = 2601) {
  const rows = [];
  for (let i = 0; i < days; i++) {
    let price;
    if (i <= 600) price = lerp(600, 20000, i / 600);
    else if (i <= 700) price = lerp(20000, 10000, (i - 600) / 100);
    else if (i <= 720) price = lerp(10000, 15000, (i - 700) / 20);
    else if (i <= 900) price = lerp(15000, 3000, (i - 720) / 180);
    else if (i <= 1800) price = lerp(3000, 60000, (i - 900) / 900);
    else if (i <= 2100) price = lerp(60000, 12000, (i - 1800) / 300);
    else price = lerp(12000, 30000, (i - 2100) / 500);
    rows.push({ day: dayAt(E3, i), price, mvrv: price / 5000, supply_profit_pct: price / 100000 });
  }
  return rows;
}

test('buildRuns: each run climbs from a low to the next peak as a multiple, the last one provisional', () => {
  const out = buildRuns(synthetic(), HALVINGS);
  assert.equal(out.slug, 'bull-run-comparison');
  assert.equal(out.runs.length, 2);
  const [r3, r4] = out.runs;
  assert.equal(r3.epoch, 3);
  assert.equal(r3.ongoing, false);
  assert.equal(r3.low.day, dayAt(E3, 900));
  assert.equal(r3.low.price, 3000);
  assert.equal(r3.peak.day, dayAt(E3, 1800));
  assert.equal(r3.peak.price, 60000);
  assert.equal(r3.days, 900);
  assert.equal(r3.multiple, 20);
  assert.equal(r3.current, null);
  assert.equal(r3.values[0].d, 0);
  assert.equal(r3.values[0].m, 1);
  assert.equal(r3.values.length, 901);
  assert.equal(r4.epoch, 4);
  assert.equal(r4.ongoing, true);
  assert.equal(r4.provisional, false, 'epoch 4 is closed; its recovery is simply still running');
  assert.equal(r4.peak, null);
  assert.equal(r4.multiple, null);
  assert.equal(r4.days, 500);
  assert.equal(r4.current, 2.5);
  // Comparison on the live run's day: run 3 stood at 3000 + 57000 * 500/900 over 3000.
  assert.equal(out.today.epoch, 4);
  assert.equal(out.today.d, 500);
  assert.equal(out.today.m, 2.5);
  assert.equal(out.today.atDay.length, 1);
  assert.ok(Math.abs(out.today.atDay[0].m - (3000 + 57000 * 500 / 900) / 3000) < 1e-3);
});

test('buildUnderwater: drawdown from the running high with bear depth, length, recovery and shares', () => {
  const out = buildUnderwater(synthetic(), HALVINGS, { excluded: [] });
  assert.equal(out.slug, 'drawdown-from-ath');
  assert.equal(out.series.length, 2601);
  assert.equal(out.series[0].dd, 0, 'the first close is its own high');
  assert.equal(out.series[600].dd, 0, 'the peak day sits at the high');
  assert.ok(Math.abs(out.series[900].dd - (3000 / 20000 - 1)) < 1e-4);
  const [b3, b4] = out.bears;
  assert.equal(b3.epoch, 3);
  assert.ok(Math.abs(b3.depth - (-0.85)) < 1e-4);
  assert.equal(b3.bearDays, 300);
  assert.equal(b3.recovery.days, dayAt(E3, 900) < b3.recovery.day ? b3.recovery.days : -1);
  assert.equal(b3.recovery.day, dayAt(E3, 1169), 'first close back at or above 20,000');
  assert.equal(b4.epoch, 4);
  assert.ok(Math.abs(b4.depth - (-0.8)) < 1e-4);
  assert.equal(b4.recovery, null, 'not yet back to 60,000');
  assert.equal(out.current.day, dayAt(E3, 2600));
  assert.equal(out.current.ath.price, 60000);
  assert.equal(out.current.sinceAth, 800);
  assert.ok(Math.abs(out.current.dd - (30000 / 60000 - 1)) < 1e-4);
  assert.equal(out.share.days, 2601);
  assert.ok(out.share.below30 > out.share.below50 && out.share.below50 > out.share.below80);
  assert.ok(out.share.below80 > 0, 'the 85% bear counts');
});

test('buildUnderwater: flagged closes are gaps, not spikes', () => {
  const rows = synthetic();
  rows[1000].price = 100; // a venue glitch mid-recovery
  const naive = buildUnderwater(rows, HALVINGS, { excluded: [] });
  assert.ok(naive.series[1000].dd < -0.99);
  const win = [{ from: dayAt(E3, 999), to: dayAt(E3, 1001), reason: 'test' }];
  const guarded = buildUnderwater(rows, HALVINGS, { excluded: win });
  assert.equal(guarded.series[1000].dd, null);
  assert.equal(guarded.series.length, 2601);
  assert.deepEqual(guarded.excluded, win);
});

test('buildScorecard: one row per epoch with the cycle facts, the open epoch provisional', () => {
  const out = buildScorecard(synthetic(), HALVINGS, { excluded: [] });
  assert.equal(out.slug, 'cycle-scorecard');
  assert.equal(out.asOf, dayAt(E3, 2600));
  assert.equal(out.cycles.length, 2, 'epoch 5 has had no bear market');
  const c3 = out.cycles[0];
  assert.equal(c3.epoch, 3);
  assert.equal(c3.provisional, false);
  assert.equal(c3.peak.price, 20000);
  assert.equal(c3.low.price, 3000);
  assert.equal(c3.drawdown, 0.85);
  assert.equal(c3.bearDays, 300);
  assert.equal(c3.bearRally, 0.5);
  assert.equal(c3.mvrvPeak, 4);
  assert.equal(c3.mvrvLow, 0.6);
  assert.equal(c3.profitAtLow, 0.03);
  assert.equal(c3.halvingToPeak, 600);
  assert.deepEqual(c3.run, { multiple: 20, days: 900, ongoing: false });
  const c4 = out.cycles[1];
  assert.equal(c4.epoch, 4);
  assert.equal(c4.drawdown, 0.8);
  assert.equal(c4.bearDays, 300);
  assert.equal(c4.halvingToPeak, dayAt(E3, 1800) ? Math.round((Date.parse(dayAt(E3, 1800)) - Date.parse(E4)) / 86400e3) : null);
  assert.deepEqual(c4.run, { multiple: 2.5, days: 500, ongoing: true });
});

test('buildScorecard: the open epoch\'s bear is measured to the latest day', () => {
  // Cut the history 100 days after epoch 4's low and drop the epoch-5 halving
  // so epoch 4 is the open one.
  const rows = synthetic(2201);
  const out = buildScorecard(rows, HALVINGS.slice(0, 2), { excluded: [] });
  const c4 = out.cycles[1];
  assert.equal(c4.provisional, true);
  assert.equal(c4.bearDays, 400, '300 days to the low plus 100 more');
  assert.equal(c4.run.ongoing, true);
  assert.equal(c4.run.days, 100);
});
