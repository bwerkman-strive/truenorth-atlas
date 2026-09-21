import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nearestDay, buildMarks } from '../src/storyMarks.js';

const days = ['2024-01-01', '2024-01-08', '2024-01-15', '2024-01-22'];
const rows = days.map(d => ({ day: d }));
const story = {
  asOf: '2024-01-22', value: 2.5, percentile: 0.6,
  extremes: [
    { epoch: 4, provisional: false, peak: { day: '2024-01-09', value: 4 }, low: { day: '2023-12-01', value: 0.5 } },
    { epoch: 5, provisional: true, peak: { day: '2024-01-16', value: 3 }, low: { day: '2024-01-22', value: 0 } },
  ],
};

test('nearestDay snaps to the closest drawn day', () => {
  assert.equal(nearestDay(days, '2024-01-09'), '2024-01-08');
  assert.equal(nearestDay(days, '2024-01-12'), '2024-01-15');
  assert.equal(nearestDay(days, '2023-01-01'), '2024-01-01');
  assert.equal(nearestDay(days, '2025-01-01'), '2024-01-22');
  assert.equal(nearestDay([], '2024-01-01'), null);
});

test('buildMarks places cycle extremes and the current callout on drawn days, in display units', () => {
  const marks = buildMarks(story, rows, { format: 'ratio' });
  const byKey = Object.fromEntries(marks.map(m => [m.key, m]));
  assert.equal(byKey['peak-4'].x, '2024-01-08', 'snapped');
  assert.equal(byKey['peak-4'].y, 4);
  assert.equal(byKey['peak-4'].text, '▲ 4.00');
  assert.equal(byKey['low-4'], undefined, 'outside the drawn range');
  assert.equal(byKey['low-5'], undefined, 'the open epoch\'s low to date is not a cycle low');
  assert.equal(byKey['peak-5'].text, '▲ 3.00');
  assert.equal(byKey.now.x, '2024-01-22');
  assert.equal(byKey.now.text, '2.50');
  assert.equal(marks.length, 3);
});

test('buildMarks honors the log axis, the time axis, and unit scaling', () => {
  const closedZero = { ...story, extremes: [{ epoch: 4, provisional: false, peak: { day: '2024-01-09', value: 4 }, low: { day: '2024-01-15', value: 0 } }] };
  assert.ok(buildMarks(closedZero, rows, { format: 'ratio' }).some(m => m.key === 'low-4'));
  const log = buildMarks(closedZero, rows, { format: 'ratio', logScale: true });
  assert.ok(!log.some(m => m.key === 'low-4'), 'zero cannot be drawn on a log axis');
  const time = buildMarks(story, rows, { format: 'ratio', timeAxis: true });
  assert.equal(time.find(m => m.key === 'now').x, Date.parse('2024-01-22'));
  const scaled = buildMarks(story, rows, { format: 'number', unit: 'ZH/s', unitFactor: 0.001 });
  assert.equal(scaled.find(m => m.key === 'peak-4').y, 0.004);
  assert.equal(scaled.find(m => m.key === 'peak-4').text, '▲ 0.00 ZH/s');
  assert.deepEqual(buildMarks(null, rows, {}), []);
  assert.deepEqual(buildMarks(story, [], {}), []);
});
