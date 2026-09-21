// Pure-function coverage for the bear-market rallies (bottoms.js buildRallies
// on the shared findCycles detector) and the price-quality register.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRallies, findCycles } from '../src/bottoms.js';
import { BAD_CLOSE_WINDOWS, isFlaggedClose } from '../src/priceQuality.js';

const E3 = '2016-07-09', E4 = '2020-04-19';
const dayAt = (start, i) => new Date(Date.parse(start) + i * 86400e3).toISOString().slice(0, 10);
const HALVINGS = [{ epoch: 3, start: E3 }, { epoch: 4, start: E4 }];

// Epoch-3 cycle with one bear-market rally: 600 -> 20,000 (days 0..600),
// down to 10,000 (600..700), bounce to 15,000 (700..720), down to 3,000
// (720..900), recovery to 10,000 (900..1400).
function synthetic({ days = 1500, mutate } = {}) {
  const lerp = (a, b, t) => a + (b - a) * t;
  const rows = [];
  for (let i = 0; i < days; i++) {
    let price;
    if (i <= 600) price = lerp(600, 20000, i / 600);
    else if (i <= 700) price = lerp(20000, 10000, (i - 600) / 100);
    else if (i <= 720) price = lerp(10000, 15000, (i - 700) / 20);
    else if (i <= 900) price = lerp(15000, 3000, (i - 720) / 180);
    else price = lerp(3000, 10000, (i - 900) / 500);
    rows.push({ day: dayAt(E3, i), price });
  }
  if (mutate) mutate(rows);
  return rows;
}

test('findCycles is the shared detector: same peak, low and drawdown the bottoms use', () => {
  const { cycles, price } = findCycles(synthetic(), HALVINGS);
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].epoch, 3);
  assert.equal(price[cycles[0].peak], 20000);
  assert.equal(price[cycles[0].bottom], 3000);
  assert.ok(Math.abs(cycles[0].drawdown - 0.85) < 1e-9);
});

test('a bear runs peak to low; each day rallies off the running low; the biggest is labeled', () => {
  const out = buildRallies(synthetic(), HALVINGS, { excluded: [] });
  assert.equal(out.slug, 'bear-rallies');
  assert.equal(out.price.length, 1500);
  assert.deepEqual(Object.keys(out.price[0]).sort(), ['day', 'p']);
  assert.equal(out.bears.length, 1, 'epoch 4 only rises and has no bear');
  const b = out.bears[0];
  assert.equal(b.epoch, 3);
  assert.equal(b.ongoing, false);
  assert.equal(b.peak.day, dayAt(E3, 600));
  assert.equal(b.low.day, dayAt(E3, 900));
  assert.equal(b.through, dayAt(E3, 900), 'a closed bear ends at its low');
  assert.equal(b.days, 300);
  assert.equal(b.current, null);
  assert.equal(b.rally.length, 301);
  assert.equal(b.rally[0].r, 0, 'the peak day is its own running low');
  assert.equal(b.rally[b.rally.length - 1].r, 0, 'the low is a new running low');
  assert.ok(Math.abs(b.maxRally.value - 0.5) < 1e-9, '15,000 off a 10,000 running low');
  assert.equal(b.maxRally.day, dayAt(E3, 720));
  // Rally never counts the pre-bear run-up: day 650 sits 25% below the peak, rally 0.
  assert.equal(b.rally.find(x => x.day === dayAt(E3, 650)).r, 0);
});

test('the open epoch\'s bear runs to the latest day and reports its rally to date', () => {
  const out = buildRallies(synthetic({ days: 721 }), [{ epoch: 3, start: E3 }], { excluded: [] });
  const b = out.bears[0];
  assert.equal(b.ongoing, true);
  assert.equal(b.through, dayAt(E3, 720));
  assert.equal(b.days, 120);
  assert.ok(Math.abs(b.current - 0.5) < 1e-9);
  assert.ok(Math.abs(b.maxRally.value - 0.5) < 1e-9);
});

test('closes inside a flagged window are left out of the running low and drawn as a gap', () => {
  const rows = synthetic({ mutate: (r) => { r[655].price = 100; r[656].price = 120; } }); // a venue glitch
  const naive = buildRallies(rows, HALVINGS, { excluded: [] }).bears[0];
  assert.ok(naive.maxRally.value > 100, 'without the register the glitch fakes a >10,000% rally');
  const win = [{ from: dayAt(E3, 654), to: dayAt(E3, 657), reason: 'test glitch' }];
  const guarded = buildRallies(rows, HALVINGS, { excluded: win }).bears[0];
  assert.ok(Math.abs(guarded.maxRally.value - 0.5) < 1e-9);
  assert.equal(guarded.rally.find(x => x.day === dayAt(E3, 655)).r, null, 'gap, not zero');
  assert.equal(guarded.rally.length, 301, 'flagged days stay in the series as gaps');
  assert.deepEqual(buildRallies(rows, HALVINGS, { excluded: win }).excluded, win);
});

test('the default register is the Feb 2014 Mt. Gox stretch, and only that', () => {
  assert.equal(BAD_CLOSE_WINDOWS.length, 1);
  const w = BAD_CLOSE_WINDOWS[0];
  assert.equal(w.from, '2014-02-05');
  assert.equal(w.to, '2014-02-27');
  assert.ok(w.reason.length > 20);
  assert.equal(isFlaggedClose('2014-02-21'), true);
  assert.equal(isFlaggedClose('2014-02-04'), false);
  assert.equal(isFlaggedClose('2014-02-28'), false);
  assert.deepEqual(buildRallies(synthetic(), HALVINGS).excluded, BAD_CLOSE_WINDOWS);
});

test('numeric strings and pre-market zeros are handled like the bottoms', () => {
  const rows = synthetic({ mutate: (r) => { for (let i = 0; i < 50; i++) r[i].price = 0; } })
    .map(r => ({ ...r, price: String(r.price) }));
  const out = buildRallies(rows, HALVINGS, { excluded: [] });
  assert.equal(out.price[0].p, null);
  assert.equal(out.price[600].p, 20000);
  assert.equal(out.bears[0].maxRally.day, dayAt(E3, 720));
});
