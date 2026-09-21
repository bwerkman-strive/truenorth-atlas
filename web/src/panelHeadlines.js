// Headline, sub-line, takeaway sentence and as-of day for each panel kind,
// from that kind's API payload. Pure, so the page, the export card and the
// tests share one source of truth. Returns null when there is nothing to
// show yet (the page then prints the kind's empty-state message).

import { fmt, fmtDay, compact } from './format.js';
import { fmtMultiple, fmtDrawdown } from './cycleRows.js';

const pct = (v, digits = 0) => `${(v * 100).toFixed(digits)}%`;
const signed = (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
const list = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

export function bottomsHeadline(data) {
  const cur = data?.cycles?.length ? data.cycles[data.cycles.length - 1] : null;
  if (!cur) return null;
  const low = cur.provisional ? 'low to date' : 'low';
  return {
    value: fmt(cur.bottom.price, 'usd'),
    sub: `epoch ${cur.epoch} ${low}, ${fmtDay(cur.bottom.day)}${cur.provisional ? ' (provisional)' : ''}`,
    takeaway: `Epoch ${cur.epoch} ${low} ${fmt(cur.bottom.price, 'usd')} on ${fmtDay(cur.bottom.day)}, `
      + `${Math.round(cur.drawdown * 100)}% below the ${fmtDay(cur.peak.day)} peak${cur.provisional ? ' (provisional)' : ''}.`,
    asOf: cur.values[cur.values.length - 1]?.day ?? null,
  };
}

export function ralliesHeadline(data) {
  const last = data?.bears?.length ? data.bears[data.bears.length - 1] : null;
  if (!last) return null;
  const closed = data.bears.filter(b => !b.ongoing);
  if (!last.ongoing || last.current === null) {
    return { value: '', sub: '', asOf: last.through,
      takeaway: closed.length ? `Largest rallies inside the completed bears: ${list(closed.map(b => `+${Math.round(b.maxRally.value * 100)}%`))}.` : '' };
  }
  return {
    value: signed(last.current),
    sub: `epoch ${last.epoch} rally off the ${fmtDay(last.low.day)} low, day ${last.days} of the bear`,
    takeaway: `Epoch ${last.epoch} rally ${signed(last.current)} off the ${fmtDay(last.low.day)} low, day ${last.days} of the bear. `
      + `Largest rallies of the prior bears: ${list(closed.map(b => `+${Math.round(b.maxRally.value * 100)}%`))}.`,
    asOf: last.through,
  };
}

export function runsHeadline(data) {
  if (!data?.runs?.length) return null;
  const closed = data.runs.filter(r => !r.ongoing);
  const t = data.today;
  const live = t ? data.runs.find(r => r.epoch === t.epoch) : null;
  const ended = closed.length
    ? ` Those runs ended at ${list(closed.map(r => fmtMultiple(r.multiple)))} after ${list(closed.map(r => `${r.days}`))} days.`
    : '';
  if (!live) {
    return { value: '', sub: '', asOf: data.runs[data.runs.length - 1].through, takeaway: ended.trim() };
  }
  const peers = t.atDay.filter(a => a.m !== null);
  return {
    value: fmtMultiple(t.m),
    sub: `day ${t.d} off the ${fmtDay(live.low.day)} low${live.provisional ? ' (provisional)' : ''}`,
    takeaway: `Day ${t.d} off the ${fmtDay(live.low.day)} low: ${fmtMultiple(t.m)}.`
      + (peers.length ? ` On day ${t.d}, the earlier runs stood at ${list(peers.map(a => fmtMultiple(a.m)))}.` : '')
      + ended,
    asOf: live.through,
  };
}

export function underwaterHeadline(data) {
  const c = data?.current;
  if (!c) return null;
  const closed = (data.bears ?? []).filter(b => !b.ongoing);
  const s = data.share;
  return {
    value: fmtDrawdown(c.dd),
    sub: c.dd === 0 ? `at a new high on ${fmtDay(c.day)}` : `below the ${fmtDay(c.ath.day)} high, day ${c.sinceAth}`,
    takeaway: (c.dd === 0
      ? `Bitcoin closed at a new all-time high on ${fmtDay(c.day)}.`
      : `Bitcoin closed ${fmtDrawdown(-c.dd)} below its ${fmtDay(c.ath.day)} high on ${fmtDay(c.day)}, day ${c.sinceAth} since the high.`)
      + (s ? ` It has spent ${pct(s.below30)} of all days at least 30% under its high, ${pct(s.below50)} at least 50% under, and ${pct(s.below80)} at least 80% under.` : '')
      + (closed.length ? ` Completed bears fell ${list(closed.map(b => pct(-b.depth)))}.` : ''),
    asOf: c.day,
  };
}

export function scorecardHeadline(data) {
  if (!data?.cycles?.length) return null;
  const cycles = data.cycles;
  const closed = cycles.filter(c => !c.provisional);
  const open = cycles.find(c => c.provisional) ?? null;
  const range = (xs, f) => (xs.length ? `${f(Math.min(...xs))} to ${f(Math.max(...xs))}` : '');
  const parts = [];
  if (closed.length) {
    parts.push(`${closed.length === 1 ? 'The one completed bear' : `${closed.length} completed bears`} fell `
      + `${range(closed.map(c => c.drawdown), v => pct(v))} over ${range(closed.map(c => c.bearDays), v => `${v}`)} days, `
      + `with rallies of ${range(closed.map(c => c.bearRally ?? 0), v => pct(v))} inside them.`);
  }
  if (open) {
    parts.push(`Epoch ${open.epoch} is down ${pct(open.drawdown)} at day ${open.bearDays}`
      + (open.bearRally !== null ? ` with a ${pct(open.bearRally)} rally to date.` : '.'));
  }
  return {
    value: `${cycles.length} cycles`,
    sub: `${closed.length} completed${open ? `, epoch ${open.epoch} provisional` : ''} · as of ${fmtDay(data.asOf)}`,
    takeaway: parts.join(' '),
    asOf: data.asOf,
  };
}

export function heatmapHeadline(data) {
  const l = data?.latest;
  if (!l || !data.columns?.length) return null;
  const top = l.clusters?.[0] ?? null;
  const range = (c) => `${fmt(c.from, 'usd')} to ${fmt(c.to, 'usd')}`;
  const between = (c) => `${fmt(c.from, 'usd')} and ${fmt(c.to, 'usd')}`;
  const state = (c) => c.position;
  const parts = [];
  if (top) {
    parts.push(`As of ${fmtDay(l.day)}, the densest cost-basis cluster holds ${compact(top.btc)} BTC acquired between ${between(top)}, ${state(top)} at the ${fmt(l.price, 'usd')} close.`);
    if (l.clusters[1]) parts.push(`The next holds ${compact(l.clusters[1].btc)} BTC between ${between(l.clusters[1])}, ${state(l.clusters[1])}.`);
  }
  if (l.inProfit !== null && l.inProfit !== undefined) parts.push(`${pct(l.inProfit)} of supply is in profit.`);
  return {
    value: top ? `${compact(top.btc)} BTC` : fmt(l.price, 'usd'),
    sub: top ? `densest cluster, acquired ${range(top)}, ${state(top)}` : `close on ${fmtDay(l.day)}`,
    takeaway: parts.join(' '),
    asOf: l.day,
  };
}

export function clockHeadline(data) {
  if (!data?.epochs?.length) return null;
  const t = data.today;
  const closed = data.epochs.filter(e => !e.open);
  const peaks = closed.filter(e => e.peak).map(e => e.peak.t);
  const lows = closed.filter(e => e.low && !e.low.provisional).map(e => e.low.t);
  const rangeT = (xs) => (xs.length ? `${pct(Math.min(...xs))} and ${pct(Math.max(...xs))}` : null);
  const parts = [];
  if (t) {
    parts.push(t.progress !== null
      ? `Epoch ${t.epoch} is ${pct(t.progress)} complete by blocks (${t.blocksIn.toLocaleString('en-US')} of 210,000).`
      : `Epoch ${t.epoch} is ${pct(t.t)} of the way through on the calendar.`);
    if (t.mvrv !== null) {
      const peers = data.atHour.filter(a => a.mvrv !== null);
      parts.push(`MVRV reads ${t.mvrv.toFixed(2)} at this hour`
        + (peers.length ? `; at the same hour, ${peers.length === 1 ? 'epoch' : 'epochs'} ${list(peers.map(a => `${a.epoch}`))} read ${list(peers.map(a => a.mvrv.toFixed(2)))}.` : '.'));
    }
  }
  if (peaks.length >= 2 && lows.length >= 2) {
    parts.push(`Cycle peaks have fallen between ${rangeT(peaks)} of the way through an epoch, lows between ${rangeT(lows)}.`);
  }
  return {
    value: t && t.progress !== null ? pct(t.progress) : (t ? pct(t.t) : ''),
    sub: t ? `of epoch ${t.epoch} complete${t.blocksIn !== null ? `, block ${t.blocksIn.toLocaleString('en-US')} of 210,000` : ''}` : '',
    takeaway: parts.join(' '),
    asOf: data.asOf ?? null,
  };
}

export const HEADLINES = {
  bottoms: bottomsHeadline,
  rallies: ralliesHeadline,
  runs: runsHeadline,
  underwater: underwaterHeadline,
  scorecard: scorecardHeadline,
  heatmap: heatmapHeadline,
  clock: clockHeadline,
};
