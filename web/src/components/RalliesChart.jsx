import { useMemo } from 'react';
import {
  ResponsiveContainer, ComposedChart, Line, Area,
  XAxis, YAxis, Tooltip, ReferenceArea, CartesianGrid,
} from 'recharts';
import { fmt, fmtDay, compact } from '../api.js';
import { TOOLTIP_PROPS, AXIS_TICK, EPOCH_COLORS } from '../chartTheme.js';
import { buildRows, segKey, rallyKey, bearLabel, bearYears, yearTicks } from '../ralliesRows.js';

// The full-history price is context; the colored bear segments carry the
// story, so the base line sits at light-sky/55 (a line, not text, and every
// value is one hover away).
const BASE_STROKE = 'rgba(196, 206, 218, 0.55)';
const color = (epoch) => EPOCH_COLORS[epoch] ?? 'var(--cold)';
const pct = (v) => (v === null || v === undefined ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`);
const MARGIN = { top: 8, right: 10, left: 0, bottom: 0 };
// Room above the price plot for the band labels, which sit over the plot
// rather than inside it so they never collide with the price line.
const PRICE_MARGIN = { ...MARGIN, top: 26 };

// Band label drawn just above the plot, centred on the band; the open bear
// hugs the right edge, so its label is anchored to the band's right side and
// runs leftwards instead of being clipped.
const bandLabel = (text, anchorEnd) => ({ viewBox }) => {
  const { x, y, width } = viewBox;
  return (
    <text x={anchorEnd ? x + width : x + width / 2} y={y - 8} textAnchor={anchorEnd ? 'end' : 'middle'}
      fill="var(--text-dim)" fontSize={11}>{text}</text>
  );
};

// Two panes on one x-axis instead of the reference's dual y-axis: the price
// (log) above, each bear's rally off its running low below. Both share the
// row array, so syncId lines the tooltips up by day.
export default function RalliesChart({ data, logScale }) {
  const rows = useMemo(() => buildRows(data, logScale), [data, logScale]);
  const ticks = useMemo(() => yearTicks(rows), [rows]);
  const bands = (withLabel) => data.bears.map(b => (
    <ReferenceArea key={b.epoch} x1={b.peak.day} x2={b.through} fill={color(b.epoch)} fillOpacity={0.08} stroke="none"
      label={withLabel ? { content: bandLabel(bearLabel(b), b.ongoing) } : undefined} />
  ));
  return (
    <>
      <div className="chartwrap rally-price">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={PRICE_MARGIN} syncId="rallies">
            <CartesianGrid stroke="var(--ink-line)" strokeOpacity={0.4} vertical={false} />
            <XAxis dataKey="day" ticks={ticks} tickFormatter={(d) => d.slice(0, 4)} tick={AXIS_TICK} hide />
            <YAxis scale={logScale ? 'log' : 'linear'} domain={['auto', 'auto']} allowDataOverflow
              tick={AXIS_TICK} tickFormatter={(v) => '$' + compact(v)} width={64} />
            {bands(true)}
            <Tooltip {...TOOLTIP_PROPS} labelFormatter={fmtDay}
              formatter={(v) => [fmt(Number(v), 'usd'), 'BTC price']} />
            <Line dataKey="p" name="p" dot={false} isAnimationActive={false} connectNulls
              stroke={BASE_STROKE} strokeWidth={1.1} />
            {/* The same closes again, only inside each bear, in the epoch's
                color; hidden from the tooltip so the price is not listed twice. */}
            {data.bears.map(b => (
              <Line key={b.epoch} dataKey={segKey(b.epoch)} name={segKey(b.epoch)} dot={false}
                isAnimationActive={false} tooltipType="none" stroke={color(b.epoch)} strokeWidth={1.8} />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="chartwrap rally-pct">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={MARGIN} syncId="rallies">
            <CartesianGrid stroke="var(--ink-line)" strokeOpacity={0.4} vertical={false} />
            <XAxis dataKey="day" ticks={ticks} tickFormatter={(d) => d.slice(0, 4)} tick={AXIS_TICK} />
            <YAxis domain={[0, 'auto']} tick={AXIS_TICK} tickFormatter={(v) => Math.round(v * 100) + '%'} width={64} />
            {bands(false)}
            <Tooltip {...TOOLTIP_PROPS} labelFormatter={fmtDay}
              formatter={(v, name) => [pct(Number(v)), `Epoch ${String(name).slice(3)} rally off the bear low`]} />
            {data.bears.map(b => (
              <Area key={b.epoch} dataKey={rallyKey(b.epoch)} name={rallyKey(b.epoch)} isAnimationActive={false}
                stroke={color(b.epoch)} strokeWidth={0.8} fill={color(b.epoch)} fillOpacity={0.45} />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="cycle-key">
        <span><i style={{ background: BASE_STROKE }} />BTC price</span>
        {data.bears.map(b => (
          <span key={b.epoch}><i style={{ background: color(b.epoch) }} />
            Epoch {b.epoch} bear <em>({bearYears(b)}{b.ongoing ? ', ongoing' : ''})</em></span>
        ))}
        <span className="cycle-note">
          bands run from each cycle peak to its low · lower pane: close relative to the lowest close so far in that bear
          {data.excluded?.length ? ' · closes in flagged data-quality windows are left out' : ''}
        </span>
      </div>
    </>
  );
}
