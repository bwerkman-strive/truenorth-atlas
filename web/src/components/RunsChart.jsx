import { useMemo } from 'react';
import {
  ResponsiveContainer, ComposedChart, Line, Area,
  XAxis, YAxis, Tooltip, ReferenceLine, ReferenceDot, CartesianGrid,
} from 'recharts';
import { fmtDay } from '../api.js';
import { TOOLTIP_PROPS, AXIS_TICK, EPOCH_COLORS, LABEL, LABEL_STRONG } from '../chartTheme.js';
import { runRows, runKey, fmtMultiple, fmtTick, logTicks, dayTicks } from '../cycleRows.js';

const color = (epoch) => EPOCH_COLORS[epoch] ?? 'var(--cold)';

// Every recovery from a cycle low as a multiple of that low, on one axis of
// days since the low. Completed runs fade back; the live run is drawn in
// front with a soft glow and a gradient under it, and a "today" line shows
// where each earlier run stood on the same day.
export default function RunsChart({ data, logScale }) {
  const rows = useMemo(() => runRows(data), [data]);
  const live = data.runs.find(r => r.ongoing) ?? null;
  const maxD = Math.max(...data.runs.map(r => r.days));
  const maxM = Math.max(...data.runs.map(r => r.multiple ?? r.current ?? 1));
  const liveColor = live ? color(live.epoch) : 'var(--aurora)';
  const t = data.today;
  return (
    <>
      <div className="chartwrap">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 28, right: 100, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="run-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={liveColor} stopOpacity={0.32} />
                <stop offset="100%" stopColor={liveColor} stopOpacity={0} />
              </linearGradient>
              <filter id="run-glow" x="-10%" y="-40%" width="120%" height="180%">
                <feGaussianBlur stdDeviation="3" result="b" />
                <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
              </filter>
            </defs>
            <CartesianGrid stroke="var(--ink-line)" strokeOpacity={0.4} vertical={false} />
            <XAxis dataKey="d" type="number" domain={[0, maxD]} ticks={dayTicks(maxD)} tick={AXIS_TICK}
              tickFormatter={(d) => `${d}d`} minTickGap={40} />
            <YAxis scale={logScale ? 'log' : 'linear'} domain={logScale ? [1, 'auto'] : [0, 'auto']} allowDataOverflow
              ticks={logScale ? logTicks(maxM) : undefined} tickFormatter={fmtTick} tick={AXIS_TICK} width={58} />
            <Tooltip {...TOOLTIP_PROPS}
              labelFormatter={(d) => `Day ${d} off the low`}
              formatter={(v, name) => [fmtMultiple(v), `Epoch ${String(name).slice(3)} run`]}
              itemSorter={(it) => -Number(String(it.name).slice(3))} />
            {live && (
              <Area dataKey={runKey(live.epoch)} name="live" tooltipType="none" isAnimationActive={false}
                stroke="none" fill="url(#run-fill)" baseValue={logScale ? 1 : 0} />
            )}
            {data.runs.filter(r => !r.ongoing).map(r => (
              <Line key={r.epoch} dataKey={runKey(r.epoch)} name={runKey(r.epoch)} dot={false} isAnimationActive={false}
                stroke={color(r.epoch)} strokeWidth={1.4} strokeOpacity={0.8} connectNulls />
            ))}
            {live && (
              <Line dataKey={runKey(live.epoch)} name={runKey(live.epoch)} dot={false} isAnimationActive={false}
                stroke={liveColor} strokeWidth={2.6} connectNulls filter="url(#run-glow)" />
            )}
            {/* Where each completed run ended: its peak multiple and length. */}
            {data.runs.filter(r => !r.ongoing).map(r => (
              <ReferenceDot key={`end-${r.epoch}`} x={r.days} y={r.multiple} r={3}
                fill={color(r.epoch)} stroke="var(--deep-black)" strokeWidth={1}
                label={{ value: `${fmtMultiple(r.multiple)} · ${r.days}d`, position: 'right', ...LABEL }} />
            ))}
            {t && (
              <ReferenceLine x={t.d} stroke="var(--text-faint)" strokeDasharray="3 5"
                label={{ value: `today · day ${t.d}`, position: 'top', ...LABEL }} />
            )}
            {t && t.atDay.filter(a => a.m !== null).map(a => (
              <ReferenceDot key={`at-${a.epoch}`} x={t.d} y={a.m} r={3} fill={color(a.epoch)} stroke="var(--deep-black)" strokeWidth={1} />
            ))}
            {t && (
              <ReferenceDot x={t.d} y={t.m} r={5} fill={liveColor} stroke="var(--deep-black)" strokeWidth={1.5} isFront
                label={{ value: fmtMultiple(t.m), position: 'left', ...LABEL_STRONG }} />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="cycle-key">
        {data.runs.map(r => (
          <span key={r.epoch}><i style={{ background: color(r.epoch) }} />
            Run out of the {fmtDay(r.low.day)} low
            <em> ({r.ongoing ? `${fmtMultiple(r.current)} so far, day ${r.days}${r.provisional ? ', provisional' : ''}` : `${fmtMultiple(r.multiple)} in ${r.days}d`})</em>
          </span>
        ))}
        <span className="cycle-note">x-axis: days since each cycle low · y-axis: price as a multiple of that low</span>
      </div>
    </>
  );
}
