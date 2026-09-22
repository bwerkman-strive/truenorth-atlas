// Pure-function coverage for the sprint-3 story charts (storyCharts.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPnl, buildHandoff, buildMiners, buildDipBuyers, buildReturns, buildSameHour, buildDaysSince,
} from '../src/storyCharts.js';
import { BLOCKS_PER_EPOCH } from '../src/clock.js';

const E3 = '2016-07-09', E4 = '2020-04-19', E5 = '2024-04-19';
const dayAt = (start, i) => new Date(Date.parse(start) + i * 86400e3).toISOString().slice(0, 10);
const HALVINGS = [{ epoch: 3, start: E3 }, { epoch: 4, start: E4 }, { epoch: 5, start: E5 }];
const lerp = (a, b, t) => a + (b - a) * t;
const BANDS = ['<1', '1-10', '10+'];

// Epoch 3 peaks at 20,000 (day 600), bottoms at 3,000 (day 900); epoch 4
// runs to 60,000 (day 1800), bottoms at 12,000 (day 2100); the open epoch 5
// climbs to 30,000 by day 2600. Cohort supplies, hashrate ribbons, P&L and
// balance bands are stylised alongside.
function synthetic(days = 2601) {
  const rows = [];
  for (let i = 0; i < days; i++) {
    let price;
    if (i <= 600) price = lerp(600, 20000, i / 600);
    else if (i <= 900) price = lerp(20000, 3000, (i - 600) / 300);
    else if (i <= 1800) price = lerp(3000, 60000, (i - 900) / 900);
    else if (i <= 2100) price = lerp(60000, 12000, (i - 1800) / 300);
    else price = lerp(12000, 30000, (i - 2100) / 500);
    const bear = (i > 600 && i <= 900) || (i > 1800 && i <= 2100);
    rows.push({
      day: dayAt(E3, i), price,
      realized_profit: bear ? 1e6 : 5e6 + (i === 1500 ? 9e8 : 0),
      realized_loss: bear ? 4e7 + (i === 850 ? 5e8 : 0) + (i === 2000 ? 9e8 : 0) : 2e6,
      sth_supply: bear ? 3e6 : 4e6, lth_supply: bear ? 15e6 : 14e6,
      // Ribbons: the 30-day average dips under the 60-day for 40 days after each peak.
      hashrate_30d: (i > 620 && i <= 660) || (i > 1820 && i <= 1860) ? 90 : 110,
      hashrate_60d: 100,
      balance_bands: { '<1': 0.10 + (bear ? 0.01 : 0) + i * 1e-6, '1-10': 0.30, '10+': 0.60 - (bear ? 0.01 : 0) - i * 1e-6 },
    });
  }
  return rows;
}

test('buildPnl: daily series, the largest loss days, and the open bear\'s worst day', () => {
  const out = buildPnl(synthetic(), HALVINGS);
  assert.equal(out.slug, 'realized-pnl-mirror');
  assert.equal(out.series.length, 2601);
  assert.deepEqual(Object.keys(out.series[0]).sort(), ['day', 'loss', 'profit']);
  assert.equal(out.topLoss[0].day, dayAt(E3, 2000));
  assert.equal(out.topLoss[0].loss, 9.4e8);
  assert.equal(out.topLoss[1].day, dayAt(E3, 850));
  assert.equal(out.topProfit[0].day, dayAt(E3, 1500));
  assert.equal(out.bear, null, 'epoch 5 has no bear yet');
  assert.equal(out.latest.day, dayAt(E3, 2600));
  // Cut the history inside epoch 4's bear and it becomes the open bear.
  const open = buildPnl(synthetic(2050), HALVINGS.slice(0, 2));
  assert.equal(open.bear.epoch, 4);
  assert.equal(open.bear.peak, dayAt(E3, 1800));
  assert.equal(open.bear.largestLoss.day, dayAt(E3, 2000));
});

test('buildHandoff: long-term share series, readings at each turn, and the move since the low', () => {
  const out = buildHandoff(synthetic(2050), HALVINGS.slice(0, 2), { step: 7 });
  assert.equal(out.slug, 'holder-handoff');
  assert.ok(out.series.length > 250 && out.series.length < 300, 'weekly samples');
  assert.deepEqual(Object.keys(out.series[0]).sort(), ['day', 'lth', 'lthBtc', 'price', 'sthBtc']);
  assert.equal(out.series[out.series.length - 1].day, dayAt(E3, 2049));
  const m3 = out.marks.find(m => m.epoch === 3);
  assert.ok(Math.abs(m3.peak.lth - 14 / 18) < 1e-3);
  assert.ok(Math.abs(m3.low.lth - 15 / 18) < 1e-3);
  assert.equal(out.current.lthBtc, 15e6);
  assert.equal(out.current.sinceLow.day, dayAt(E3, 2049 - 0), 'the open bear\'s low to date is the latest day here');
});

test('buildMiners: capitulation episodes of at least 14 days, what price did 180 days later', () => {
  const out = buildMiners(synthetic(), HALVINGS);
  assert.equal(out.slug, 'miner-stress');
  assert.equal(out.episodes.length, 2);
  const [e1, e2] = out.episodes;
  assert.equal(e1.start, dayAt(E3, 621));
  assert.equal(e1.end, dayAt(E3, 660));
  assert.equal(e1.days, 40);
  assert.equal(e1.ongoing, false);
  assert.equal(e1.after180.day, dayAt(E3, 840));
  assert.ok(e1.after180.change < 0, 'still falling 180 days later in the synthetic bear');
  assert.ok(e2.after180.change < 0);
  assert.deepEqual(out.stats, { count: 2, judged: 2, higher180: 0 });
  assert.equal(out.current.inEpisode, false);
  assert.deepEqual(Object.keys(out.series[0]).sort(), ['day', 'h30', 'h60', 'price']);
  // Short dips are noise and are dropped.
  const noisy = synthetic().map((r, i) => (i >= 1000 && i < 1005 ? { ...r, hashrate_30d: 50 } : r));
  assert.equal(buildMiners(noisy, HALVINGS).episodes.length, 2);
});

test('buildDipBuyers: share change per band since the low, against the same span after prior lows', () => {
  const out = buildDipBuyers(synthetic(2201), HALVINGS.slice(0, 2), BANDS);
  assert.equal(out.slug, 'who-bought-the-dip');
  assert.deepEqual(out.bands, BANDS);
  assert.equal(out.current.epoch, 4);
  assert.equal(out.current.since, dayAt(E3, 2100));
  assert.equal(out.current.days, 100);
  assert.equal(out.current.rows.length, 3);
  const small = out.current.rows.find(r => r.band === '<1');
  assert.ok(Math.abs(small.delta - (-0.01 + 100e-6)) < 1e-3, 'the bear bump unwinds after the low, drift aside');
  assert.equal(out.priors.length, 1);
  assert.equal(out.priors[0].epoch, 3);
  assert.equal(out.priors[0].days, 100, 'prior lows are measured over the same span');
  assert.equal(out.priors[0].rows.length, 3);
});

test('buildReturns: month-end to month-end returns, yearly totals, and the current month\'s history', () => {
  const rows = [];
  // 2023-11-30 100, 2023-12-31 110, then 2024: Jan 121, Feb 108.9, ..., a few days of Mar.
  const push = (day, price) => rows.push({ day, price });
  push('2023-11-29', 99); push('2023-11-30', 100); push('2023-12-15', 105); push('2023-12-31', 110);
  push('2024-01-31', 121); push('2024-02-29', 108.9); push('2024-03-05', 119.79);
  const out = buildReturns(rows);
  assert.equal(out.slug, 'monthly-returns');
  const y23 = out.years.find(y => y.year === 2023), y24 = out.years.find(y => y.year === 2024);
  assert.equal(y23.months[10], null, 'no October close to measure November against');
  assert.equal(y23.months[11], 0.1);
  assert.equal(y23.total, null, 'no 2022 close');
  assert.equal(y24.months[0], 0.1);
  assert.equal(y24.months[1], -0.1);
  assert.equal(y24.months[2], 0.1, 'March to date');
  assert.equal(y24.partial, true);
  assert.ok(Math.abs(y24.total - (119.79 / 110 - 1)) < 1e-6, 'year to date');
  assert.deepEqual(out.current, { year: 2024, month: 3, ret: 0.1, day: '2024-03-05', provisional: true });
  assert.deepEqual(out.monthStats, { month: 3, years: 0, up: 0, down: 0, median: null });
});

test('buildSameHour: the same point in each earlier epoch and the forward changes, as history', () => {
  const tip = 4 * BLOCKS_PER_EPOCH + 105_000; // epoch 5 half done by blocks
  const out = buildSameHour(synthetic(), HALVINGS, { tipHeight: tip });
  assert.equal(out.slug, 'same-hour');
  assert.equal(out.today.epoch, 5);
  assert.equal(out.today.progress, 0.5);
  assert.deepEqual(out.horizons, [90, 180, 365]);
  assert.equal(out.rows.length, 2);
  const r3 = out.rows[0];
  assert.equal(r3.epoch, 3);
  assert.equal(r3.day, dayAt(E3, 690), 'half of epoch 3\'s 1380 days');
  assert.equal(r3.forward[0].days, 90);
  assert.equal(r3.forward[0].day, dayAt(E3, 780));
  assert.ok(r3.forward[0].change < 0, 'still in the bear 90 days on');
  assert.equal(r3.forward[2].day, dayAt(E3, 1055));
  assert.ok(r3.forward[2].change < 0, 'a year on, the synthetic recovery has not yet regained day 690\'s price');
  const r4 = out.rows[1];
  assert.equal(r4.day, dayAt(E4, Math.round(0.5 * 1461)));
  assert.ok(r4.forward.every(f => f.day !== null), 'all horizons inside the data');
  // Without a tip, the calendar stands in for block progress.
  assert.equal(buildSameHour(synthetic(), HALVINGS, { tipHeight: null }).today.progress, null);
});

test('buildDaysSince: the four counts with the prior cycle\'s span beside each', () => {
  const tip = 4 * BLOCKS_PER_EPOCH + 105_000;
  const out = buildDaysSince(synthetic(), HALVINGS, { tipHeight: tip });
  assert.equal(out.slug, 'days-since');
  assert.equal(out.asOf, dayAt(E3, 2600));
  const keys = out.items.map(i => i.key);
  assert.deepEqual(keys, ['ath', 'halving', 'nextHalving'], 'no open bear, so no low-to-date item');
  const ath = out.items[0];
  assert.equal(ath.date, dayAt(E3, 1800));
  assert.equal(ath.days, 800);
  assert.deepEqual(ath.prior, { label: 'epoch 4 bear, peak to low', days: 300 });
  const halving = out.items[1];
  assert.equal(halving.date, E5);
  assert.deepEqual(halving.prior, { label: 'epoch 4 halving to peak', days: Math.round((Date.parse(dayAt(E3, 1800)) - Date.parse(E4)) / 86400e3) });
  const next = out.items[2];
  assert.equal(next.value, 105_000);
  assert.equal(next.days, Math.round(105_000 * 600 / 86400));
  assert.deepEqual(next.prior, { label: 'epoch 4 lasted', days: 1461 });
  // With an open bear the low item appears and the prior run is cited.
  const mid = buildDaysSince(synthetic(2050), HALVINGS.slice(0, 2), { tipHeight: 3 * BLOCKS_PER_EPOCH + 100 });
  assert.deepEqual(mid.items.map(i => i.key), ['ath', 'low', 'halving', 'nextHalving']);
  assert.deepEqual(mid.items[1].prior, { label: 'epoch 3 low to the next peak', days: 900 });
});
