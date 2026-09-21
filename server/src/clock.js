// Cycle Clock: each halving epoch bent into a ring. Twelve o'clock is the
// halving; one full turn is the next halving. Along the ring, the color is
// MVRV; each ring carries its price peak and low from the shared detector;
// the hand is today, so the readings at the same hour in earlier epochs sit
// beside it.
//
// Angle comes from time, not blocks, because the daily metrics have no
// height: a closed epoch maps its days onto its actual length, and the open
// epoch maps them onto a projected length, elapsed days divided by block
// progress (blocks since the halving out of 210,000). Pure functions; the
// /api/clock route supplies rows, HALVINGS and the synced tip height.

import { findCycles } from './bottoms.js';

export const BLOCKS_PER_EPOCH = 210_000;
export const DEFAULTS = { sampleEvery: 3 }; // days between ring samples

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const dayDiff = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86400e3);
const round = (v, p) => (v === null ? null : Number(v.toFixed(p)));

// rows: [{ day, price, mvrv }] ascending, one per day. halvings ascending.
// tipHeight: the synced chain tip (for the open epoch's block progress).
export function buildClock(rows, halvings, { tipHeight, ...opts } = {}) {
  const o = { ...DEFAULTS, ...opts };
  const price = rows.map(r => num(r.price));
  const mvrv = rows.map(r => num(r.mvrv));
  const { cycles } = findCycles(rows, halvings);
  const lastDay = rows.length ? rows[rows.length - 1].day : null;

  const epochs = [];
  let today = null;
  for (let e = 0; e < halvings.length; e++) {
    const h = halvings[e];
    const next = halvings[e + 1]?.start ?? null;
    const open = next === null;
    const lo = rows.findIndex(r => r.day >= h.start);
    if (lo < 0) continue;
    let hi = open ? rows.length : rows.findIndex(r => r.day >= next);
    if (hi < 0) hi = rows.length;
    if (hi <= lo) continue;

    let days, progress = null, blocksIn = null;
    if (open) {
      const startHeight = (h.epoch - 1) * BLOCKS_PER_EPOCH;
      blocksIn = tipHeight !== null && tipHeight !== undefined ? Math.max(0, tipHeight - startHeight) : null;
      progress = blocksIn !== null ? Math.min(0.999, blocksIn / BLOCKS_PER_EPOCH) : null;
      const elapsed = dayDiff(rows[hi - 1].day, h.start);
      // Projected length: elapsed days scaled by block progress; falls back
      // to a four-year epoch when the tip is unknown.
      days = progress ? Math.round(elapsed / progress) : 1461;
    } else {
      days = dayDiff(next, h.start);
    }
    const tOf = (day) => Math.min(1, dayDiff(day, h.start) / days);

    const samples = [];
    for (let i = lo; i < hi; i += o.sampleEvery) {
      if (mvrv[i] === null) continue;
      samples.push({ t: round(tOf(rows[i].day), 4), day: rows[i].day, mvrv: round(mvrv[i], 3), price: price[i] });
    }
    // The last day always lands on the ring.
    const li = hi - 1;
    if (mvrv[li] !== null && (!samples.length || samples[samples.length - 1].day !== rows[li].day)) {
      samples.push({ t: round(tOf(rows[li].day), 4), day: rows[li].day, mvrv: round(mvrv[li], 3), price: price[li] });
    }

    const c = cycles.find(x => x.epoch === h.epoch) ?? null;
    epochs.push({
      epoch: h.epoch,
      start: h.start,
      end: next,
      open,
      days,
      progress: open ? round(progress, 4) : 1,
      peak: c ? { t: round(tOf(rows[c.peak].day), 4), day: rows[c.peak].day, price: price[c.peak] } : null,
      low: c ? { t: round(tOf(rows[c.bottom].day), 4), day: rows[c.bottom].day, price: price[c.bottom], provisional: c.provisional } : null,
      samples,
    });
    if (open) {
      today = {
        epoch: h.epoch, day: rows[li].day, t: round(tOf(rows[li].day), 4),
        height: tipHeight ?? null, blocksIn, progress: round(progress, 4),
        mvrv: round(mvrv[li], 3), price: price[li],
      };
    }
  }

  // Each closed ring's reading at today's hour: the nearest sample by angle.
  const atHour = today
    ? epochs.filter(e => !e.open && e.samples.length).map(e => {
        let best = e.samples[0];
        for (const s of e.samples) if (Math.abs(s.t - today.t) < Math.abs(best.t - today.t)) best = s;
        return { epoch: e.epoch, day: best.day, mvrv: best.mvrv, price: best.price };
      })
    : [];

  return { slug: 'cycle-clock', asOf: lastDay, epochs, today, atHour };
}
