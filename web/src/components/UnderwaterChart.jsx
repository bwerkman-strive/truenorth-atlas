import { useMemo } from 'react';
import {
  ResponsiveContainer, ComposedChart, Area,
  XAxis, YAxis, Tooltip, ReferenceLine, ReferenceDot, CartesianGrid,
} from 'recharts';
import { fmtDay } from '../api.js';
import { TOOLTIP_PROPS, AXIS_TICK, EPOCH_COLORS, LABEL, LABEL_STRONG } from '../chartTheme.js';
import { yearTicks } from '../ralliesRows.js';
import { fmtDrawdown } from '../cycleRows.js';

const color = (epoch) => EPOCH_COLORS[epoch] ?? 'var(--cold)';
const pct0 = (v) => `${Math.round(v * 100)}%`;

// Distance below the all-time high on every day: zero is a new high, the
// fill deepens with the drawdown. Each bear's floor carries its depth and
// length; dashed guides mark the 30/50/80% depths with the share of all days
// spent below each.
export default function UnderwaterChart({ data }) {
  const rows = useMemo(() => data.series.map(s => ({ day: s.day, dd: s.dd })), [data]);
  const ticks = useMemo(() => yearTicks(rows), [rows]);
  const c = data.current;
  const guides = data.share ? [
    { y: -0.3, share: data.share.below30 }, { y: -0.5, share: data.share.below50 }, { y: -0.8, share: data.share.below80 },
  ] : [];
  return (
    <>
      <div className="chartwrap">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 10, right: 118, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="uw-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--hot)" stopOpacity={0.10} />
                <stop offset="100%" stopColor="var(--hot)" stopOpacity={0.60} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="var(--ink-line)" strokeOpacity={0.4} vertical={false} />
            <XAxis dataKey="day" ticks={ticks} tickFormatter={(d) => d.slice(0, 4)} tick={AXIS_TICK} />
            <YAxis domain={[-1, 0]} ticks={[0, -0.25, -0.5, -0.75, -1]} tickFormatter={pct0} tick={AXIS_TICK} width={56} />
            <Tooltip {...TOOLTIP_PROPS} labelFormatter={fmtDay}
              formatter={(v) => [v === 0 ? 'new all-time high' : `${fmtDrawdown(v)} below the high`, 'Drawdown']} />
            {guides.map(g => (
              <ReferenceLine key={g.y} y={g.y} stroke="var(--text-faint)" strokeDasharray="2 6" strokeOpacity={0.7}
                label={{ value: `${pct0(g.share)} of days below`, position: 'right', ...LABEL }} />
            ))}
            <Area dataKey="dd" name="dd" baseValue={0} isAnimationActive={false}
              stroke="var(--hot)" strokeWidth={1.1} fill="url(#uw-fill)" />
            {data.bears.map(b => (
              <ReferenceDot key={b.epoch} x={b.low.day} y={b.depth} r={3.5}
                fill={color(b.epoch)} stroke="var(--deep-black)" strokeWidth={1}
                label={{
                  value: `${pct0(b.depth)} · ${b.bearDays}d${b.ongoing ? ' so far' : ''}`,
                  position: b.depth < -0.88 ? 'right' : 'bottom', ...LABEL,
                }} />
            ))}
            {c && c.dd < 0 && (
              <ReferenceDot x={c.day} y={c.dd} r={4.5} fill="var(--text)" stroke="var(--deep-black)" strokeWidth={1.5} isFront
                label={{ value: `${fmtDrawdown(c.dd)} · day ${c.sinceAth}`, position: 'left', ...LABEL_STRONG }} />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="cycle-key">
        <span><i className="fill" style={{ background: 'rgba(248, 113, 113, 0.45)' }} />Distance below the all-time high</span>
        {data.bears.map(b => (
          <span key={b.epoch}><i className="dot" style={{ background: color(b.epoch) }} />
            Epoch {b.epoch} floor <em>({fmtDay(b.low.day)}{b.recovery ? `, back at the high after ${b.recovery.days}d` : b.ongoing ? ', so far' : ', not yet recovered'})</em>
          </span>
        ))}
        <span className="cycle-note">
          zero is a new all-time high
          {data.excluded?.length ? ' · closes in flagged data-quality windows are left out' : ''}
        </span>
      </div>
    </>
  );
}
