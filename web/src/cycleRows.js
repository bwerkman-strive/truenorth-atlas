// Pure helpers for the sprint-1 cycle charts (RunsChart, UnderwaterChart,
// ScorecardChart). Unit-tested under node:test without a DOM.

export const runKey = (epoch) => `r_e${epoch}`;

// Merge every run's values by day-since-low into one row array so the runs
// overlay on a shared numeric x-axis.
export function runRows(data) {
  const byDay = new Map();
  for (const r of data.runs ?? []) {
    const k = runKey(r.epoch);
    for (const v of r.values) {
      if (!byDay.has(v.d)) byDay.set(v.d, { d: v.d });
      byDay.get(v.d)[k] = v.m;
    }
  }
  return [...byDay.values()].sort((a, b) => a.d - b.d);
}

// "604x", "21.2x", "1.39x": precision steps down as the multiple grows.
export function fmtMultiple(m) {
  if (m === null || m === undefined || !Number.isFinite(Number(m))) return '—';
  const v = Number(m);
  if (v >= 100) return `${Math.round(v)}x`;
  if (v >= 10) return `${v.toFixed(1)}x`;
  return `${v.toFixed(2)}x`;
}

// Axis ticks read "10x", not "10.0x"; non-integer ticks fall back to fmtMultiple.
export const fmtTick = (v) => (Number.isInteger(Number(v)) ? `${Number(v)}x` : fmtMultiple(v));

// Day ticks every `step` days up to the longest run.
export function dayTicks(maxDays, step = 180) {
  const ticks = [];
  for (let d = 0; d <= maxDays; d += step) ticks.push(d);
  return ticks;
}

// Log-axis ticks for multiples, 1x up to just past the largest run.
export function logTicks(maxMultiple) {
  const candidates = [1, 2, 3, 5, 10, 20, 50, 100, 200, 500, 1000, 2000];
  const top = Math.max(1, Number(maxMultiple) || 1);
  const ticks = candidates.filter(t => t <= top);
  const next = candidates.find(t => t > top);
  if (next) ticks.push(next);
  return ticks;
}

// "-34.9%" for a drawdown (always at most zero), "0.0%" at a new high.
export const fmtDrawdown = (dd, digits = 1) => `${(dd * 100).toFixed(digits)}%`;
