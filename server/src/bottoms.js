// Bear-market bottom comparison.
//
// One panel per halving epoch, each re-based to "days since the cycle low" so
// the bottoms can be read side by side: BTC price, its 200-day simple moving
// average, the short-term-holder cost basis, and every day the close set a
// new all-time high. Pure functions over the daily rows; the /api/bottoms
// route in api.js supplies the rows and the HALVINGS table.
//
// Definitions (all data-driven, nothing hand-picked):
//   * The cycle low of an epoch is the trough of the epoch's deepest
//     peak-to-trough drawdown. Drawdown is measured on a centered 15-day
//     rolling MEDIAN of closes, not the raw close, so a single venue's bad
//     print (the Mt. Gox-collapse days in the Feb 2014 backfill trade at
//     ~$111 against a ~$570 market) cannot define a cycle. The exact day-0
//     is then the lowest raw close within the same 15-day neighbourhood.
//   * The peak is the highest raw close in the epoch before that low.
//   * Epochs whose deepest drawdown is under `minDrawdown` (40%) have not
//     had a bear market yet and are omitted.
//   * The current (open) epoch's low is provisional: a new lower close moves
//     it. It stays flagged until the epoch closes at the next halving.

export const DEFAULTS = {
  window: 365,       // days shown either side of the low
  minDrawdown: 0.4,  // epochs with a shallower deepest drawdown are omitted
  smoothHalf: 7,     // centered median half-width -> 15-day window
  smaDays: 200,
};

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null; // non-positive closes (pre-market) are "no price"
};

// Centered rolling median over a numeric array with nulls; a window with no
// numeric values yields null. Ends are clipped, not padded.
export function rollingMedian(vals, half) {
  const out = new Array(vals.length).fill(null);
  for (let i = 0; i < vals.length; i++) {
    const w = [];
    for (let j = Math.max(0, i - half); j <= Math.min(vals.length - 1, i + half); j++) {
      if (vals[j] !== null) w.push(vals[j]);
    }
    if (!w.length) continue;
    w.sort((a, b) => a - b);
    const m = w.length >> 1;
    out[i] = w.length % 2 ? w[m] : (w[m - 1] + w[m]) / 2;
  }
  return out;
}

// Trailing simple moving average; emitted only once a full window of
// consecutive numeric values exists, a null restarts the window (same
// semantics as web/src/sma.js so both SMAs agree wherever they overlap).
export function sma(vals, n) {
  const out = new Array(vals.length).fill(null);
  let sum = 0;
  const buf = [];
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    if (v === null) { buf.length = 0; sum = 0; continue; }
    buf.push(v); sum += v;
    if (buf.length > n) sum -= buf.shift();
    if (buf.length === n) out[i] = sum / n;
  }
  return out;
}

const dayDiff = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86400e3);

// rows: [{ day: 'YYYY-MM-DD', price, sth_cost_basis }] ascending by day, one
// row per day. halvings: [{ epoch, start }] ascending.
export function buildBottoms(rows, halvings, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const price = rows.map(r => num(r.price));
  const sth = rows.map(r => num(r.sth_cost_basis));
  const smooth = rollingMedian(price, o.smoothHalf);
  const avg = sma(price, o.smaDays);

  // All-time-high flags on the raw close.
  const ath = new Array(rows.length).fill(false);
  let max = -Infinity;
  for (let i = 0; i < rows.length; i++) {
    if (price[i] !== null && price[i] > max) { max = price[i]; ath[i] = true; }
  }

  const cycles = [];
  for (let e = 0; e < halvings.length; e++) {
    const start = halvings[e].start;
    const end = halvings[e + 1]?.start ?? null;
    let lo = rows.findIndex(r => r.day >= start);
    if (lo < 0) continue;
    let hi = end === null ? rows.length : rows.findIndex(r => r.day >= end);
    if (hi < 0) hi = rows.length;

    // Deepest drawdown of the smoothed series within the epoch.
    let runmax = null, best = { dd: -1, idx: -1 };
    for (let i = lo; i < hi; i++) {
      const s = smooth[i];
      if (s === null) continue;
      if (runmax === null || s > runmax) runmax = s;
      const dd = 1 - s / runmax;
      if (dd > best.dd) best = { dd, idx: i };
    }
    if (best.idx < 0 || best.dd < o.minDrawdown) continue;

    // Day 0: the lowest raw close in the median's neighbourhood of the trough.
    let bottom = -1;
    for (let i = Math.max(lo, best.idx - o.smoothHalf); i <= Math.min(hi - 1, best.idx + o.smoothHalf); i++) {
      if (price[i] !== null && (bottom < 0 || price[i] < price[bottom])) bottom = i;
    }
    // The peak: highest raw close in the epoch before the low.
    let peak = -1;
    for (let i = lo; i < bottom; i++) {
      if (price[i] !== null && (peak < 0 || price[i] > price[peak])) peak = i;
    }
    if (bottom < 0 || peak < 0) continue;

    // Offsets come from the calendar, not the row index, so a gap in the
    // table cannot shift a panel.
    const values = [];
    for (let i = 0; i < rows.length; i++) {
      const d = dayDiff(rows[i].day, rows[bottom].day);
      if (d < -o.window) continue;
      if (d > o.window) break;
      values.push({ d, day: rows[i].day, price: price[i], sma: avg[i], sth: sth[i], ath: ath[i] });
    }

    cycles.push({
      epoch: halvings[e].epoch,
      start, end,
      provisional: end === null,
      peak: { day: rows[peak].day, price: price[peak] },
      bottom: { day: rows[bottom].day, price: price[bottom] },
      drawdown: 1 - price[bottom] / price[peak],
      values,
    });
  }

  return {
    slug: 'bottom-comparison',
    window: o.window,
    minDrawdown: o.minDrawdown,
    smoothDays: o.smoothHalf * 2 + 1,
    smaDays: o.smaDays,
    cycles,
  };
}
