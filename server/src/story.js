// The story layer: the facts a chart needs to state its own takeaway.
//
// For a line metric, the "story" is where today's reading sits (all-history
// percentile), which catalog zone it is in and for how long, and what the
// metric read at every cycle peak and low. All of it derives from columns
// that already exist and from the shared cycle detector in bottoms.js, so no
// metric needs new data. The takeaway sentence is a template over these
// facts and the catalog's own zone labels: it states, it does not interpret.
//
// Served by GET /api/story/:slug; the UI draws the same facts as chart
// annotations (current-value callout, live-zone emphasis, cycle-extreme
// markers) and prints the sentence under the headline and into the exported
// image.

import { findCycles } from './bottoms.js';

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Share of daily readings at or below `v`, over the non-null history.
export function percentileOf(values, v) {
  const xs = values.filter(x => x !== null);
  if (xs.length < 2 || v === null) return null;
  let below = 0;
  for (const x of xs) if (x <= v) below++;
  return below / xs.length;
}

// The catalog zone (a band, never a 'line' marker) that contains `v`;
// bands are inclusive at both ends. Returns the band with its catalog index.
export function zoneOf(zones, v) {
  if (v === null || !Array.isArray(zones)) return null;
  for (let i = 0; i < zones.length; i++) {
    const z = zones[i];
    if (z.tone === 'line') continue;
    if (v >= z.from && v <= z.to) return { index: i, label: z.label, tone: z.tone, from: z.from, to: z.to };
  }
  return null;
}

// How long the latest reading has been where it is: consecutive trailing
// days (nulls break the streak) in the same band, or outside every band.
export function zoneStreak(series, zones) {
  const last = [...series].reverse().find(p => p.v !== null);
  if (!last) return null;
  const zone = zoneOf(zones, last.v);
  const key = zone ? zone.index : -1;
  let days = 0, since = last.day;
  for (let i = series.length - 1; i >= 0; i--) {
    const p = series[i];
    if (p.v === null) break;
    const k = zoneOf(zones, p.v)?.index ?? -1;
    if (k !== key) break;
    days++; since = p.day;
  }
  return { zone, days, since };
}

// The metric's reading at each epoch's price peak and price low.
export function cycleExtremes(rows, halvings, opts = {}) {
  const { cycles } = findCycles(rows, halvings, opts);
  return cycles.map(c => ({
    epoch: c.epoch,
    provisional: c.provisional,
    peak: { day: rows[c.peak].day, price: num(rows[c.peak].price), value: num(rows[c.peak].v) },
    low: { day: rows[c.bottom].day, price: num(rows[c.bottom].price), value: num(rows[c.bottom].v) },
  }));
}

// Mirrors web/src/format.js fmt() so the sentence reads like the headline.
const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const usd2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const num0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
function compact(v) {
  const a = Math.abs(v);
  if (a >= 1e12) return (v / 1e12).toFixed(2) + 'T';
  if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return a >= 10 ? v.toFixed(0) : v.toFixed(2);
}
export function fmtValue(v, format, unit) {
  if (v === null || v === undefined) return '—';
  switch (format) {
    case 'usd': return v < 1000 ? usd2.format(v) : usd0.format(v);
    case 'usd_compact': return '$' + compact(v);
    case 'percent': return (v * 100).toFixed(1) + '%';
    case 'ratio': return Math.abs(v) >= 100 ? num0.format(v) : v.toFixed(2);
    case 'number': return compact(v) + (unit ? ' ' + unit : '');
    default: return String(v);
  }
}

const usDay = (d) => { const m = String(d).match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[2]}/${m[3]}/${m[1]}` : d; };
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// One sentence a reader can lift straight into a post. Facts only: the
// value and date, its percentile, its band and tenure, and the readings at
// prior cycle extremes when there are at least two closed cycles to cite.
export function takeaway(metric, facts) {
  const f = (v) => fmtValue(v, metric.format, metric.unit);
  const parts = [];
  let s = `${metric.name} is ${f(facts.value)} as of ${usDay(facts.asOf)}`;
  if (facts.percentile !== null) s += `, higher than ${Math.round(facts.percentile * 100)}% of all daily readings`;
  parts.push(s + '.');
  if (facts.streak?.zone) {
    parts.push(`It has sat in the "${facts.streak.zone.label}" band for ${plural(facts.streak.days, 'day')}, since ${usDay(facts.streak.since)}.`);
  } else if (facts.streak && (metric.zones ?? []).some(z => z.tone !== 'line')) {
    parts.push(facts.count && facts.streak.days >= facts.count
      ? 'It has never entered a marked band.'
      : `It has been outside every marked band for ${plural(facts.streak.days, 'day')}.`);
  }
  const closed = facts.extremes.filter(e => !e.provisional && e.peak.value !== null && e.low.value !== null);
  if (closed.length >= 2) {
    parts.push(`At the last ${closed.length} cycle peaks it read ${closed.map(e => f(e.peak.value)).join(', ')}; at the lows, ${closed.map(e => f(e.low.value)).join(', ')}.`);
  }
  return parts.join(' ');
}

// Readings at prior cycle peaks and lows only compare across cycles for
// oscillators (ratios, multiples, shares). A price- or count-denominated
// series grows by orders of magnitude between cycles, so its 2011 peak
// reading is noise next to today's; those metrics keep the percentile and
// zone facts and skip the extremes.
export const comparesAcrossCycles = (metric) => ['ratio', 'percent'].includes(metric.format);

// rows: [{ day, price, v }] ascending, one per day (v = the metric column).
export function buildStory(metric, rows, halvings, opts = {}) {
  const series = rows.map(r => ({ day: r.day, v: num(r.v) }));
  const last = [...series].reverse().find(p => p.v !== null);
  if (!last) return { slug: metric.slug, asOf: null, value: null, percentile: null, streak: null, extremes: [], takeaway: '' };
  const percentile = percentileOf(series.map(p => p.v), last.v);
  const streak = zoneStreak(series, metric.zones ?? []);
  const extremes = comparesAcrossCycles(metric) ? cycleExtremes(rows, halvings, opts) : [];
  const count = series.filter(p => p.v !== null).length;
  const facts = { asOf: last.day, value: last.v, percentile, streak, extremes, count };
  return { slug: metric.slug, ...facts, takeaway: takeaway(metric, facts) };
}
