// Pure row-shaping for the bear-market bottoms panels (see
// components/BottomsChart.jsx). Lives outside the component so the band
// arithmetic is unit-testable under node:test without a DOM.

// Recharts draws a range Area from a dataKey that yields [low, high]. The gap
// between the 200-day SMA and the STH cost basis is split by sign so it can
// carry polarity: `bear` when the SMA sits above the cohort's cost basis
// (trend below what recent buyers paid), `bull` when it sits below. On a log
// axis non-positive values cannot be drawn, so they become null.
export function panelRows(values, logScale) {
  const ok = (v) => (v === null || v === undefined ? null : (logScale && v <= 0 ? null : v));
  return values.map(v => {
    const price = ok(v.price), sma = ok(v.sma), sth = ok(v.sth);
    let bear = null, bull = null;
    if (sma !== null && sth !== null) {
      if (sma >= sth) bear = [sth, sma]; else bull = [sma, sth];
    }
    // ATH days ride on the shared rows as a sparse column (the close on the
    // days it set a new all-time high, null otherwise). A series with its own
    // data array would make recharts derive the axes from that array alone.
    const ath = v.ath && price !== null && price > 0 ? price : null;
    return { d: v.d, day: v.day, price, sma, sth, bear, bull, ath };
  });
}

// Shared x ticks: every 90 days out from the low, plus the window edges.
export function windowTicks(window, step = 90) {
  const t = new Set([0, -window, window]);
  // A step tick that would crowd the edge label is dropped (365 vs 360).
  for (let d = step; window - d >= step / 2; d += step) { t.add(d); t.add(-d); }
  return [...t].sort((a, b) => a - b);
}

// "Day −120" / "Day 0 (the low)" / "Day +45"
export function dayLabel(d) {
  if (d === 0) return 'Day 0 (the low)';
  return `Day ${d < 0 ? '−' : '+'}${Math.abs(d)}`;
}
