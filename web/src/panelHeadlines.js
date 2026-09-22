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

const usdC = (v) => `$${compact(v)}`;
const signedPct = (v, d = 0) => `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(d)}%`;
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function pnlHeadline(data) {
  if (!data?.series?.length) return null;
  const b = data.bear, worst = b?.largestLoss ?? null, top = data.topLoss ?? [];
  const parts = [];
  if (worst) parts.push(`The largest loss-realization day of the epoch ${b.epoch} bear was ${usdC(worst.loss)} on ${fmtDay(worst.day)}.`);
  if (top.length >= 3) parts.push(`Across all history the biggest were ${list(top.slice(0, 3).map(t => `${usdC(t.loss)} (${fmtDay(t.day)})`))}.`);
  if (data.latest) parts.push(`On ${fmtDay(data.latest.day)}, spenders realized ${usdC(data.latest.profit ?? 0)} of profit and ${usdC(data.latest.loss ?? 0)} of loss.`);
  return {
    value: worst ? usdC(worst.loss) : (top[0] ? usdC(top[0].loss) : ''),
    sub: worst ? `largest loss day of this bear, ${fmtDay(worst.day)}` : (top[0] ? `largest loss day on record, ${fmtDay(top[0].day)}` : ''),
    takeaway: parts.join(' '),
    asOf: data.latest?.day ?? null,
  };
}

export function handoffHeadline(data) {
  const c = data?.current;
  if (!c) return null;
  const closed = (data.marks ?? []).filter(m => !m.provisional && m.peak.lth !== null && m.low.lth !== null);
  const parts = [`Long-term holders hold ${compact(c.lthBtc)} BTC, ${pct(c.lth)} of the two cohorts combined`
    + (c.sinceLow ? `, ${c.sinceLow.deltaBtc >= 0 ? 'up' : 'down'} ${compact(Math.abs(c.sinceLow.deltaBtc))} BTC since the ${fmtDay(c.sinceLow.day)} low.` : '.')];
  if (closed.length >= 2) parts.push(`At the last ${closed.length} cycle peaks their share read ${list(closed.map(m => pct(m.peak.lth)))}; at the lows, ${list(closed.map(m => pct(m.low.lth)))}.`);
  return {
    value: c.sinceLow ? `${c.sinceLow.deltaBtc >= 0 ? '+' : '−'}${compact(Math.abs(c.sinceLow.deltaBtc))} BTC` : pct(c.lth),
    sub: c.sinceLow ? `long-term holder supply since the ${fmtDay(c.sinceLow.day)} low` : 'long-term holders\u2019 share of supply',
    takeaway: parts.join(' '),
    asOf: c.day,
  };
}

export function minersHeadline(data) {
  if (!data?.episodes) return null;
  const s = data.stats, eps = data.episodes;
  const parts = [`${s.count} miner capitulation${s.count === 1 ? '' : 's'} on record (30-day hashrate under the 60-day for 14 days or more)`
    + (s.judged ? `; price was higher 180 days later after ${s.higher180} of the ${s.judged} completed.` : '.')];
  const open = eps.find(e => e.ongoing);
  if (open) parts.push(`One is under way: day ${open.days} since ${fmtDay(open.start)}.`);
  else if (eps.length) { const last = eps[eps.length - 1]; parts.push(`The most recent ran ${last.days} days to ${fmtDay(last.end)}${last.after180 ? `, and price was ${signedPct(last.after180.change)} 180 days on` : ''}.`); }
  return {
    value: `${s.count} episodes`,
    sub: s.judged ? `price higher 180 days later after ${s.higher180} of ${s.judged}` : 'hash-ribbon capitulations',
    takeaway: parts.join(' '),
    asOf: data.current?.day ?? null,
  };
}

const pts = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(2)} points`;
export function dipbuyersHeadline(data) {
  const c = data?.current;
  if (!c) return null;
  const rows = c.rows.filter(r => r.delta !== null);
  if (!rows.length) return null;
  const gain = [...rows].sort((a, b) => b.delta - a.delta)[0];
  const loss = [...rows].sort((a, b) => a.delta - b.delta)[0];
  const parts = [`Since the ${fmtDay(c.since)} low (${c.days} days), addresses holding ${gain.band} BTC gained ${pts(gain.delta)} of supply share`
    + (loss !== gain && loss.delta < 0 ? ` and ${loss.band} BTC lost ${pts(Math.abs(loss.delta)).replace('+', '')}.` : '.')];
  const priorTop = (data.priors ?? []).map(p => { const r = [...p.rows].filter(x => x.delta !== null).sort((a, b) => b.delta - a.delta)[0]; return r ? `${r.band} BTC in epoch ${p.epoch}` : null; }).filter(Boolean);
  if (priorTop.length) parts.push(`Over the same span after earlier lows, the biggest gainers were ${list(priorTop)}.`);
  return { value: pts(gain.delta), sub: `addresses holding ${gain.band} BTC, share of supply since the ${fmtDay(c.since)} low`, takeaway: parts.join(' '), asOf: c.through };
}

export function returnsHeadline(data) {
  const c = data?.current;
  if (!c || !data.years?.length) return null;
  const name = MONTH_NAMES[c.month - 1];
  const s = data.monthStats;
  const yr = data.years.find(y => y.year === c.year);
  const parts = [];
  if (c.ret !== null) parts.push(`${name} ${c.year} is ${signedPct(c.ret, 1)} to date.`);
  if (s && s.years) parts.push(`${name} has closed higher in ${s.up} of the last ${s.years} years${s.median !== null ? `, median ${signedPct(s.median, 1)}` : ''}.`);
  if (yr && yr.total !== null) parts.push(`${c.year} is ${signedPct(yr.total, 1)} year to date.`);
  return {
    value: c.ret !== null ? signedPct(c.ret, 1) : '',
    sub: `${name} ${c.year} to date${s?.years ? ` · ${name} closed higher in ${s.up} of ${s.years} years` : ''}`,
    takeaway: parts.join(' '),
    asOf: c.day,
  };
}

export function samehourHeadline(data) {
  const t = data?.today;
  if (!t || !data.rows?.length) return null;
  const h = data.horizons.indexOf(180) >= 0 ? 180 : data.horizons[0];
  const at = data.rows.map(r => ({ epoch: r.epoch, f: r.forward.find(x => x.days === h) })).filter(x => x.f && x.f.change !== null);
  const parts = [`Today is day ${t.elapsed} of epoch ${t.epoch}${t.progress !== null ? `, ${pct(t.progress)} through by blocks` : ''}.`];
  if (at.length) parts.push(`From the same point, ${list(at.map(x => `epoch ${x.epoch} ${x.f.change >= 0 ? 'gained' : 'lost'} ${Math.abs(x.f.change * 100).toFixed(0)}%`))} over the next ${h} days.`);
  parts.push('History, not a forecast.');
  return { value: `day ${t.elapsed}`, sub: `of epoch ${t.epoch}${t.progress !== null ? `, ${pct(t.progress)} by blocks` : ''}`, takeaway: parts.join(' '), asOf: t.day };
}

export function dayssinceHeadline(data) {
  if (!data?.items?.length) return null;
  const ath = data.items.find(i => i.key === 'ath'), low = data.items.find(i => i.key === 'low');
  const halving = data.items.find(i => i.key === 'halving'), next = data.items.find(i => i.key === 'nextHalving');
  const parts = [];
  if (ath) parts.push(`${ath.days} days since the all-time high on ${fmtDay(ath.date)}${ath.prior ? ` (the ${ath.prior.label} took ${ath.prior.days})` : ''}.`);
  if (low) parts.push(`${low.days} days since the ${fmtDay(low.date)} low${low.prior ? ` (the ${low.prior.label} took ${low.prior.days})` : ''}.`);
  if (halving) parts.push(`${halving.days} days since the halving${halving.prior ? ` (the ${halving.prior.label} took ${halving.prior.days})` : ''}.`);
  if (next) parts.push(`About ${next.days} days to the next halving, ${next.value.toLocaleString('en-US')} blocks away.`);
  return {
    value: ath ? `${ath.days} days` : '',
    sub: ath ? `since the all-time high, ${fmtDay(ath.date)}` : '',
    takeaway: parts.join(' '),
    asOf: data.asOf,
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
  pnl: pnlHeadline,
  handoff: handoffHeadline,
  miners: minersHeadline,
  dipbuyers: dipbuyersHeadline,
  returns: returnsHeadline,
  samehour: samehourHeadline,
  dayssince: dayssinceHeadline,
};
