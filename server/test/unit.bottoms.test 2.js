// Pure-function coverage for the bear-market bottom comparison (bottoms.js):
// the drawdown-trough definition, its robustness to single-venue bad prints,
// provisional flagging of the open epoch, and the panel row shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBottoms, rollingMedian, sma, DEFAULTS } from '../src/bottoms.js';

const E3 = '2016-07-09', E4 = '2020-04-19';
const dayAt = (start, i) => new Date(Date.parse(start) + i * 86400e3).toISOString().slice(0, 10);

// A stylised cycle inside epoch 3: 600 -> 20,000 over days 0..600, down to
// 3,000 by day 900, back to 10,000 by day 1400 (which crosses into epoch 4 at
// day 1380, where price only rises so epoch 4 has no bear market yet).
function synthetic({ days = 1500, mutate } = {}) {
  const rows = [];
  for (let i = 0; i < days; i++) {
    let price;
    if (i <= 600) price = 600 + (20000 - 600) * (i / 600);
    else if (i <= 900) price = 20000 - (20000 - 3000) * ((i - 600) / 300);
    else price = 3000 + (10000 - 3000) * ((i - 900) / 500);
    rows.push({ day: dayAt(E3, i), price, sth_cost_basis: price * 0.9 });
  }
  if (mutate) mutate(rows);
  return rows;
}
const HALVINGS = [{ epoch: 3, start: E3 }, { epoch: 4, start: E4 }];

test('rollingMedian: centered, clipped at the ends, nulls ignored', () => {
  assert.deepEqual(rollingMedian([1, 2, 3, 4, 5], 1), [1.5, 2, 3, 4, 4.5]);
  assert.deepEqual(rollingMedian([1, null, 3], 1), [1, 2, 3]);
  assert.deepEqual(rollingMedian([null, null], 1), [null, null]);
  // Even-sized window averages the two middle values.
  assert.deepEqual(rollingMedian([1, 100, 2, 3], 1)[3], 2.5);
});

test('sma: full trailing window only, a null restarts it (matches web/src/sma.js)', () => {
  assert.deepEqual(sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
  assert.deepEqual(sma([1, 2, null, 4, 6], 2), [null, 1.5, null, null, 5]);
});

test('finds the epoch cycle low, its peak, drawdown, and a 731-row window', () => {
  const out = buildBottoms(synthetic(), HALVINGS);
  assert.equal(out.slug, 'bottom-comparison');
  assert.equal(out.window, 365);
  assert.equal(out.smoothDays, 15);
  assert.equal(out.smaDays, 200);
  assert.equal(out.cycles.length, 1, 'epoch 4 (rising only) is omitted');
  const c = out.cycles[0];
  assert.equal(c.epoch, 3);
  assert.equal(c.start, E3);
  assert.equal(c.end, E4);
  assert.equal(c.provisional, false);
  assert.equal(c.bottom.day, dayAt(E3, 900));
  assert.equal(c.bottom.price, 3000);
  assert.equal(c.peak.day, dayAt(E3, 600));
  assert.equal(c.peak.price, 20000);
  assert.ok(Math.abs(c.drawdown - 0.85) < 1e-9);
  assert.equal(c.values.length, 731);
  assert.equal(c.values[0].d, -365);
  assert.equal(c.values[0].day, dayAt(E3, 535));
  assert.equal(c.values[730].d, 365);
  const zero = c.values.find(v => v.d === 0);
  assert.equal(zero.price, 3000);
  assert.ok(Math.abs(zero.sth - 2700) < 1e-9);
  // 200-day SMA is present throughout the window (day 535 has 200 days of history).
  assert.ok(c.values.every(v => v.sma !== null));
  // Trailing mean of a falling series sits above price at the low.
  assert.ok(zero.sma > zero.price);
});

test('all-time-high days are flagged only while the close is making new highs', () => {
  const c = buildBottoms(synthetic(), HALVINGS).cycles[0];
  const rising = c.values.filter(v => v.d <= -300); // days 535..600: every close a new high
  assert.ok(rising.length > 0 && rising.every(v => v.ath === true));
  assert.ok(c.values.filter(v => v.d > -300).every(v => v.ath === false));
});

test('a two-day bad print deeper than the real low does not define the cycle', () => {
  // The Feb 2014 Mt. Gox prints: a couple of days at a fraction of the market.
  const rows = synthetic({ mutate: (r) => { r[700].price = 100; r[701].price = 110; } });
  const c = buildBottoms(rows, HALVINGS).cycles[0];
  assert.equal(c.bottom.day, dayAt(E3, 900), 'median smoothing ignores the print');
  assert.equal(c.bottom.price, 3000);
  // ...but the neighbourhood snap still picks the true lowest raw close when
  // the print sits next to the real trough.
  const rows2 = synthetic({ mutate: (r) => { r[897].price = 2900; } });
  const c2 = buildBottoms(rows2, HALVINGS).cycles[0];
  assert.equal(c2.bottom.day, dayAt(E3, 897));
  assert.equal(c2.bottom.price, 2900);
});

test('the open epoch is provisional and its window ends at the data', () => {
  const rows = synthetic({ days: 1000 }); // data stops 100 days after the low
  const out = buildBottoms(rows, [{ epoch: 3, start: E3 }]);
  const c = out.cycles[0];
  assert.equal(c.provisional, true);
  assert.equal(c.end, null);
  assert.equal(c.values[c.values.length - 1].d, 99);
  assert.equal(c.values.length, 365 + 100);
});

test('epochs whose deepest drawdown is under the floor are omitted', () => {
  const rows = [];
  for (let i = 0; i < 800; i++) {
    const price = i < 400 ? 1000 + i : 1400 - (i - 400) * 0.5; // -14% at most
    rows.push({ day: dayAt(E3, i), price, sth_cost_basis: price });
  }
  assert.equal(buildBottoms(rows, HALVINGS).cycles.length, 0);
  assert.equal(buildBottoms(rows, HALVINGS, { minDrawdown: 0.1 }).cycles.length, 1);
  assert.equal(DEFAULTS.minDrawdown, 0.4);
});

test('pre-market zero closes are not prices: never a peak, never an ATH, never the low', () => {
  const rows = synthetic({ mutate: (r) => { for (let i = 0; i < 100; i++) r[i].price = 0; } });
  const c = buildBottoms(rows, HALVINGS).cycles[0];
  assert.equal(c.bottom.day, dayAt(E3, 900));
  assert.equal(c.peak.price, 20000);
  // Numeric strings (Postgres numeric serialization) are coerced.
  const strRows = synthetic().map(r => ({ ...r, price: String(r.price), sth_cost_basis: String(r.sth_cost_basis) }));
  assert.equal(buildBottoms(strRows, HALVINGS).cycles[0].bottom.price, 3000);
});

test('day offsets come from the calendar, so a missing row cannot shift a panel', () => {
  const rows = synthetic().filter((_, i) => i !== 890); // one day missing before the low
  const c = buildBottoms(rows, HALVINGS).cycles[0];
  assert.equal(c.bottom.day, dayAt(E3, 900));
  assert.equal(c.values.find(v => v.day === dayAt(E3, 889)).d, -11);
  assert.equal(c.values.find(v => v.day === dayAt(E3, 891)).d, -9);
  assert.equal(c.values.length, 730);
});
