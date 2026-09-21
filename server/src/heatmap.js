// Cost Basis Heatmap: the daily cost-basis distribution (metrics_daily.urpd)
// laid out over time on a fixed logarithmic price grid.
//
// The stored distribution buckets the live UTXO set by creation-day close
// into 100 uniform bins from $0 up to the highest close so far, so the bin
// width grows with the all-time high and the low end loses resolution as the
// years pass. To draw one picture across 16 years, each sampled day's bins
// are re-mapped onto a shared log grid by linear overlap. The lowest bin,
// [0, width), holds everything acquired below one bin width, including the
// pre-market coins whose creation-day close is zero; its levels are not
// resolved, so it travels separately as `floor` and is drawn as a muted band.
//
// Pure functions over sampled rows; the /api/heatmap route supplies the rows
// (Sundays plus the latest day) and memoizes the result per finalized day.

export const DEFAULTS = {
  rows: 160,        // log grid rows
  minPrice: 0.05,   // bottom edge of the grid, below the first market closes
  headroom: 1.1,    // grid top = highest close seen * headroom
};

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// n+1 geometric edges from min to max.
export function logLevels(min, max, n) {
  const a = Math.log(min), b = Math.log(max);
  return Array.from({ length: n + 1 }, (_, i) => Math.exp(a + (b - a) * (i / n)));
}

// One day's buckets onto the grid. Bucket [p, p+width) with supply v is
// spread across the grid rows in proportion to linear price overlap; the
// [0, width) bucket goes to `floor`.
export function rebin(urpd, levels) {
  const n = levels.length - 1;
  const cells = new Array(n).fill(0);
  let floor = 0;
  const width = num(urpd?.width) ?? 0;
  for (const b of urpd?.buckets ?? []) {
    const p = num(b.p), v = num(b.v);
    if (p === null || v === null || v <= 0) continue;
    if (p <= 0) { floor += v; continue; }
    const lo = p, hi = p + width;
    if (hi <= lo) continue;
    // Rows overlapping [lo, hi): binary-search the first edge above lo.
    let i = 0, j = n;
    while (i < j) { const m = (i + j) >> 1; if (levels[m + 1] <= lo) i = m + 1; else j = m; }
    for (; i < n && levels[i] < hi; i++) {
      const overlap = Math.min(hi, levels[i + 1]) - Math.max(lo, levels[i]);
      if (overlap > 0) cells[i] += v * (overlap / (hi - lo));
    }
  }
  return { cells, floor, width };
}

// The densest price ranges in one column: rows at or above `share` of the
// column's peak row, merged when adjacent, largest first.
export function topClusters(cells, levels, { k = 2, share = 0.7 } = {}) {
  const max = Math.max(0, ...cells);
  if (max <= 0) return [];
  const out = [];
  let cur = null;
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] >= max * share) {
      if (cur && cur.toIdx === i - 1) { cur.toIdx = i; cur.btc += cells[i]; }
      else { if (cur) out.push(cur); cur = { fromIdx: i, toIdx: i, btc: cells[i] }; }
    }
  }
  if (cur) out.push(cur);
  return out.sort((a, b) => b.btc - a.btc).slice(0, k)
    .map(c => ({ from: levels[c.fromIdx], to: levels[c.toIdx + 1], btc: Math.round(c.btc) }));
}

// rows: [{ day, price, urpd, supply_profit_pct }] ascending, already sampled.
export function buildHeatmap(rows, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const priced = rows.filter(r => r.urpd && num(r.price) !== null);
  if (!priced.length) return { slug: 'cost-basis-heatmap', levels: [], columns: [], latest: null, maxCell: 0 };
  const top = Math.max(...priced.map(r => num(r.urpd.top) ?? num(r.price)));
  const levels = logLevels(o.minPrice, top * o.headroom, o.rows);
  let maxCell = 0;
  const columns = priced.map(r => {
    const { cells, floor, width } = rebin(r.urpd, levels);
    for (const c of cells) if (c > maxCell) maxCell = c;
    return {
      day: r.day,
      price: num(r.price),
      width: Number(width.toFixed(2)),
      floor: Math.round(floor),
      cells: cells.map(c => Math.round(c)),
    };
  });
  const lastRow = priced[priced.length - 1];
  const last = columns[columns.length - 1];
  const latest = {
    day: last.day,
    price: last.price,
    width: last.width,
    floor: last.floor,
    inProfit: num(lastRow.supply_profit_pct),
    // Where the cluster sits against the close: wholly above it, wholly
    // below it, or straddling it.
    clusters: topClusters(last.cells, levels).map(c => ({
      ...c, position: c.from > last.price ? 'underwater' : c.to < last.price ? 'in profit' : 'straddling the close',
    })),
  };
  return {
    slug: 'cost-basis-heatmap',
    levels: levels.map(l => Number(l.toPrecision(6))),
    columns,
    latest,
    maxCell: Math.round(maxCell),
  };
}
