import { useEffect, useMemo, useRef, useState } from 'react';
import { fmt, fmtDay, compact } from '../api.js';
import { heatColor, clipValue, intensity, yForPrice, priceTicks, yearColumns, cellAt, columnTotal, stackLabels } from '../heatmapRows.js';

// Plot margins inside the wrapper: price axis left, cluster callouts right.
const M = { top: 10, right: 132, bottom: 24, left: 60 };

// The daily cost-basis distribution over time: a canvas of cells (one column
// per sampled week, one row per log price band, brightness = supply) under an
// SVG overlay carrying the axes, the close, today's callout and the densest
// clusters. Both layers opt into the image export with data-export.
export default function HeatmapChart({ data }) {
  const wrapRef = useRef(null), canvasRef = useRef(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState(null);
  const clip = useMemo(() => clipValue(data.columns), [data]);
  const cols = data.columns, levels = data.levels, nRows = levels.length - 1;
  const plot = { x: M.left, y: M.top, w: Math.max(0, size.w - M.left - M.right), h: Math.max(0, size.h - M.top - M.bottom) };

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Paint the cells. Device-pixel scaling keeps rows crisp on retina.
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !plot.w || !plot.h) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(size.w * dpr); cv.height = Math.round(size.h * dpr);
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    const colW = plot.w / cols.length, rowH = plot.h / nRows;
    for (let ci = 0; ci < cols.length; ci++) {
      const c = cols[ci];
      const x = plot.x + ci * colW;
      const total = columnTotal(c);
      // The unresolved bottom bucket: a flat, faint wash up to that day's bin
      // width. It carries no level information, so it gets no heat.
      if (c.floor > 0) {
        const yTop = plot.y + yForPrice(c.width, levels, plot.h);
        ctx.fillStyle = 'rgba(196, 206, 218, 0.05)';
        ctx.fillRect(x, yTop, colW + 0.6, plot.y + plot.h - yTop);
      }
      for (let ri = 0; ri < nRows; ri++) {
        const v = c.cells[ri];
        if (v <= 0) continue;
        ctx.fillStyle = heatColor(intensity(v / total, clip));
        ctx.fillRect(x, plot.y + plot.h - (ri + 1) * rowH, colW + 0.6, rowH + 0.6);
      }
    }
  }, [data, size, clip, plot.w, plot.h, plot.x, plot.y, cols, levels, nRows]);

  const xOf = (ci) => plot.x + (ci + 0.5) * (plot.w / cols.length);
  const pricePath = useMemo(() => {
    if (!plot.w) return '';
    return cols.map((c, i) => `${i ? 'L' : 'M'} ${xOf(i).toFixed(1)} ${(plot.y + yForPrice(c.price, levels, plot.h)).toFixed(1)}`).join(' ');
  }, [cols, levels, plot.w, plot.h, plot.x, plot.y]); // eslint-disable-line react-hooks/exhaustive-deps

  const onMove = (e) => {
    const r = wrapRef.current.getBoundingClientRect();
    const cell = cellAt(e.clientX - r.left - plot.x, e.clientY - r.top - plot.y, cols.length, nRows, plot.w, plot.h);
    if (!cell) return setHover(null);
    setHover({ ...cell, px: e.clientX - r.left, py: e.clientY - r.top });
  };
  const hc = hover ? cols[hover.ci] : null;
  const last = data.latest;
  const lastX = xOf(cols.length - 1);
  const lastY = plot.y + yForPrice(last.price, levels, plot.h);

  return (
    <>
      <div className="chartwrap heatmap" ref={wrapRef} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <canvas ref={canvasRef} data-export aria-hidden="true" />
        {size.w > 0 && (
          <svg data-export viewBox={`0 0 ${size.w} ${size.h}`} role="img" aria-label="Cost basis heatmap">
            {priceTicks(levels).map(p => {
              const y = plot.y + yForPrice(p, levels, plot.h);
              return (
                <g key={p}>
                  <line x1={plot.x} x2={plot.x + plot.w} y1={y} y2={y} stroke="var(--ink-line)" strokeOpacity={0.5} />
                  <text x={plot.x - 8} y={y + 4} textAnchor="end" fontSize={11} fill="var(--text-faint)">{'$' + compact(p)}</text>
                </g>
              );
            })}
            {yearColumns(cols).filter(y => Number(y.year) % 2 === 0).map(y => (
              <text key={y.year} x={xOf(y.i)} y={size.h - 8} textAnchor="middle" fontSize={11} fill="var(--text-faint)">{y.year}</text>
            ))}
            <path d={pricePath} fill="none" stroke="var(--text)" strokeWidth={1.3} strokeOpacity={0.9} />
            {/* Densest clusters today: a bracket at the right edge, three lines of
                label each, stacked so neighbouring clusters never overlap. */}
            {(() => {
              const cl = last.clusters.map(c => ({
                ...c,
                y1: plot.y + yForPrice(c.to, levels, plot.h),
                y2: plot.y + yForPrice(c.from, levels, plot.h),
              }));
              const ys = stackLabels(cl.map(c => (c.y1 + c.y2) / 2 - 12), 44, plot.y + 12);
              const bx = plot.x + plot.w + 6;
              return [...cl].sort((a, b) => (a.y1 + a.y2) - (b.y1 + b.y2)).map((c, i) => (
                <g key={i}>
                  <path d={`M ${bx} ${c.y1} h 6 V ${c.y2} h -6`} fill="none" stroke="var(--text-dim)" />
                  <line x1={bx + 6} y1={(c.y1 + c.y2) / 2} x2={bx + 12} y2={ys[i]} stroke="var(--text-faint)" strokeOpacity={0.6} />
                  <text x={bx + 14} y={ys[i]} fontSize={11} fontWeight={600} fill="var(--text)">{compact(c.btc)} BTC</text>
                  <text x={bx + 14} y={ys[i] + 13} fontSize={10} fill="var(--text-faint)">{'$' + compact(c.from)} to {'$' + compact(c.to)}</text>
                  <text x={bx + 14} y={ys[i] + 25} fontSize={10} fill="var(--text-faint)">{c.position}</text>
                </g>
              ));
            })()}
            <circle cx={lastX} cy={lastY} r={4} fill="var(--btc)" stroke="var(--deep-black)" strokeWidth={1.5} />
            <text x={lastX - 8} y={lastY - 8} textAnchor="end" fontSize={11} fontWeight={600} fill="var(--text)">{fmt(last.price, 'usd')}</text>
          </svg>
        )}
        {hover && hc && (
          <div className="hm-tip" style={{ left: Math.min(hover.px + 14, size.w - 240), top: Math.max(0, hover.py - 64) }}>
            <b>{fmtDay(hc.day)}</b> · close {fmt(hc.price, 'usd')}<br />
            {'$' + compact(levels[hover.ri])} to {'$' + compact(levels[hover.ri + 1])}: <b>{compact(hc.cells[hover.ri])} BTC</b><br />
            below {'$' + compact(hc.width)}: {compact(hc.floor)} BTC (unresolved)
          </div>
        )}
      </div>
      <div className="cycle-key">
        <span><i className="fill" style={{ background: 'linear-gradient(90deg, rgba(247,148,29,0.15), #F7941D, #FFF1DC)', width: 60 }} />share of supply that last moved in that band, low to high</span>
        <span><i style={{ background: 'var(--text)' }} />daily close</span>
        <span><i className="dot" style={{ background: 'var(--btc)' }} />today</span>
        <span className="cycle-note">columns are weekly snapshots · rows are log price bands · the muted floor is supply acquired below one bin width, unresolved</span>
      </div>
    </>
  );
}
