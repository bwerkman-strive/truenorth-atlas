import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runRows, runKey, fmtMultiple, fmtTick, logTicks, dayTicks, fmtDrawdown } from '../src/cycleRows.js';
import { PANEL_KINDS } from '../src/kinds.js';
import { PANEL_KINDS as SERVER_PANEL_KINDS } from '../../server/src/catalog.js';
import { runsHeadline, underwaterHeadline, scorecardHeadline, ralliesHeadline, bottomsHeadline } from '../src/panelHeadlines.js';

test('the web panel-kind list mirrors the server catalog', () => {
  assert.deepEqual(PANEL_KINDS, SERVER_PANEL_KINDS);
});

test('runRows merges every run by days since its low', () => {
  const data = { runs: [
    { epoch: 3, values: [{ d: 0, m: 1 }, { d: 1, m: 1.2 }] },
    { epoch: 4, values: [{ d: 0, m: 1 }, { d: 2, m: 1.5 }] },
  ] };
  const rows = runRows(data);
  assert.deepEqual(rows.map(r => r.d), [0, 1, 2]);
  assert.equal(rows[0][runKey(3)], 1);
  assert.equal(rows[1][runKey(3)], 1.2);
  assert.equal(rows[1][runKey(4)], undefined);
  assert.equal(rows[2][runKey(4)], 1.5);
});

test('fmtMultiple steps precision down as multiples grow; logTicks climbs just past the max', () => {
  assert.equal(fmtMultiple(603.68), '604x');
  assert.equal(fmtMultiple(21.22), '21.2x');
  assert.equal(fmtMultiple(1.3868), '1.39x');
  assert.equal(fmtMultiple(null), '—');
  assert.deepEqual(logTicks(7.9), [1, 2, 3, 5, 10]);
  assert.deepEqual(logTicks(604), [1, 2, 3, 5, 10, 20, 50, 100, 200, 500, 1000]);
  assert.deepEqual(logTicks(0), [1, 2]);
  assert.equal(fmtTick(10), '10x');
  assert.equal(fmtTick(2.5), '2.50x');
  assert.deepEqual(dayTicks(400), [0, 180, 360]);
  assert.equal(fmtDrawdown(-0.3493), '-34.9%');
  assert.equal(fmtDrawdown(0), '0.0%');
});

const runsData = {
  runs: [
    { epoch: 4, ongoing: false, provisional: false, low: { day: '2022-11-21' }, peak: { day: '2025-10-06' }, through: '2025-10-06', days: 1050, multiple: 7.9136, current: null, values: [] },
    { epoch: 5, ongoing: true, provisional: true, low: { day: '2026-06-30' }, peak: null, through: '2026-09-20', days: 82, multiple: null, current: 1.3868, values: [] },
  ],
  today: { epoch: 5, d: 82, m: 1.3868, atDay: [{ epoch: 4, m: 1.3873 }] },
};

test('runsHeadline states the live run and where the earlier ones stood that day', () => {
  const h = runsHeadline(runsData);
  assert.equal(h.value, '1.39x');
  assert.equal(h.sub, 'day 82 off the 06/30/2026 low (provisional)');
  assert.equal(h.takeaway,
    'Day 82 off the 06/30/2026 low: 1.39x. On day 82, the earlier runs stood at 1.39x. Those runs ended at 7.91x after 1050 days.');
  assert.equal(h.asOf, '2026-09-20');
  assert.equal(runsHeadline({ runs: [] }), null);
});

test('underwaterHeadline states depth, day count, the shares and the completed bears', () => {
  const h = underwaterHeadline({
    current: { day: '2026-09-20', dd: -0.3493, ath: { day: '2025-10-06', price: 124720 }, sinceAth: 349 },
    share: { below30: 0.6883, below50: 0.4822, below80: 0.087 },
    bears: [{ epoch: 4, ongoing: false, depth: -0.7667 }, { epoch: 5, ongoing: true, depth: -0.5308 }],
  });
  assert.equal(h.value, '-34.9%');
  assert.equal(h.sub, 'below the 10/06/2025 high, day 349');
  assert.equal(h.takeaway,
    'Bitcoin closed 34.9% below its 10/06/2025 high on 09/20/2026, day 349 since the high. '
    + 'It has spent 69% of all days at least 30% under its high, 48% at least 50% under, and 9% at least 80% under. '
    + 'Completed bears fell 77%.');
  const ath = underwaterHeadline({ current: { day: '2026-09-21', dd: 0, ath: { day: '2026-09-21' }, sinceAth: 0 }, share: null, bears: [] });
  assert.equal(ath.value, '0.0%');
  assert.equal(ath.takeaway, 'Bitcoin closed at a new all-time high on 09/21/2026.');
});

test('scorecardHeadline summarises the completed bears and the open epoch', () => {
  const h = scorecardHeadline({ asOf: '2026-09-20', cycles: [
    { epoch: 3, provisional: false, drawdown: 0.8356, bearDays: 364, bearRally: 0.6654 },
    { epoch: 4, provisional: false, drawdown: 0.7667, bearDays: 378, bearRally: 0.3529 },
    { epoch: 5, provisional: true, drawdown: 0.5308, bearDays: 349, bearRally: 0.3886 },
  ] });
  assert.equal(h.value, '3 cycles');
  assert.equal(h.sub, '2 completed, epoch 5 provisional · as of 09/20/2026');
  assert.equal(h.takeaway,
    '2 completed bears fell 77% to 84% over 364 to 378 days, with rallies of 35% to 67% inside them. '
    + 'Epoch 5 is down 53% at day 349 with a 39% rally to date.');
  assert.equal(scorecardHeadline({ cycles: [] }), null);
});

test('bottoms and rallies headlines moved here unchanged', () => {
  const b = bottomsHeadline({ cycles: [{ epoch: 5, provisional: true, bottom: { day: '2026-06-30', price: 58523.93 }, peak: { day: '2025-10-06' }, drawdown: 0.5308, values: [{ day: '2026-09-19' }] }] });
  assert.equal(b.value, '$58,524');
  assert.match(b.takeaway, /^Epoch 5 low to date \$58,524 on 06\/30\/2026, 53% below the 10\/06\/2025 peak \(provisional\)\.$/);
  assert.equal(b.asOf, '2026-09-19');
  const r = ralliesHeadline({ bears: [
    { epoch: 4, ongoing: false, maxRally: { value: 0.3529 }, through: '2022-11-21' },
    { epoch: 5, ongoing: true, current: 0.388, days: 348, low: { day: '2026-06-30' }, through: '2026-09-19' },
  ] });
  assert.equal(r.value, '+38.8%');
  assert.match(r.takeaway, /Largest rallies of the prior bears: \+35%\.$/);
  assert.equal(bottomsHeadline({ cycles: [] }), null);
});
