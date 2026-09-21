import { fmt, fmtDay } from '../api.js';
import { EPOCH_COLORS } from '../chartTheme.js';

// From today's position in the epoch, what each earlier epoch did over the
// next 90, 180 and 365 days: one row per epoch, one diverging bar per
// horizon. A record, not a projection, and the chart says so.
const W = 1000, ROW_H = 56, HEAD_H = 44, LEFT_W = 250;
const signed = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(0)}%`;

export default function SameHourChart({ data }) {
  const rows = data.rows;
  const hz = data.horizons;
  const H = HEAD_H + ROW_H * rows.length + 34;
  const colW = (W - LEFT_W) / hz.length;
  const maxAbs = Math.max(0.1, ...rows.flatMap(r => r.forward.map(f => Math.abs(f.change ?? 0))));
  const barX = (h, v) => LEFT_W + h * colW + colW / 2 + (v / maxAbs) * (colW / 2 - 40);
  return (
    <>
      <div className="chartwrap scorecard">
        <svg data-export viewBox={`0 0 ${W} ${H}`} width="100%" role="table" aria-label="Same hour in past cycles" style={{ aspectRatio: `${W} / ${H}` }}>
          <text x={0} y={18} fontSize={11.5} fill="var(--text-faint)" letterSpacing="0.05em">
            {data.today ? `TODAY: EPOCH ${data.today.epoch}, DAY ${data.today.elapsed}${data.today.progress !== null ? ` (${Math.round(data.today.progress * 100)}% BY BLOCKS)` : ''}` : ''}
          </text>
          <text x={0} y={36} fontSize={11.5} fill="var(--text-faint)">Matching day in each earlier epoch</text>
          {hz.map((h, i) => (
            <text key={h} x={LEFT_W + i * colW + colW / 2} y={36} textAnchor="middle" fontSize={11.5} fontWeight={600} fill="var(--text-faint)" letterSpacing="0.05em">
              NEXT {h} DAYS
            </text>
          ))}
          {rows.map((r, k) => {
            const y = HEAD_H + k * ROW_H;
            const accent = EPOCH_COLORS[r.epoch] ?? 'var(--cold)';
            return (
              <g key={r.epoch}>
                {k % 2 === 1 && <rect x={0} y={y} width={W} height={ROW_H} fill="rgba(81, 79, 96, 0.08)" />}
                <rect x={0} y={y + 10} width={3} height={ROW_H - 20} rx={1.5} fill={accent} />
                <text x={14} y={y + 24} fontSize={13} fontWeight={600} fill="var(--text)">Epoch {r.epoch}</text>
                <text x={14} y={y + 42} fontSize={11.5} fill="var(--text-faint)" style={{ fontFamily: 'var(--font-data)' }}>
                  {fmtDay(r.day)} · day {r.elapsed} · {fmt(r.price, 'usd')}
                </text>
                {r.forward.map((f, i) => {
                  const zero = barX(i, 0);
                  if (f.change === null) {
                    return <text key={i} x={zero} y={y + ROW_H / 2 + 4} textAnchor="middle" fontSize={12} fill="var(--text-quiet)">not yet</text>;
                  }
                  const x = barX(i, f.change);
                  return (
                    <g key={i}>
                      <line x1={zero} x2={zero} y1={y + 12} y2={y + ROW_H - 12} stroke="var(--ink-line)" />
                      <rect x={Math.min(zero, x)} y={y + 16} width={Math.max(1.5, Math.abs(x - zero))} height={ROW_H - 32} rx={3}
                        fill={f.change >= 0 ? 'var(--aurora)' : 'var(--hot)'} fillOpacity={0.8} />
                      <text x={f.change >= 0 ? x + 6 : x - 6} y={y + ROW_H / 2 + 4} textAnchor={f.change >= 0 ? 'start' : 'end'} fontSize={12.5} fontWeight={600}
                        fill="var(--text)" style={{ fontFamily: 'var(--font-data)' }}>{signed(f.change)}</text>
                    </g>
                  );
                })}
              </g>
            );
          })}
          <text x={0} y={H - 10} fontSize={11.5} fill="var(--text-faint)">History, not a forecast: each cycle had its own conditions.</text>
        </svg>
      </div>
      <div className="cycle-key">
        <span><i className="fill" style={{ background: 'rgba(52, 211, 153, 0.8)' }} />price higher after the horizon</span>
        <span><i className="fill" style={{ background: 'rgba(248, 113, 113, 0.8)' }} />price lower</span>
        <span className="cycle-note">matching day = each epoch’s start plus today’s block progress times its length</span>
      </div>
    </>
  );
}
