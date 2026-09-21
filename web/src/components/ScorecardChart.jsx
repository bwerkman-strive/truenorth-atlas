import { fmt, fmtDay } from '../api.js';
import { EPOCH_COLORS } from '../chartTheme.js';
import { fmtMultiple } from '../cycleRows.js';

// The Cycle Scorecard: one row per halving epoch, drawn as SVG so it exports
// through the same rasterizer as every chart (data-export opts it in) and
// scales with the card. Numbers in the data face, labels in the UI face;
// tinted cells carry the tone of the figure (depth in red, rallies in green,
// MVRV at the top warm and at the low cool). Each row wears its epoch color
// as a left accent, the same cast as every cycle chart.

const UI = 'var(--font-ui)';
const DATA = 'var(--font-data)';
const ROW_H = 58, HEAD_H = 34, PAD_X = 14;
const pct0 = (v) => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`);
const num2 = (v) => (v === null || v === undefined ? '—' : Number(v).toFixed(2));
const clamp01 = (v) => Math.max(0, Math.min(1, v));

// Column spec: label, width, the cell's two lines, and an optional tint.
const COLS = [
  { key: 'epoch', label: 'Epoch', w: 78, lines: (c) => [`${c.epoch}`, c.provisional ? 'provisional' : 'complete'] },
  { key: 'peak', label: 'Peak', w: 132, lines: (c) => [fmt(c.peak.price, 'usd'), fmtDay(c.peak.day)] },
  { key: 'low', label: 'Low', w: 132, lines: (c) => [fmt(c.low.price, 'usd'), `${fmtDay(c.low.day)}${c.provisional ? ' (to date)' : ''}`] },
  { key: 'drawdown', label: 'Drawdown', w: 96, lines: (c) => [`-${pct0(c.drawdown)}`, `${c.bearDays}d${c.provisional ? ' so far' : ' bear'}`],
    tint: (c) => ['hot', 0.06 + 0.26 * clamp01((c.drawdown - 0.4) / 0.55)] },
  { key: 'rally', label: 'Bear rally', w: 112, lines: (c) => [c.bearRally === null ? '—' : `+${pct0(c.bearRally)}`, 'biggest, off the low'],
    tint: (c) => ['aurora', 0.04 + 0.22 * clamp01((c.bearRally ?? 0) / 0.9)] },
  { key: 'mvrv', label: 'MVRV top / low', w: 134, lines: (c) => [`${num2(c.mvrvPeak)} / ${num2(c.mvrvLow)}`, 'market vs. cost basis'] },
  { key: 'profit', label: 'In profit at low', w: 120, lines: (c) => [pct0(c.profitAtLow), 'of supply'] },
  { key: 'h2p', label: 'Halving to peak', w: 116, lines: (c) => [c.halvingToPeak === null ? '—' : `${c.halvingToPeak}d`, c.epoch === 1 ? 'from genesis' : 'after the halving'] },
  { key: 'run', label: 'Run from the low', w: 136, lines: (c) => (c.run
    ? [fmtMultiple(c.run.multiple), `${c.run.days}d${c.run.ongoing ? ' so far' : ' to the next peak'}`]
    : ['—', '']) },
];
const TINT = { hot: '248,113,113', aurora: '52,211,153' };

export default function ScorecardChart({ data }) {
  const W = COLS.reduce((s, c) => s + c.w, 0);
  const H = HEAD_H + ROW_H * data.cycles.length + 8;
  let x = 0;
  const colX = COLS.map(c => { const cx = x; x += c.w; return cx; });
  return (
    <div className="chartwrap scorecard">
      <svg data-export viewBox={`0 0 ${W} ${H}`} width="100%" role="table" aria-label="Cycle scorecard"
        style={{ aspectRatio: `${W} / ${H}` }}>
        {COLS.map((c, i) => (
          <text key={c.key} x={colX[i] + PAD_X} y={22} fontSize={10.5} fontWeight={600} letterSpacing="0.05em"
            fill="var(--text-faint)" style={{ fontFamily: UI, textTransform: 'uppercase' }}>{c.label.toUpperCase()}</text>
        ))}
        <line x1={0} x2={W} y1={HEAD_H} y2={HEAD_H} stroke="var(--ink-line)" />
        {data.cycles.map((cyc, r) => {
          const y = HEAD_H + r * ROW_H;
          const accent = EPOCH_COLORS[cyc.epoch] ?? 'var(--cold)';
          return (
            <g key={cyc.epoch} role="row">
              {r % 2 === 1 && <rect x={0} y={y} width={W} height={ROW_H} fill="rgba(81, 79, 96, 0.08)" />}
              <rect x={0} y={y + 10} width={3} height={ROW_H - 20} rx={1.5} fill={accent} />
              {COLS.map((c, i) => {
                const [l1, l2] = c.lines(cyc);
                const tint = c.tint ? c.tint(cyc) : null;
                return (
                  <g key={c.key} role="cell">
                    {tint && <rect x={colX[i] + 4} y={y + 6} width={c.w - 8} height={ROW_H - 12} rx={6}
                      fill={`rgba(${TINT[tint[0]]}, ${tint[1].toFixed(3)})`} />}
                    <text x={colX[i] + PAD_X} y={y + 27} fontSize={14} fontWeight={600} fill="var(--text)"
                      style={{ fontFamily: DATA, fontVariantNumeric: 'tabular-nums' }}>{l1}</text>
                    <text x={colX[i] + PAD_X} y={y + 45} fontSize={10.5} fill="var(--text-faint)"
                      style={{ fontFamily: UI }}>{l2}</text>
                    {c.key === 'epoch' && cyc.provisional && (
                      <circle cx={colX[i] + PAD_X + 24} cy={y + 22} r={3} fill="var(--amber)" />
                    )}
                  </g>
                );
              })}
              <line x1={0} x2={W} y1={y + ROW_H} y2={y + ROW_H} stroke="var(--ink-line-soft)" />
            </g>
          );
        })}
      </svg>
    </div>
  );
}
