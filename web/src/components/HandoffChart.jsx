import { useMemo } from 'react';
import {
  ResponsiveContainer, AreaChart, Area,
  XAxis, YAxis, Tooltip, ReferenceDot, CartesianGrid,
} from 'recharts';
import { fmtDay, compact } from '../api.js';
import { TOOLTIP_PROPS, AXIS_TICK, LABEL } from '../chartTheme.js';
import { yearTicks } from '../ralliesRows.js';

const pct = (v) => `${(v * 100).toFixed(1)}%`;
const LTH = 'var(--cold)', STH = '#C084FC';

// The two cohorts' shares of supply, stacked, with the long-term share read
// at every cycle peak (▲) and low (▼).
export default function HandoffChart({ data }) {
  const rows = useMemo(() => data.series.map(s => ({ day: s.day, lth: s.lth, sth: 1 - s.lth, lthBtc: s.lthBtc, sthBtc: s.sthBtc })), [data]);
  const ticks = useMemo(() => yearTicks(rows), [rows]);
  const days = useMemo(() => rows.map(r => r.day), [rows]);
  // Marks snap to the nearest sampled week.
  const snap = (day) => days.reduce((best, d) => (Math.abs(Date.parse(d) - Date.parse(day)) < Math.abs(Date.parse(best) - Date.parse(day)) ? d : best), days[0]);
  return (
    <>
      <div className="chartwrap">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={rows} margin={{ top: 14, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="var(--ink-line)" strokeOpacity={0.4} vertical={false} />
            <XAxis dataKey="day" ticks={ticks} tickFormatter={(d) => d.slice(0, 4)} tick={AXIS_TICK} />
            <YAxis domain={[0, 1]} ticks={[0, 0.25, 0.5, 0.75, 1]} tickFormatter={(v) => `${Math.round(v * 100)}%`} tick={AXIS_TICK} width={52} />
            <Tooltip {...TOOLTIP_PROPS} labelFormatter={fmtDay}
              formatter={(v, name, item) => [`${pct(Number(v))} (${compact(name === 'lth' ? item.payload.lthBtc : item.payload.sthBtc)} BTC)`,
                name === 'lth' ? 'Long-term holders (155d+)' : 'Short-term holders']} />
            <Area dataKey="lth" name="lth" stackId="1" isAnimationActive={false} stroke={LTH} strokeWidth={1} fill={LTH} fillOpacity={0.45} />
            <Area dataKey="sth" name="sth" stackId="1" isAnimationActive={false} stroke={STH} strokeWidth={1} fill={STH} fillOpacity={0.35} />
            {data.marks.map(m => (
              <ReferenceDot key={`p${m.epoch}`} x={snap(m.peak.day)} y={m.peak.lth} r={3.5} fill="var(--text)" stroke="var(--deep-black)" strokeWidth={1} isFront
                label={{ value: `▲ ${Math.round(m.peak.lth * 100)}%`, position: 'top', ...LABEL }} />
            ))}
            {data.marks.filter(m => !m.provisional).map(m => (
              <ReferenceDot key={`l${m.epoch}`} x={snap(m.low.day)} y={m.low.lth} r={3.5} fill="var(--text)" stroke="var(--deep-black)" strokeWidth={1} isFront
                label={{ value: `▼ ${Math.round(m.low.lth * 100)}%`, position: 'top', ...LABEL }} />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <div className="cycle-key">
        <span><i className="fill" style={{ background: 'rgba(96, 165, 250, 0.55)' }} />long-term holders (coins older than 155 days)</span>
        <span><i className="fill" style={{ background: 'rgba(192, 132, 252, 0.45)' }} />short-term holders</span>
        <span>▲ long-term share at the cycle peak · ▼ at the low</span>
        <span className="cycle-note">weekly samples · shares of the two cohorts combined</span>
      </div>
    </>
  );
}
