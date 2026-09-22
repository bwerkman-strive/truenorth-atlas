import { fmtDay } from '../api.js';
import { EPOCH_COLORS, HALO } from '../chartTheme.js';

// Change in supply share by address-balance band since the cycle low, as
// diverging bars, with the same span after each earlier low drawn as a ghost
// dot in that epoch's color. SVG, so it exports like every other panel.
// FOOT_H leaves the lower-right corner clear for the watermark.
const W = 1000, ROW_H = 44, HEAD_H = 40, LABEL_W = 110, PAD_R = 130, FOOT_H = 30, AXIS_H = 26;
const pts = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(2)} pts`;

export default function DipBuyersChart({ data }) {
  const cur = data.current;
  const bands = data.bands;
  const H = HEAD_H + ROW_H * bands.length + AXIS_H + FOOT_H;
  const axisY = HEAD_H + ROW_H * bands.length + AXIS_H - 8;
  const plotX = LABEL_W, plotW = W - LABEL_W - PAD_R;
  // The axis is sized to the current cycle's bars with headroom; an early-
  // epoch ghost that swung far more than today's bands is pinned to the edge
  // and drawn hollow rather than letting one outlier flatten the chart.
  const own = (cur?.rows ?? []).filter(r => r.delta !== null).map(r => Math.abs(r.delta));
  const maxAbs = Math.max(0.002, ...own) * 1.6;
  const xOf = (v) => plotX + plotW / 2 + (Math.max(-maxAbs, Math.min(maxAbs, v)) / maxAbs) * (plotW / 2 - 10);
  const pinned = (v) => Math.abs(v) > maxAbs;
  const zero = xOf(0);
  return (
    <>
      <div className="chartwrap scorecard">
        <svg data-export viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Change in supply share by balance band"
          style={{ aspectRatio: `${W} / ${H}` }}>
          <text x={LABEL_W} y={20} fontSize={11} fill="var(--text-faint)" letterSpacing="0.05em">
            {cur ? `CHANGE IN SHARE OF SUPPLY SINCE THE ${fmtDay(cur.since).toUpperCase()} LOW (${cur.days} DAYS)` : 'NO OPEN CYCLE LOW'}
          </text>
          {/* Ghost legend lives in the header so the key below stays one line */}
          <text x={W - 44 * data.priors.length - 10} y={20} textAnchor="end" fontSize={11} fill="var(--text-faint)" letterSpacing="0.05em">GHOSTS, SAME SPAN AFTER EACH PRIOR LOW</text>
          {data.priors.map((p, i) => {
            const x = W - 44 * (data.priors.length - i) + 8;
            return (
              <g key={p.epoch}>
                <circle cx={x} cy={16} r={4.5} fill={EPOCH_COLORS[p.epoch] ?? 'var(--cold)'} stroke="var(--deep-black)" strokeWidth={1.2} />
                <text x={x + 9} y={20} fontSize={11.5} fontWeight={600} fill="var(--text-dim)" style={{ fontFamily: 'var(--font-data)' }}>E{p.epoch}</text>
              </g>
            );
          })}
          <line x1={zero} x2={zero} y1={HEAD_H - 6} y2={HEAD_H + ROW_H * bands.length} stroke="var(--text-faint)" />
          {bands.map((band, i) => {
            const y = HEAD_H + i * ROW_H;
            const r = cur?.rows.find(x => x.band === band);
            const d = r?.delta ?? null;
            const ghosts = data.priors.map(p => p.rows.find(x => x.band === band)?.delta).filter(v => v !== null && v !== undefined).map(xOf);
            // The value label starts just past the bar and slides outward past
            // any ghost dot that would sit under its text (~78 units wide).
            let lx = d === null ? 0 : d >= 0 ? xOf(d) + 8 : xOf(d) - 8;
            if (d !== null) {
              for (const g of [...ghosts].sort((a, b) => (d >= 0 ? a - b : b - a))) {
                if (d >= 0 ? g > lx - 8 && g < lx + 78 : g < lx + 8 && g > lx - 78) lx = d >= 0 ? g + 10 : g - 10;
              }
            }
            return (
              <g key={band}>
                {i % 2 === 1 && <rect x={0} y={y} width={W} height={ROW_H} fill="rgba(81, 79, 96, 0.08)" />}
                <text x={LABEL_W - 12} y={y + ROW_H / 2 + 4} textAnchor="end" fontSize={13} fontWeight={600} fill="var(--text)"
                  style={{ fontFamily: 'var(--font-data)' }}>{band} BTC</text>
                {d !== null && (
                  <rect x={Math.min(zero, xOf(d))} y={y + 12} width={Math.max(1.5, Math.abs(xOf(d) - zero))} height={ROW_H - 24} rx={3}
                    fill={d >= 0 ? 'var(--aurora)' : 'var(--hot)'} fillOpacity={0.8} />
                )}
                {data.priors.map(p => {
                  const pr = p.rows.find(x => x.band === band);
                  if (!pr || pr.delta === null) return null;
                  const c = EPOCH_COLORS[p.epoch] ?? 'var(--cold)';
                  return pinned(pr.delta)
                    ? <circle key={p.epoch} cx={xOf(pr.delta)} cy={y + ROW_H / 2} r={4.5} fill="none" stroke={c} strokeWidth={1.6} strokeDasharray="2 2" />
                    : <circle key={p.epoch} cx={xOf(pr.delta)} cy={y + ROW_H / 2} r={4.5} fill={c} stroke="var(--deep-black)" strokeWidth={1.2} />;
                })}
                {d !== null && (
                  <text x={lx} y={y + ROW_H / 2 + 4} textAnchor={d >= 0 ? 'start' : 'end'} fontSize={12.5} fontWeight={600}
                    fill="var(--text)" {...HALO} style={{ fontFamily: 'var(--font-data)' }}>{pts(d)}</text>
                )}
              </g>
            );
          })}
          <text x={xOf(-maxAbs)} y={axisY} fontSize={11.5} fill="var(--text-faint)">{pts(-maxAbs)}</text>
          <text x={zero} y={axisY} textAnchor="middle" fontSize={11.5} fill="var(--text-faint)">no change</text>
          <text x={xOf(maxAbs)} y={axisY} textAnchor="end" fontSize={11.5} fill="var(--text-faint)">{pts(maxAbs)}</text>
        </svg>
      </div>
      <div className="cycle-key">
        <span><i className="fill" style={{ background: 'rgba(52, 211, 153, 0.8)' }} />band gained share since the low</span>
        <span><i className="fill" style={{ background: 'rgba(248, 113, 113, 0.8)' }} />band lost share</span>
        <span className="cycle-note">
          ghosts: {data.priors.map(p => `E${p.epoch} ${fmtDay(p.low)}`).join(', ')} lows · points of addressed supply · dashed hollow: beyond the axis
        </span>
      </div>
    </>
  );
}
