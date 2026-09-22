// Sprint-3 story charts: seven small, pure builders over daily rows, each
// serving one panel kind. All lean on the shared cycle detector for peaks
// and lows, and none needs a new column.
//
//   buildPnl        realized profit above the axis, realized loss below, with
//                   the largest loss-realization days named
//   buildHandoff    long- and short-term holder supply as shares, with the
//                   long-term share read at each cycle peak and low
//   buildMiners     hash-ribbon capitulation episodes (30d hashrate under the
//                   60d) with duration and what price did 180 days later
//   buildDipBuyers  change in supply share by address-balance band since the
//                   cycle low, against the same span after prior lows
//   buildReturns    monthly close-to-close returns, year by month
//   buildSameHour   from today's position in the epoch, what each earlier
//                   epoch did over the next 90, 180 and 365 days (history)
//   buildDaysSince  days since the high, the low and the halving, and to the
//                   next halving, each with the prior cycle's span beside it

import { findCycles } from './bottoms.js';
import { BLOCKS_PER_EPOCH } from './clock.js';

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const dayDiff = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86400e3);
const addDays = (day, n) => new Date(Date.parse(day) + n * 86400e3).toISOString().slice(0, 10);
const round = (v, p) => (v === null || v === undefined ? null : Number(v.toFixed(p)));
const lastIdx = (arr) => { for (let i = arr.length - 1; i >= 0; i--) if (arr[i] !== null) return i; return -1; };
// Every `step`th row plus the last, so long histories travel light.
const sample = (rows, step) => rows.filter((_, i) => i % step === 0 || i === rows.length - 1);
// Index of the row on `day`, or the nearest later row.
function indexOnOrAfter(rows, day) {
  let lo = 0, hi = rows.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (rows[m].day < day) lo = m + 1; else hi = m; }
  return lo < rows.length ? lo : -1;
}

// ---------------------------------------------------------------------------
export function buildPnl(rows, halvings, opts = {}) {
  const { price, cycles } = findCycles(rows, halvings, opts);
  const series = rows.map(r => ({ day: r.day, profit: round(num(r.realized_profit), 0), loss: round(num(r.realized_loss), 0) }))
    .filter(s => s.profit !== null || s.loss !== null);
  const byLoss = [...series].filter(s => s.loss > 0).sort((a, b) => b.loss - a.loss);
  const byProfit = [...series].filter(s => s.profit > 0).sort((a, b) => b.profit - a.profit);
  const open = cycles.find(c => c.provisional) ?? null;
  const bear = open ? {
    epoch: open.epoch, peak: rows[open.peak].day, through: rows[lastIdx(price)].day,
    largestLoss: byLoss.find(s => s.day >= rows[open.peak].day) ?? null,
  } : null;
  const last = series[series.length - 1] ?? null;
  return {
    slug: 'realized-pnl-mirror',
    series,
    topLoss: byLoss.slice(0, (opts.top ?? 8)),
    topProfit: byProfit.slice(0, 5),
    bear,
    latest: last,
  };
}

// ---------------------------------------------------------------------------
export function buildHandoff(rows, halvings, opts = {}) {
  const { price, cycles } = findCycles(rows, halvings, opts);
  const share = (r) => {
    const s = num(r.sth_supply), l = num(r.lth_supply);
    return s === null || l === null || s + l <= 0 ? null : { sth: s, lth: l, lthShare: l / (s + l) };
  };
  const shares = rows.map(share);
  const series = sample(rows.map((r, i) => shares[i] ? {
    day: r.day, lth: round(shares[i].lthShare, 4), lthBtc: Math.round(shares[i].lth), sthBtc: Math.round(shares[i].sth), price: price[i],
  } : null).filter(Boolean), opts.step ?? 7);
  const at = (i) => (shares[i] ? round(shares[i].lthShare, 4) : null);
  const marks = cycles.map(c => ({
    epoch: c.epoch, provisional: c.provisional,
    peak: { day: rows[c.peak].day, lth: at(c.peak) },
    low: { day: rows[c.bottom].day, lth: at(c.bottom) },
  }));
  const li = lastIdx(shares.map(s => (s ? 1 : null)));
  const open = cycles.find(c => c.provisional) ?? null;
  const current = li >= 0 ? {
    day: rows[li].day, lth: round(shares[li].lthShare, 4), lthBtc: Math.round(shares[li].lth), sthBtc: Math.round(shares[li].sth),
    sinceLow: open && shares[open.bottom] ? {
      day: rows[open.bottom].day, deltaBtc: Math.round(shares[li].lth - shares[open.bottom].lth),
      deltaShare: round(shares[li].lthShare - shares[open.bottom].lthShare, 4),
    } : null,
  } : null;
  return { slug: 'holder-handoff', series, marks, current };
}

// ---------------------------------------------------------------------------
export function buildMiners(rows, halvings, opts = {}) {
  const minDays = opts.minDays ?? 14;
  const { price } = findCycles(rows, halvings, opts);
  const h30 = rows.map(r => num(r.hashrate_30d)), h60 = rows.map(r => num(r.hashrate_60d));
  const episodes = [];
  let start = -1;
  for (let i = 0; i <= rows.length; i++) {
    const under = i < rows.length && h30[i] !== null && h60[i] !== null && h30[i] < h60[i];
    if (under && start < 0) start = i;
    if (!under && start >= 0) {
      const end = i - 1;
      if (dayDiff(rows[end].day, rows[start].day) + 1 >= minDays) episodes.push([start, end]);
      start = -1;
    }
  }
  const li = lastIdx(price);
  const out = episodes.map(([s, e]) => {
    const ongoing = e === rows.length - 1;
    const after = indexOnOrAfter(rows, addDays(rows[e].day, 180));
    return {
      start: rows[s].day, end: rows[e].day, ongoing,
      days: dayDiff(rows[e].day, rows[s].day) + 1,
      priceStart: price[s], priceEnd: price[e],
      after180: !ongoing && after >= 0 && price[after] !== null && price[e]
        ? { day: rows[after].day, change: round(price[after] / price[e] - 1, 4) } : null,
    };
  });
  const closed = out.filter(e => !e.ongoing && e.after180);
  return {
    slug: 'miner-stress',
    series: sample(rows.map((r, i) => ({ day: r.day, price: price[i], h30: round(h30[i], 3), h60: round(h60[i], 3) })), opts.step ?? 7),
    episodes: out,
    stats: { count: out.length, judged: closed.length, higher180: closed.filter(e => e.after180.change > 0).length },
    current: li >= 0 ? { day: rows[li].day, inEpisode: out.some(e => e.ongoing) } : null,
  };
}

// ---------------------------------------------------------------------------
export function buildDipBuyers(rows, halvings, bands, opts = {}) {
  const { price, cycles } = findCycles(rows, halvings, opts);
  const bb = rows.map(r => (r.balance_bands && typeof r.balance_bands === 'object' ? r.balance_bands : null));
  const li = lastIdx(price);
  const deltas = (a, b) => bands.map(band => {
    const from = num(bb[a]?.[band]), to = num(bb[b]?.[band]);
    return { band, from: round(from, 4), to: round(to, 4), delta: from === null || to === null ? null : round(to - from, 4) };
  });
  const open = cycles.find(c => c.provisional) ?? null;
  const current = open && bb[open.bottom] && bb[li] ? {
    epoch: open.epoch, since: rows[open.bottom].day, through: rows[li].day,
    days: dayDiff(rows[li].day, rows[open.bottom].day), rows: deltas(open.bottom, li),
  } : null;
  const span = current?.days ?? 0;
  const priors = cycles.filter(c => !c.provisional).map(c => {
    const end = Math.min(rows.length - 1, c.bottom + span);
    return bb[c.bottom] && bb[end]
      ? { epoch: c.epoch, low: rows[c.bottom].day, through: rows[end].day, days: dayDiff(rows[end].day, rows[c.bottom].day), rows: deltas(c.bottom, end) }
      : null;
  }).filter(Boolean);
  return { slug: 'who-bought-the-dip', bands, current, priors };
}

// ---------------------------------------------------------------------------
export function buildReturns(rows) {
  const priced = rows.filter(r => num(r.price) > 0).map(r => ({ day: r.day, price: num(r.price) }));
  if (!priced.length) return { slug: 'monthly-returns', years: [], current: null, monthStats: null };
  // Last close of each month.
  const monthEnd = new Map(); // 'YYYY-MM' -> price
  for (const r of priced) monthEnd.set(r.day.slice(0, 7), r.price);
  const keys = [...monthEnd.keys()].sort();
  const last = priced[priced.length - 1];
  const curKey = last.day.slice(0, 7);
  const prevKey = (k) => { const [y, m] = k.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; };
  const ret = new Map();
  for (const k of keys) {
    const p = monthEnd.get(prevKey(k));
    if (p) ret.set(k, round(monthEnd.get(k) / p - 1, 4));
  }
  const years = [];
  const yearOf = (k) => Number(k.slice(0, 4));
  for (let y = yearOf(keys[0]); y <= yearOf(curKey); y++) {
    const months = Array.from({ length: 12 }, (_, i) => ret.get(`${y}-${String(i + 1).padStart(2, '0')}`) ?? null);
    const dec = monthEnd.get(`${y}-12`) ?? (y === yearOf(curKey) ? last.price : null);
    const prevDec = monthEnd.get(`${y - 1}-12`);
    years.push({ year: y, months, total: dec && prevDec ? round(dec / prevDec - 1, 4) : null, partial: y === yearOf(curKey) });
  }
  const curMonth = Number(curKey.slice(5, 7));
  const history = years.filter(yr => yr.year < yearOf(curKey)).map(yr => yr.months[curMonth - 1]).filter(v => v !== null);
  const sorted = [...history].sort((a, b) => a - b);
  return {
    slug: 'monthly-returns',
    years,
    current: { year: yearOf(curKey), month: curMonth, ret: ret.get(curKey) ?? null, day: last.day, provisional: true },
    monthStats: {
      month: curMonth, years: history.length,
      up: history.filter(v => v > 0).length, down: history.filter(v => v < 0).length,
      median: sorted.length ? round(sorted[sorted.length >> 1], 4) : null,
    },
  };
}

// ---------------------------------------------------------------------------
export function buildSameHour(rows, halvings, { tipHeight, horizons = [90, 180, 365], ...opts } = {}) {
  const { price } = findCycles(rows, halvings, opts);
  const li = lastIdx(price);
  if (li < 0) return { slug: 'same-hour', today: null, rows: [] };
  const open = halvings[halvings.length - 1];
  const startHeight = (open.epoch - 1) * BLOCKS_PER_EPOCH;
  const blocksIn = tipHeight !== null && tipHeight !== undefined ? Math.max(0, tipHeight - startHeight) : null;
  const progress = blocksIn !== null ? Math.min(0.999, blocksIn / BLOCKS_PER_EPOCH) : null;
  const elapsed = dayDiff(rows[li].day, open.start);
  const t = progress ?? Math.min(0.999, elapsed / 1461);
  const out = [];
  for (let e = 0; e < halvings.length - 1; e++) {
    const start = halvings[e].start, end = halvings[e + 1].start;
    const days = dayDiff(end, start);
    const i = indexOnOrAfter(rows, addDays(start, Math.round(t * days)));
    if (i < 0 || price[i] === null) continue;
    out.push({
      epoch: halvings[e].epoch, day: rows[i].day, price: price[i], elapsed: dayDiff(rows[i].day, start),
      forward: horizons.map(h => {
        const j = indexOnOrAfter(rows, addDays(rows[i].day, h));
        return j >= 0 && price[j] !== null && j <= li ? { days: h, day: rows[j].day, change: round(price[j] / price[i] - 1, 4) } : { days: h, day: null, change: null };
      }),
    });
  }
  return {
    slug: 'same-hour',
    today: { epoch: open.epoch, day: rows[li].day, price: price[li], elapsed, t: round(t, 4), progress: round(progress, 4), blocksIn },
    horizons,
    rows: out,
  };
}

// ---------------------------------------------------------------------------
export function buildDaysSince(rows, halvings, { tipHeight, blockSeconds = 600, ...opts } = {}) {
  const { price, cycles } = findCycles(rows, halvings, opts);
  const li = lastIdx(price);
  if (li < 0) return { slug: 'days-since', asOf: null, items: [] };
  const today = rows[li].day;
  let ath = -1;
  for (let i = 0; i <= li; i++) if (price[i] !== null && (ath < 0 || price[i] > price[ath])) ath = i;
  const open = cycles.find(c => c.provisional) ?? null;
  const closed = cycles.filter(c => !c.provisional);
  const prevBear = closed.length ? closed[closed.length - 1] : null;
  const epoch = halvings[halvings.length - 1];
  const prevEpochIdx = halvings.length - 2;
  const items = [];
  items.push({
    key: 'ath', label: 'since the all-time high', days: dayDiff(today, rows[ath].day), date: rows[ath].day, value: price[ath],
    prior: prevBear ? { label: `epoch ${prevBear.epoch} bear, peak to low`, days: dayDiff(rows[prevBear.bottom].day, rows[prevBear.peak].day) } : null,
  });
  if (open) {
    const prevRun = prevBear && open ? dayDiff(rows[open.peak].day, rows[prevBear.bottom].day) : null;
    items.push({
      key: 'low', label: `since the cycle low${open.provisional ? ' to date' : ''}`, days: dayDiff(today, rows[open.bottom].day), date: rows[open.bottom].day, value: price[open.bottom],
      prior: prevRun !== null ? { label: `epoch ${prevBear.epoch} low to the next peak`, days: prevRun } : null,
    });
  }
  const prevHalvingToPeak = prevBear && prevEpochIdx >= 0 ? dayDiff(rows[prevBear.peak].day, halvings.find(h => h.epoch === prevBear.epoch)?.start ?? rows[prevBear.peak].day) : null;
  items.push({
    key: 'halving', label: 'since the halving', days: dayDiff(today, epoch.start), date: epoch.start, value: null,
    prior: prevHalvingToPeak !== null ? { label: `epoch ${prevBear.epoch} halving to peak`, days: prevHalvingToPeak } : null,
  });
  if (tipHeight !== null && tipHeight !== undefined) {
    const left = Math.max(0, epoch.epoch * BLOCKS_PER_EPOCH - tipHeight);
    const days = Math.round(left * blockSeconds / 86400);
    items.push({
      key: 'nextHalving', label: 'to the next halving (estimated)', days, date: addDays(today, days), value: left,
      prior: prevEpochIdx >= 0 ? { label: `epoch ${halvings[prevEpochIdx].epoch} lasted`, days: dayDiff(epoch.start, halvings[prevEpochIdx].start) } : null,
    });
  }
  return { slug: 'days-since', asOf: today, items };
}
