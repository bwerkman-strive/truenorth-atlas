import { useMemo } from 'react';
import {
  ResponsiveContainer, ComposedChart, Area,
  XAxis, YAxis, Tooltip, ReferenceLine, ReferenceDot, CartesianGrid, Customized,
} from 'recharts';
import { fmtDay, compact } from '../api.js';
import { TOOLTIP_PROPS, AXIS_TICK, LABEL, LABEL_STRONG } from '../chartTheme.js';
import { yearTicks } from '../ralliesRows.js';
import { layoutLabels } from '../cycleRows.js';

const usd = (v) => `${v < 0 ? '-' : ''}$${compact(Math.abs(v))}`;

// Labels for the largest loss days, placed in pixel space once the axes are
// known: each sits under its dot and steps down a row when it would overprint
// a neighbour, whatever the two dots' values happen to be.
const LossLabels = ({ marks, xAxisMap, yAxisMap, offset }) => {
  const xs = Object.values(xAxisMap ?? {})[0], ys = Object.values(yAxisMap ?? {})[0];
  if (!xs || !ys || !offset) return null;
  const half = xs.scale.bandwidth ? xs.scale.bandwidth() / 2 : 0;
  const pts = marks.map(m => ({ text: `${usd(m.loss)} · ${fmtDay(m.day)}`, x: xs.scale(m.day) + half, y: ys.scale(-m.loss) + 16 }));
  const right = offset.left + offset.width;
  const placed = layoutLabels(pts, { width: 118, step: 16 });
  return (
    <g>
      {placed.map((p, i) => {
        // Keep the text inside the plot: anchor it to the end near the right edge.
        const end = p.x + 59 > right + 60;
        return <text key={i} x={p.x} y={p.y} textAnchor={end ? 'end' : 'middle'} {...LABEL_STRONG}>{p.text}</text>;
      })}
    </g>
  );
};

// Realized profit above the axis, realized loss mirrored below it. The
// largest loss days are labeled where they fall; the current bear is shaded.
export default function PnlChart({ data }) {
  const rows = useMemo(() => data.series.map(s => ({ day: s.day, profit: s.profit ?? 0, loss: s.loss ? -s.loss : 0 })), [data]);
  const ticks = useMemo(() => yearTicks(rows), [rows]);
  const marks = data.topLoss.slice(0, 5);
  const bear = data.bear;
  return (
    <>
      <div className="chartwrap">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 10, right: 70, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="pnl-gain" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--aurora)" stopOpacity={0.75} />
                <stop offset="100%" stopColor="var(--aurora)" stopOpacity={0.15} />
              </linearGradient>
              <linearGradient id="pnl-loss" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--hot)" stopOpacity={0.15} />
                <stop offset="100%" stopColor="var(--hot)" stopOpacity={0.8} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="var(--ink-line)" strokeOpacity={0.4} vertical={false} />
            <XAxis dataKey="day" ticks={ticks} tickFormatter={(d) => d.slice(0, 4)} tick={AXIS_TICK} />
            <YAxis tickFormatter={usd} tick={AXIS_TICK} width={66} />
            {bear && <ReferenceLine x={bear.peak} stroke="var(--text-faint)" strokeDasharray="3 5"
              label={{ value: `epoch ${bear.epoch} bear →`, position: 'insideTopLeft', ...LABEL }} />}
            <ReferenceLine y={0} stroke="var(--text-faint)" />
            <Tooltip {...TOOLTIP_PROPS} labelFormatter={fmtDay}
              formatter={(v, name) => [usd(Number(v)), name === 'profit' ? 'Realized profit' : 'Realized loss']} />
            <Area dataKey="profit" name="profit" isAnimationActive={false} stroke="var(--aurora)" strokeWidth={0.8} fill="url(#pnl-gain)" />
            <Area dataKey="loss" name="loss" isAnimationActive={false} stroke="var(--hot)" strokeWidth={0.8} fill="url(#pnl-loss)" />
            {marks.map((m) => (
              <ReferenceDot key={m.day} x={m.day} y={-m.loss} r={3.5} fill="var(--hot)" stroke="var(--deep-black)" strokeWidth={1} isFront />
            ))}
            <Customized component={<LossLabels marks={marks} />} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="cycle-key">
        <span><i className="fill" style={{ background: 'rgba(52, 211, 153, 0.6)' }} />realized profit (USD per day)</span>
        <span><i className="fill" style={{ background: 'rgba(248, 113, 113, 0.6)' }} />realized loss, drawn below the line</span>
        <span><i className="dot" style={{ background: 'var(--hot)' }} />five largest loss days</span>
        <span className="cycle-note">each spent coin valued at the spend-day close against the close of the day it last moved</span>
      </div>
    </>
  );
}
