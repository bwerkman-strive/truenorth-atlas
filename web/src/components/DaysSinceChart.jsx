import { fmt, fmtDay } from '../api.js';

// Four counters in a row: the number, what it counts from, and the prior
// cycle's span for the same leg beneath it. SVG so it exports as a card.
const TILE_W = 280, TILE_H = 178, GAP = 16;

export default function DaysSinceChart({ data }) {
  const items = data.items;
  const W = items.length * TILE_W + (items.length - 1) * GAP;
  const H = TILE_H;
  return (
    <>
      <div className="chartwrap scorecard">
        <svg data-export viewBox={`0 0 ${W} ${H}`} width="100%" role="list" aria-label="Days since" style={{ aspectRatio: `${W} / ${H}` }}>
          {items.map((it, i) => {
            const x = i * (TILE_W + GAP);
            const ratio = it.prior ? Math.min(1, it.days / Math.max(1, it.prior.days)) : null;
            return (
              <g key={it.key} role="listitem">
                <rect x={x} y={0} width={TILE_W} height={H} rx={12} fill="rgba(50, 49, 64, 0.30)" stroke="rgba(81, 79, 96, 0.30)" />
                <text x={x + 20} y={30} fontSize={11.5} fontWeight={600} fill="var(--orange-pill)" letterSpacing="0.1em">
                  {it.label.toUpperCase()}
                </text>
                <text x={x + 20} y={82} fontSize={44} fontWeight={600} fill="var(--text)" style={{ fontFamily: 'var(--font-data)', fontVariantNumeric: 'tabular-nums' }}>
                  {it.days.toLocaleString('en-US')}
                </text>
                <text x={x + 20 + 12 + String(it.days.toLocaleString('en-US')).length * 26} y={82} fontSize={14} fill="var(--text-dim)">days</text>
                <text x={x + 20} y={108} fontSize={12.5} fill="var(--text-dim)" style={{ fontFamily: 'var(--font-data)' }}>
                  {fmtDay(it.date)}{it.key === 'ath' || it.key === 'low' ? ` · ${fmt(it.value, 'usd')}` : it.key === 'nextHalving' ? ` · ${it.value.toLocaleString('en-US')} blocks left` : ''}
                </text>
                {it.prior && (
                  <g>
                    <rect x={x + 20} y={128} width={TILE_W - 40} height={6} rx={3} fill="rgba(81, 79, 96, 0.35)" />
                    <rect x={x + 20} y={128} width={Math.max(4, (TILE_W - 40) * ratio)} height={6} rx={3} fill="var(--orange-pill)" />
                    <text x={x + 20} y={156} fontSize={11.5} fill="var(--text-faint)">
                      {it.prior.label}: <tspan fill="var(--text-dim)" fontWeight={600} style={{ fontFamily: 'var(--font-data)' }}>{it.prior.days.toLocaleString('en-US')}d</tspan>
                    </text>
                  </g>
                )}
              </g>
            );
          })}
        </svg>
      </div>
      <div className="cycle-key">
        <span><i style={{ background: 'var(--orange-pill)' }} />today’s count as a share of the prior cycle’s span for the same leg</span>
        <span className="cycle-note">UTC calendar days · the next halving is estimated at ten minutes per remaining block</span>
      </div>
    </>
  );
}
