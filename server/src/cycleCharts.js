// Cycle charts built on the shared detector (bottoms.js findCycles):
//
//   buildRuns        Bull Run Comparison: each recovery from a cycle low to the
//                    next cycle's peak, as a multiple of the low, aligned on
//                    days since the low. The run out of the open epoch's low
//                    is provisional and runs to the latest day.
//   buildUnderwater  Drawdown from the all-time high, every day, with each
//                    bear's depth, length and recovery, and the share of days
//                    spent below given depths.
//   buildScorecard   One row per epoch: peak, low, drawdown, bear length,
//                    biggest bear rally, MVRV at the peak and the low, supply in
//                    profit at the low, halving-to-peak days, and the run out of
//                    the low.
//
// Pure functions over daily rows; the /api routes supply rows and HALVINGS.
// Closes inside flagged data-quality windows (priceQuality.js) are left out
// of the drawdown series as gaps, exactly as the rallies do.

import { findCycles, buildRallies } from './bottoms.js';
import { BAD_CLOSE_WINDOWS, isFlaggedClose } from './priceQuality.js';

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const dayDiff = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86400e3);
const round = (v, places) => (v === null ? null : Number(v.toFixed(places)));
const lastPriced = (price) => { for (let i = price.length - 1; i >= 0; i--) if (price[i] !== null) return i; return -1; };

export function buildRuns(rows, halvings, opts = {}) {
  const { price, cycles } = findCycles(rows, halvings, opts);
  const runs = [];
  for (let i = 0; i < cycles.length; i++) {
    const c = cycles[i], next = cycles[i + 1];
    const start = c.bottom;
    const end = next ? next.peak : lastPriced(price);
    if (end <= start) continue;
    const low = price[start];
    const values = [];
    let top = -1;
    for (let j = start; j <= end; j++) {
      if (price[j] === null) continue;
      values.push({ d: dayDiff(rows[j].day, rows[start].day), day: rows[j].day, m: round(price[j] / low, 4) });
      if (top < 0 || price[j] > price[top]) top = j;
    }
    const last = values[values.length - 1];
    const ongoing = !next;
    runs.push({
      epoch: c.epoch,
      ongoing,
      provisional: c.provisional,
      low: { day: rows[start].day, price: low },
      peak: ongoing ? null : { day: rows[top].day, price: price[top] },
      through: rows[end].day,
      days: last.d,
      multiple: ongoing ? null : round(price[top] / low, 4),
      current: ongoing ? last.m : null,
      values,
    });
  }
  const live = runs.find(r => r.ongoing) ?? null;
  // Where the completed runs stood on the live run's current day.
  const atDay = live
    ? runs.filter(r => !r.ongoing).map(r => ({ epoch: r.epoch, m: r.values.find(v => v.d === live.days)?.m ?? null }))
    : [];
  return {
    slug: 'bull-run-comparison',
    runs,
    today: live ? { epoch: live.epoch, d: live.days, m: live.current, atDay } : null,
  };
}

export function buildUnderwater(rows, halvings, opts = {}) {
  const excluded = opts.excluded ?? BAD_CLOSE_WINDOWS;
  const { price, cycles } = findCycles(rows, halvings, opts);
  const series = [];
  let ath = null, athIdx = -1, n = 0, below30 = 0, below50 = 0, below80 = 0, lastIdx = -1, lastDd = null;
  for (let i = 0; i < rows.length; i++) {
    const p = price[i];
    if (p === null) continue;
    if (isFlaggedClose(rows[i].day, excluded)) { series.push({ day: rows[i].day, dd: null }); continue; }
    if (ath === null || p > ath) { ath = p; athIdx = i; }
    const dd = round(p / ath - 1, 4);
    series.push({ day: rows[i].day, dd });
    n++;
    if (dd <= -0.3) below30++;
    if (dd <= -0.5) below50++;
    if (dd <= -0.8) below80++;
    lastIdx = i; lastDd = dd;
  }
  const bears = cycles.map(c => {
    let rec = -1;
    for (let j = c.bottom + 1; j < rows.length; j++) {
      if (price[j] !== null && price[j] >= price[c.peak]) { rec = j; break; }
    }
    const through = c.provisional ? rows[lastIdx].day : rows[c.bottom].day;
    return {
      epoch: c.epoch,
      ongoing: c.provisional,
      peak: { day: rows[c.peak].day, price: price[c.peak] },
      low: { day: rows[c.bottom].day, price: price[c.bottom] },
      depth: round(price[c.bottom] / price[c.peak] - 1, 4),
      bearDays: dayDiff(through, rows[c.peak].day),
      recovery: rec >= 0 ? { day: rows[rec].day, days: dayDiff(rows[rec].day, rows[c.peak].day) } : null,
    };
  });
  return {
    slug: 'drawdown-from-ath',
    series,
    bears,
    current: lastIdx < 0 ? null : {
      day: rows[lastIdx].day, dd: lastDd,
      ath: { day: rows[athIdx].day, price: ath },
      sinceAth: dayDiff(rows[lastIdx].day, rows[athIdx].day),
    },
    share: n ? { below30: round(below30 / n, 4), below50: round(below50 / n, 4), below80: round(below80 / n, 4), days: n } : null,
    excluded,
  };
}

// rows carry price, mvrv and supply_profit_pct.
export function buildScorecard(rows, halvings, opts = {}) {
  const { price, cycles } = findCycles(rows, halvings, opts);
  const rallies = buildRallies(rows, halvings, opts).bears;
  const runs = buildRuns(rows, halvings, opts).runs;
  const last = lastPriced(price);
  const epochStart = (e) => halvings.find(h => h.epoch === e)?.start ?? null;
  const cards = cycles.map(c => {
    const r = rallies.find(b => b.epoch === c.epoch) ?? null;
    const run = runs.find(x => x.epoch === c.epoch) ?? null;
    const start = epochStart(c.epoch);
    return {
      epoch: c.epoch,
      provisional: c.provisional,
      peak: { day: rows[c.peak].day, price: price[c.peak] },
      low: { day: rows[c.bottom].day, price: price[c.bottom] },
      drawdown: round(c.drawdown, 4),
      // The open bear is measured to the latest day, like the rallies chart.
      bearDays: dayDiff(c.provisional ? rows[last].day : rows[c.bottom].day, rows[c.peak].day),
      bearRally: r ? round(r.maxRally.value, 4) : null,
      mvrvPeak: round(num(rows[c.peak].mvrv), 2),
      mvrvLow: round(num(rows[c.bottom].mvrv), 2),
      profitAtLow: round(num(rows[c.bottom].supply_profit_pct), 4),
      halvingToPeak: start ? dayDiff(rows[c.peak].day, start) : null,
      run: run ? { multiple: run.ongoing ? run.current : run.multiple, days: run.days, ongoing: run.ongoing } : null,
    };
  });
  return { slug: 'cycle-scorecard', asOf: last >= 0 ? rows[last].day : null, cycles: cards };
}
