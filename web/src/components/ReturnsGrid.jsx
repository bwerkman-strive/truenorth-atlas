// Monthly returns as a calendar grid: years down, months across, a tile per
// month tinted by sign and size, year totals at the edge, the current month
// outlined and provisional. SVG so it exports like every other panel.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const YEAR_W = 64, CELL_W = 74, TOTAL_W = 88, ROW_H = 34, HEAD_H = 34;
const W = YEAR_W + CELL_W * 12 + TOTAL_W;
const tint = (r) => {
  if (r === null || r === undefined) return 'transparent';
  const a = Math.min(1, Math.abs(r) / 0.5); // 50% moves and beyond are full strength
  return r >= 0 ? `rgba(52, 211, 153, ${(0.08 + 0.42 * a).toFixed(3)})` : `rgba(248, 113, 113, ${(0.08 + 0.42 * a).toFixed(3)})`;
};
const label = (r) => (r === null || r === undefined ? '' : `${r >= 0 ? '+' : '−'}${Math.abs(r * 100).toFixed(Math.abs(r) >= 1 ? 0 : 1)}%`);

export default function ReturnsGrid({ data }) {
  const years = [...data.years].reverse(); // newest on top
  // The extra foot keeps the lower-right corner clear for the watermark.
  const H = HEAD_H + ROW_H * years.length + 36;
  const cur = data.current;
  return (
    <>
      <div className="chartwrap scorecard">
        <svg data-export viewBox={`0 0 ${W} ${H}`} width="100%" role="table" aria-label="Monthly returns" style={{ aspectRatio: `${W} / ${H}` }}>
          {MONTHS.map((m, i) => (
            <text key={m} x={YEAR_W + i * CELL_W + CELL_W / 2} y={22} textAnchor="middle" fontSize={11.5} fontWeight={600}
              fill={cur && cur.month === i + 1 ? 'var(--text)' : 'var(--text-faint)'} letterSpacing="0.05em">{m.toUpperCase()}</text>
          ))}
          <text x={YEAR_W + 12 * CELL_W + TOTAL_W / 2} y={22} textAnchor="middle" fontSize={11.5} fontWeight={600} fill="var(--text-faint)" letterSpacing="0.05em">YEAR</text>
          {years.map((yr, r) => {
            const y = HEAD_H + r * ROW_H;
            return (
              <g key={yr.year}>
                <text x={YEAR_W - 12} y={y + ROW_H / 2 + 4} textAnchor="end" fontSize={13} fontWeight={600} fill="var(--text)" style={{ fontFamily: 'var(--font-data)' }}>{yr.year}</text>
                {yr.months.map((m, i) => {
                  const x = YEAR_W + i * CELL_W;
                  const isCur = cur && cur.year === yr.year && cur.month === i + 1;
                  return (
                    <g key={i}>
                      <rect x={x + 2} y={y + 2} width={CELL_W - 4} height={ROW_H - 4} rx={5} fill={tint(m)}
                        stroke={isCur ? 'var(--amber)' : 'none'} strokeWidth={1.5} strokeDasharray={isCur ? '4 3' : undefined} />
                      <text x={x + CELL_W / 2} y={y + ROW_H / 2 + 4} textAnchor="middle" fontSize={12} fontWeight={600}
                        fill={m === null ? 'var(--text-quiet)' : 'var(--text)'} style={{ fontFamily: 'var(--font-data)', fontVariantNumeric: 'tabular-nums' }}>
                        {m === null ? '' : label(m)}
                      </text>
                    </g>
                  );
                })}
                {(() => {
                  const x = YEAR_W + 12 * CELL_W;
                  return (
                    <g>
                      <rect x={x + 6} y={y + 2} width={TOTAL_W - 8} height={ROW_H - 4} rx={5} fill={tint(yr.total)} />
                      <text x={x + TOTAL_W / 2 + 2} y={y + ROW_H / 2 + 4} textAnchor="middle" fontSize={12.5} fontWeight={700}
                        fill="var(--text)" style={{ fontFamily: 'var(--font-data)', fontVariantNumeric: 'tabular-nums' }}>
                        {label(yr.total)}{yr.partial && yr.total !== null ? '*' : ''}
                      </text>
                    </g>
                  );
                })()}
              </g>
            );
          })}
        </svg>
      </div>
      <div className="cycle-key">
        <span><i className="fill" style={{ background: 'rgba(52, 211, 153, 0.5)' }} />month closed higher</span>
        <span><i className="fill" style={{ background: 'rgba(248, 113, 113, 0.5)' }} />month closed lower</span>
        <span><i className="fill" style={{ border: '1.5px dashed var(--amber)', background: 'transparent', boxSizing: 'border-box' }} />current month, to date</span>
        <span className="cycle-note">close to close, UTC · deeper tint for larger moves · * year to date</span>
      </div>
    </>
  );
}
