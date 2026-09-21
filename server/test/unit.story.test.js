// The story layer's facts and sentence (story.js), on synthetic history.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { percentileOf, zoneOf, zoneStreak, cycleExtremes, takeaway, buildStory, fmtValue } from '../src/story.js';

const E3 = '2016-07-09', E4 = '2020-04-19';
const dayAt = (start, i) => new Date(Date.parse(start) + i * 86400e3).toISOString().slice(0, 10);
const HALVINGS = [{ epoch: 3, start: E3 }, { epoch: 4, start: E4 }];
const MVRV = {
  slug: 'mvrv', name: 'MVRV Ratio', format: 'ratio',
  zones: [
    { from: 0, to: 1, label: 'Below aggregate cost basis', tone: 'cold' },
    { from: 3, to: 10, label: 'Historically elevated', tone: 'hot' },
  ],
};

// Price: 600 -> 20,000 by day 600, down to 3,000 by day 900, up after; the
// metric tracks price / 5,000 so it reads 4.0 at the peak and 0.6 at the low.
function synthetic(days = 1500) {
  const rows = [];
  for (let i = 0; i < days; i++) {
    let price;
    if (i <= 600) price = 600 + (20000 - 600) * (i / 600);
    else if (i <= 900) price = 20000 - 17000 * ((i - 600) / 300);
    else price = 3000 + 7000 * ((i - 900) / 500);
    rows.push({ day: dayAt(E3, i), price, v: price / 5000 });
  }
  return rows;
}

test('percentileOf is the share of readings at or below the value', () => {
  assert.equal(percentileOf([1, 2, 3, 4, null], 3), 0.75);
  assert.equal(percentileOf([1, 2, 3, 4], 0.5), 0);
  assert.equal(percentileOf([5], 5), null, 'needs at least two readings');
  assert.equal(percentileOf([1, 2], null), null);
});

test('zoneOf picks the inclusive band and ignores line markers', () => {
  assert.equal(zoneOf(MVRV.zones, 0.7).label, 'Below aggregate cost basis');
  assert.equal(zoneOf(MVRV.zones, 1).index, 0, 'inclusive upper edge');
  assert.equal(zoneOf(MVRV.zones, 2), null);
  assert.equal(zoneOf(MVRV.zones, 3.5).tone, 'hot');
  assert.equal(zoneOf([{ from: 1, to: 1, tone: 'line', label: 'Break-even' }], 1), null);
  assert.equal(zoneOf(MVRV.zones, null), null);
});

test('zoneStreak counts trailing days in the latest band, or outside every band', () => {
  const s = (vals) => vals.map((v, i) => ({ day: dayAt(E3, i), v }));
  const inHot = zoneStreak(s([0.5, 2, 3.2, 3.5, 4]), MVRV.zones);
  assert.equal(inHot.zone.tone, 'hot');
  assert.equal(inHot.days, 3);
  assert.equal(inHot.since, dayAt(E3, 2));
  const between = zoneStreak(s([0.5, 0.9, 2, 2.5]), MVRV.zones);
  assert.equal(between.zone, null);
  assert.equal(between.days, 2);
  const gap = zoneStreak(s([3.5, null, 3.6, 3.7]), MVRV.zones);
  assert.equal(gap.days, 2, 'a null breaks the streak');
  assert.equal(zoneStreak(s([null, null]), MVRV.zones), null);
});

test('cycleExtremes reads the metric at each epoch price peak and low', () => {
  const ex = cycleExtremes(synthetic(), HALVINGS);
  assert.equal(ex.length, 1);
  assert.equal(ex[0].epoch, 3);
  assert.equal(ex[0].provisional, false);
  assert.equal(ex[0].peak.day, dayAt(E3, 600));
  assert.equal(ex[0].peak.price, 20000);
  assert.ok(Math.abs(ex[0].peak.value - 4) < 1e-9);
  assert.equal(ex[0].low.day, dayAt(E3, 900));
  assert.ok(Math.abs(ex[0].low.value - 0.6) < 1e-9);
});

test('fmtValue mirrors the web formatter', () => {
  assert.equal(fmtValue(1.2345, 'ratio'), '1.23');
  assert.equal(fmtValue(81234.5, 'usd'), '$81,235');
  assert.equal(fmtValue(0.5, 'usd'), '$0.50');
  assert.equal(fmtValue(0.123, 'percent'), '12.3%');
  assert.equal(fmtValue(1.5e9, 'usd_compact'), '$1.50B');
  assert.equal(fmtValue(950, 'number', 'EH/s'), '950 EH/s');
  assert.equal(fmtValue(null, 'ratio'), '—');
});

test('takeaway states value, percentile, band tenure and prior-cycle readings; no em-dashes', () => {
  const facts = {
    asOf: '2026-09-19', value: 3.4, percentile: 0.912,
    streak: { zone: MVRV.zones[1], days: 12, since: '2026-09-08' },
    extremes: [
      { epoch: 3, provisional: false, peak: { value: 4.72 }, low: { value: 0.75 } },
      { epoch: 4, provisional: false, peak: { value: 3.96 }, low: { value: 0.81 } },
      { epoch: 5, provisional: true, peak: { value: 3.1 }, low: { value: 1.2 } },
    ],
  };
  const t = takeaway(MVRV, facts);
  assert.equal(t,
    'MVRV Ratio is 3.40 as of 09/19/2026, higher than 91% of all daily readings. '
    + 'It has sat in the "Historically elevated" band for 12 days, since 09/08/2026. '
    + 'At the last 2 cycle peaks it read 4.72, 3.96; at the lows, 0.75, 0.81.');
  assert.ok(!t.includes('—'));
  // Outside every band, one day, singular.
  const t2 = takeaway(MVRV, { ...facts, streak: { zone: null, days: 1, since: '2026-09-19' }, extremes: [] });
  assert.match(t2, /outside every marked band for 1 day\./);
  // A metric without zones and with one closed cycle says only the first sentence.
  const t3 = takeaway({ name: 'NVT Ratio', format: 'ratio', zones: [] },
    { ...facts, streak: { zone: null, days: 400, since: '2025-01-01' }, extremes: facts.extremes.slice(0, 1) });
  assert.equal(t3, 'NVT Ratio is 3.40 as of 09/19/2026, higher than 91% of all daily readings.');
});

test('buildStory assembles the facts from rows and handles an empty metric', () => {
  const rows = synthetic();
  const s = buildStory(MVRV, rows, HALVINGS);
  assert.equal(s.slug, 'mvrv');
  assert.equal(s.asOf, dayAt(E3, 1499));
  assert.ok(Math.abs(s.value - rows[1499].v) < 1e-9);
  assert.ok(s.percentile > 0 && s.percentile < 1);
  assert.equal(s.streak.zone, null, '2.28 sits between the bands');
  assert.equal(s.extremes.length, 1);
  assert.match(s.takeaway, /^MVRV Ratio is 2\.28 as of/);
  const empty = buildStory(MVRV, rows.map(r => ({ ...r, v: null })), HALVINGS);
  assert.equal(empty.value, null);
  assert.equal(empty.takeaway, '');
  // Numeric strings (Postgres numeric serialization) are coerced.
  const strs = buildStory(MVRV, rows.map(r => ({ ...r, v: String(r.v) })), HALVINGS);
  assert.ok(Math.abs(strs.value - rows[1499].v) < 1e-9);
});

test('price- and count-denominated metrics keep percentile and zones but skip cycle extremes', () => {
  const rows = synthetic();
  const usd = buildStory({ slug: 'realized-price', name: 'Realized Price', format: 'usd', zones: [] }, rows, HALVINGS);
  assert.deepEqual(usd.extremes, []);
  assert.match(usd.takeaway, /^Realized Price is \$2\.28 as of .* readings\.$/);
  const pct = buildStory({ slug: 'supply-in-profit', name: 'Supply in Profit', format: 'percent', zones: [] }, rows, HALVINGS);
  assert.equal(pct.extremes.length, 1, 'shares compare across cycles');
});
