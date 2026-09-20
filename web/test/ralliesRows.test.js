import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRows, segKey, rallyKey, bearLabel, bearYears, yearTicks } from '../src/ralliesRows.js';

const payload = {
  price: [
    { day: '2010-07-15', p: null }, { day: '2010-07-16', p: 0 },
    { day: '2010-07-17', p: 0.05 }, { day: '2010-07-18', p: 0.07 }, { day: '2010-07-19', p: 0.06 },
  ],
  bears: [{
    epoch: 1, ongoing: false, days: 2,
    peak: { day: '2010-07-18', price: 0.07 }, low: { day: '2010-07-19', price: 0.06 }, through: '2010-07-19',
    maxRally: { value: 0.123, day: '2010-07-18' },
    rally: [{ day: '2010-07-18', r: 0 }, { day: '2010-07-19', r: null }, { day: '2099-01-01', r: 1 }],
  }],
};

test('buildRows drops the leading no-price days and keys bear segments and rallies by epoch', () => {
  const rows = buildRows(payload, true);
  assert.equal(rows[0].day, '2010-07-17', 'axis starts at the first positive close');
  assert.equal(rows.length, 3);
  const d18 = rows.find(r => r.day === '2010-07-18');
  assert.equal(d18[segKey(1)], 0.07, 'segment repeats the close inside the bear');
  assert.equal(d18[rallyKey(1)], 0);
  assert.equal(rows[0][segKey(1)], undefined, 'no segment outside the bear');
  assert.equal(rows.find(r => r.day === '2010-07-19')[rallyKey(1)], null, 'flagged gap survives as null');
});

test('buildRows drops leading zeros on both scales; a later zero stays on linear and nulls on log', () => {
  assert.equal(buildRows(payload, false)[0].day, '2010-07-17');
  const later = { ...payload, price: [{ day: '2010-07-17', p: 1 }, { day: '2010-07-18', p: 0 }, { day: '2010-07-19', p: 2 }] };
  assert.equal(buildRows(later, false)[1].p, 0);
  assert.equal(buildRows(later, true)[1].p, null);
});

test('labels: duration with the peak rally, years spanned, and one tick per year', () => {
  assert.equal(bearLabel(payload.bears[0]), '2d · +12% peak rally');
  assert.equal(bearYears(payload.bears[0]), '2010');
  assert.equal(bearYears({ peak: { day: '2013-12-04' }, through: '2015-01-14' }), '2013–2015');
  assert.deepEqual(yearTicks([{ day: '2010-07-17' }, { day: '2010-12-31' }, { day: '2011-01-01' }, { day: '2011-06-01' }]),
    ['2010-07-17', '2011-01-01']);
});
