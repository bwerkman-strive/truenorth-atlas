// Pure row-shaping for the bear-market rallies chart (components/
// RalliesChart.jsx): one row per day across the whole history, with the
// price, the price again under a per-epoch key while inside that epoch's bear
// (so the segment can be drawn in the epoch's color), and the rally under a
// per-epoch key. Unit-tested under node:test without a DOM.

export const segKey = (epoch) => `p_e${epoch}`;
export const rallyKey = (epoch) => `r_e${epoch}`;

// Leading days without a positive close (the pre-market zero-fill) are
// dropped so the axis starts where the market does, whatever the scale. A
// non-positive close later in the series is kept on a linear axis and nulled
// on a log axis, which cannot draw it.
export function buildRows(payload, logScale) {
  const ok = (v) => (v === null || v === undefined ? null : (logScale && v <= 0 ? null : v));
  const start = payload.price.findIndex(pt => pt.p > 0);
  const rows = (start > 0 ? payload.price.slice(start) : payload.price).map(pt => ({ day: pt.day, p: ok(pt.p) }));
  const byDay = new Map(rows.map(r => [r.day, r]));
  for (const b of payload.bears) {
    const seg = segKey(b.epoch), rk = rallyKey(b.epoch);
    for (const pt of b.rally) {
      const row = byDay.get(pt.day);
      if (!row) continue;
      row[seg] = row.p;
      row[rk] = pt.r;
    }
  }
  return rows;
}

// "406d · +88% peak rally" (label above each bear's band)
export function bearLabel(b) {
  const pct = Math.round(b.maxRally.value * 100);
  return `${b.days}d · +${pct}% peak rally`;
}

// "2013–2015" (legend), "2011" when the bear stayed inside one year
export function bearYears(b) {
  const a = b.peak.day.slice(0, 4), z = b.through.slice(0, 4);
  return a === z ? a : `${a}–${z}`;
}

// Year ticks for the category axis: the first day of each year present.
export function yearTicks(rows) {
  const seen = new Set();
  const ticks = [];
  for (const r of rows) {
    const y = r.day.slice(0, 4);
    if (!seen.has(y)) { seen.add(y); ticks.push(r.day); }
  }
  return ticks;
}
