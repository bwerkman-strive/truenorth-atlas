import { useRef, useState } from 'react';
import {
  ResponsiveContainer, ComposedChart, Line, Area,
  XAxis, YAxis, Tooltip, ReferenceLine, CartesianGrid,
} from 'recharts';
import { fmt, fmtDay, compact } from '../api.js';
import { TOOLTIP_PROPS, AXIS_TICK } from '../chartTheme.js';
import { panelRows, windowTicks, dayLabel } from '../bottomsRows.js';
import { chartToPngBlob, copyPng } from '../chartImage.js';

// Series colors. Price keeps the BTC orange; the 200-day SMA and the STH cost
// basis take cyan and purple from the guide's §2.4 categorical set. The trio
// was picked with the dataviz palette validator over the blue/green
// alternatives: worst all-pairs CVD separation ΔE 9.9 (deutan) and 13.5
// (tritan), normal-vision 24.1, and every series >= 3:1 on the card
// composite. The lightness-band warning is the brand tier itself (Tailwind
// 400 shades) and is accepted app-wide. The ATH marker is starbright: a
// point, not a series, and the legend names it.
export const BOTTOM_COLORS = {
  price: 'var(--btc)', sma: '#22D3EE', sth: '#C084FC', ath: 'var(--starbright)',
};
const LABELS = { price: 'BTC price', sma: '200D SMA', sth: 'STH cost basis', ath: 'All-time high' };
const ORDER = ['price', 'sma', 'sth', 'ath'];

// ATH marker: a dot on the days the close set a new all-time high, drawn by a
// strokeless Line over the sparse `ath` column so it shares the panel's axes
// and tooltip. Null days render nothing.
const athDot = (p) => (p.value === null || p.value === undefined || p.cy === null
  ? null
  : <circle key={p.key} cx={p.cx} cy={p.cy} r={3} fill={BOTTOM_COLORS.ath} stroke="var(--deep-black)" strokeWidth={1} />);

const COPY_LABEL = { copied: '✓ Copied', downloaded: '✓ Downloaded', failed: 'Copy failed' };

// One tile per epoch, each a prominent card with its own caption, watermark
// and copy button. The group container (in MetricDetail) owns the whole-grid
// copy; `tilesToPngBlob` reproduces this layout from the DOM.
export default function BottomsChart({ data, logScale, metricName }) {
  const ticks = windowTicks(data.window);
  const tileRefs = useRef({});
  const groupRef = useRef(null);
  const [copied, setCopied] = useState(null); // { epoch, status } transient

  const copyTile = async (c) => {
    const node = tileRefs.current[c.epoch];
    if (!node) return;
    // Rasterization is passed unresolved: Safari requires the clipboard write
    // to be issued in the click's own task (see copyPng).
    const png = chartToPngBlob(node, {
      title: `${metricName} · Epoch ${c.epoch}`,
      value: `${c.provisional ? 'Low to date' : 'Low'} ${fmt(c.bottom.price, 'usd')} · ${fmtDay(c.bottom.day)}`,
      legendFrom: groupRef.current,
    });
    const status = await copyPng(png, `bottom-comparison-epoch-${c.epoch}-true-north-atlas.png`);
    setCopied({ epoch: c.epoch, status });
    setTimeout(() => setCopied(null), 2200);
  };

  return (
    <div ref={groupRef}>
      <div className="bc-grid">
        {data.cycles.map((c) => {
          const rows = panelRows(c.values, logScale);
          return (
            <section key={c.epoch} className="chartbox bc-tile" aria-label={`Epoch ${c.epoch} cycle low`}
              ref={(el) => { tileRefs.current[c.epoch] = el; }}>
              <div className="bc-hd">
                <b>Epoch {c.epoch}</b>
                <span>{c.provisional ? 'low to date' : 'low'} <em className="bc-num">{fmtDay(c.bottom.day)}</em> at <em className="bc-num">{fmt(c.bottom.price, 'usd')}</em></span>
                <span><em className="bc-num">{(c.drawdown * 100).toFixed(0)}%</em> below the <em className="bc-num">{fmtDay(c.peak.day)}</em> peak</span>
                {c.provisional && <span className="bc-chip">provisional</span>}
                <button type="button" className="bc-copy" onClick={() => copyTile(c)}
                  aria-label={`Copy the epoch ${c.epoch} chart as an image`}>
                  {copied?.epoch === c.epoch ? COPY_LABEL[copied.status] : 'Copy image'}
                </button>
              </div>
              <div className="chart-watermark" aria-hidden="true">TRUE NORTH <em>ATLAS</em></div>
              <div className="chartwrap tile">
                <ResponsiveContainer width="100%" height="100%">
                  {/* syncId + syncMethod="value": hovering day -120 in one tile
                      highlights day -120 in every tile, by x value rather than
                      row index (the provisional tile has fewer rows). */}
                  <ComposedChart data={rows} margin={{ top: 8, right: 10, left: 0, bottom: 0 }}
                    syncId="bottoms" syncMethod="value">
                    <CartesianGrid stroke="var(--ink-line)" strokeOpacity={0.4} vertical={false} />
                    <XAxis dataKey="d" type="number" domain={[-data.window, data.window]} ticks={ticks}
                      tick={AXIS_TICK} tickFormatter={(d) => (d > 0 ? '+' : '') + d} minTickGap={24} />
                    <YAxis scale={logScale ? 'log' : 'linear'} domain={['auto', 'auto']} allowDataOverflow
                      tick={AXIS_TICK} tickFormatter={(v) => '$' + compact(v)} width={60} />
                    <ReferenceLine x={0} stroke="var(--text-faint)" strokeDasharray="3 5" />
                    <Tooltip {...TOOLTIP_PROPS}
                      labelFormatter={(d, payload) => `${dayLabel(d)} · ${fmtDay(payload?.[0]?.payload?.day)}`}
                      formatter={(v, name) => [fmt(Number(v), 'usd'), LABELS[name] ?? name]}
                      itemSorter={(it) => ORDER.indexOf(it.name)} />
                    {/* The gap between trend and recent buyers' cost, by sign. */}
                    <Area dataKey="bear" name="bear" tooltipType="none" isAnimationActive={false}
                      stroke="none" fill="var(--hot)" fillOpacity={0.14} />
                    <Area dataKey="bull" name="bull" tooltipType="none" isAnimationActive={false}
                      stroke="none" fill="var(--aurora)" fillOpacity={0.14} />
                    <Line dataKey="sma" name="sma" dot={false} isAnimationActive={false} connectNulls
                      stroke={BOTTOM_COLORS.sma} strokeWidth={1.4} strokeDasharray="5 3" />
                    <Line dataKey="sth" name="sth" dot={false} isAnimationActive={false} connectNulls
                      stroke={BOTTOM_COLORS.sth} strokeWidth={1.4} strokeDasharray="2 3" />
                    <Line dataKey="price" name="price" dot={false} isAnimationActive={false} connectNulls
                      stroke={BOTTOM_COLORS.price} strokeWidth={1.8} />
                    <Line dataKey="ath" name="ath" stroke="none" dot={athDot} activeDot={false}
                      isAnimationActive={false} legendType="none" />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </section>
          );
        })}
      </div>
      <div className="cycle-key">
        <span><i style={{ background: BOTTOM_COLORS.price }} />{LABELS.price}</span>
        <span><i style={{ background: BOTTOM_COLORS.sma }} />{LABELS.sma}</span>
        <span><i style={{ background: BOTTOM_COLORS.sth }} />{LABELS.sth}</span>
        <span><i className="dot" style={{ background: BOTTOM_COLORS.ath }} />{LABELS.ath}</span>
        <span><i className="fill" style={{ background: 'rgba(248, 113, 113, 0.35)' }} />SMA above STH cost basis</span>
        <span><i className="fill" style={{ background: 'rgba(52, 211, 153, 0.35)' }} />SMA below STH cost basis</span>
        <span className="cycle-note">
          x-axis: days since each cycle low · each tile keeps its own price axis
          {data.cycles.some(c => c.provisional) ? ' · the current epoch’s low is provisional' : ''}
        </span>
      </div>
    </div>
  );
}
