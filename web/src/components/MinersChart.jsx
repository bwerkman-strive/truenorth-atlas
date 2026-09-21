import { useMemo } from 'react';
import {
  ResponsiveContainer, ComposedChart, Line,
  XAxis, YAxis, Tooltip, ReferenceArea, CartesianGrid,
} from 'recharts';
import { fmt, fmtDay, compact } from '../api.js';
import { TOOLTIP_PROPS, AXIS_TICK } from '../chartTheme.js';
import { yearTicks } from '../ralliesRows.js';
import { staggerLabels } from '../cycleRows.js';

const signed = (v) => `${v >= 0 ? '+' : ''}${Math.round(v * 100)}%`;
const MARGIN = { top: 8, right: 12, left: 0, bottom: 0 };
// Three rows of episode labels can sit above the price plot.
const PRICE_MARGIN = { ...MARGIN, top: 62 };

// Label above the plot, centred on the episode band, stepped down `dy` when
// neighbouring episodes would overprint.
const bandLabel = (text, dy) => ({ viewBox }) => {
  const { x, y, width } = viewBox;
  return <text x={x + width / 2} y={y - 44 + dy} textAnchor="middle" fill="var(--text-dim)" fontSize={12}
    stroke="var(--deep-black)" strokeWidth={3} paintOrder="stroke">{text}</text>;
};

// Price (log) with every hash-ribbon capitulation shaded and labeled with its
// length and the price change 180 days on; the ribbons themselves below.
export default function MinersChart({ data, logScale }) {
  // Log axes cannot draw zero: the earliest hashrate rows are nulled.
  const pos = (v) => (v > 0 ? v : null);
  const rows = useMemo(() => data.series.map(s => ({ day: s.day, price: pos(s.price), h30: pos(s.h30), h60: pos(s.h60) })), [data]);
  // Episodes closer than ~2.5 years take the next label row (three rows).
  const dys = useMemo(() => staggerLabels(data.episodes.map(e => Date.parse(e.start)), 900 * 86400e3, 16, 3), [data]);
  const ticks = useMemo(() => yearTicks(rows), [rows]);
  const days = useMemo(() => rows.map(r => r.day), [rows]);
  const snap = (day) => days.reduce((best, d) => (Math.abs(Date.parse(d) - Date.parse(day)) < Math.abs(Date.parse(best) - Date.parse(day)) ? d : best), days[0]);
  const bands = (withLabel) => data.episodes.map((e, i) => (
    <ReferenceArea key={e.start} x1={snap(e.start)} x2={snap(e.end)} fill="var(--hot)" fillOpacity={0.16} stroke="none"
      label={withLabel ? { content: bandLabel(`${e.days}d${e.after180 ? ` · ${signed(e.after180.change)}` : e.ongoing ? ' · ongoing' : ''}`, dys[i]) } : undefined} />
  ));
  return (
    <>
      <div className="chartwrap rally-price">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={PRICE_MARGIN} syncId="miners">
            <CartesianGrid stroke="var(--ink-line)" strokeOpacity={0.4} vertical={false} />
            <XAxis dataKey="day" ticks={ticks} tickFormatter={(d) => d.slice(0, 4)} tick={AXIS_TICK} hide />
            <YAxis scale={logScale ? 'log' : 'linear'} domain={['auto', 'auto']} allowDataOverflow tick={AXIS_TICK}
              tickFormatter={(v) => '$' + compact(v)} width={64} />
            {bands(true)}
            <Tooltip {...TOOLTIP_PROPS} labelFormatter={fmtDay} formatter={(v) => [fmt(Number(v), 'usd'), 'BTC price']} />
            <Line dataKey="price" name="price" dot={false} isAnimationActive={false} connectNulls stroke="var(--btc)" strokeWidth={1.4} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="chartwrap rally-pct">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={MARGIN} syncId="miners">
            <CartesianGrid stroke="var(--ink-line)" strokeOpacity={0.4} vertical={false} />
            <XAxis dataKey="day" ticks={ticks} tickFormatter={(d) => d.slice(0, 4)} tick={AXIS_TICK} />
            <YAxis scale="log" domain={['auto', 'auto']} allowDataOverflow tick={AXIS_TICK} tickFormatter={(v) => compact(v)} width={64} />
            {bands(false)}
            <Tooltip {...TOOLTIP_PROPS} labelFormatter={fmtDay}
              formatter={(v, name) => [`${compact(Number(v))} EH/s`, name === 'h30' ? '30-day hashrate' : '60-day hashrate']} />
            <Line dataKey="h60" name="h60" dot={false} isAnimationActive={false} connectNulls stroke="#C084FC" strokeWidth={1.2} />
            <Line dataKey="h30" name="h30" dot={false} isAnimationActive={false} connectNulls stroke="var(--cold)" strokeWidth={1.2} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="cycle-key">
        <span><i style={{ background: 'var(--btc)' }} />BTC price</span>
        <span><i style={{ background: 'var(--cold)' }} />30-day hashrate</span>
        <span><i style={{ background: '#C084FC' }} />60-day hashrate</span>
        <span><i className="fill" style={{ background: 'rgba(248, 113, 113, 0.4)' }} />capitulation: 30-day under 60-day for 14+ days · label: length, then price change 180 days after it ended</span>
        <span className="cycle-note">
          {data.stats.judged ? `price was higher 180 days later after ${data.stats.higher180} of ${data.stats.judged} completed episodes` : ''}
        </span>
      </div>
    </>
  );
}
