// Pure placement for the story layer's chart annotations (pages/
// MetricDetail.jsx): the current-value callout and the readings at each
// cycle peak and low, snapped onto the rows the chart is actually drawing.
// Unit-tested under node:test without a DOM.

import { fmt } from './format.js';

// Rows are day-sorted; the series fetch is range-limited and downsampled, so
// an annotation's exact day may not be a category on the axis. Snap to the
// nearest drawn day (a few days off at most on a 15-year chart).
export function nearestDay(days, day) {
  if (!days.length) return null;
  let lo = 0, hi = days.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (days[mid] < day) lo = mid + 1; else hi = mid;
  }
  if (lo > 0 && Math.abs(Date.parse(days[lo - 1]) - Date.parse(day)) < Math.abs(Date.parse(days[lo]) - Date.parse(day))) lo--;
  return days[lo];
}

// -> [{ key, kind: 'peak' | 'low' | 'now', x, y, text, epoch? }]
//   x is the axis category (day) or the numeric time when the chart uses a
//   time axis; y is in display units (unitFactor applied). Non-positive
//   values are skipped on a log axis, and anything outside the drawn range.
export function buildMarks(story, rows, { format, unit, timeAxis = false, logScale = false, unitFactor = 1 } = {}) {
  if (!story || !rows?.length) return [];
  const days = rows.map(r => r.day);
  const first = days[0], last = days[days.length - 1];
  const x = (day) => (timeAxis ? Date.parse(day) : day);
  const show = (v) => (v !== null && v !== undefined && !(logScale && v <= 0));
  const label = (v) => fmt(v * unitFactor, format, unit);
  const marks = [];
  for (const e of story.extremes ?? []) {
    for (const [kind, pt] of [['peak', e.peak], ['low', e.low]]) {
      // The open epoch's low is only a low to date; it is not marked.
      if (kind === 'low' && e.provisional) continue;
      if (!pt || !show(pt.value) || pt.day < first || pt.day > last) continue;
      marks.push({
        key: `${kind}-${e.epoch}`, kind, epoch: e.epoch,
        x: x(nearestDay(days, pt.day)), y: pt.value * unitFactor,
        text: `${kind === 'peak' ? '▲' : '▼'} ${label(pt.value)}`,
      });
    }
  }
  // The callout is the value alone: the percentile lives in the takeaway and
  // the gauge, and a longer label collides with the last peak's marker.
  if (show(story.value) && story.asOf >= first && story.asOf <= last) {
    marks.push({ key: 'now', kind: 'now', x: x(nearestDay(days, story.asOf)), y: story.value * unitFactor, text: label(story.value) });
  }
  return marks;
}
