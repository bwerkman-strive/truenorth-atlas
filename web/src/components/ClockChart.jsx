import { useMemo, useState } from 'react';
import { fmt, fmtDay } from '../api.js';
import { EPOCH_COLORS } from '../chartTheme.js';
import { mvrvColor, arcPath, polar, ringRadii, ringSegments } from '../clockRows.js';

const S = 700, CX = S / 2, CY = S / 2;
const HOURS = [0, 0.25, 0.5, 0.75];

// Each halving epoch as a ring, twelve o'clock the halving, colored by MVRV.
// Peaks and lows sit on the dial where they fell; the hand is today, and the
// readings under it on the earlier rings are printed beside it.
export default function ClockChart({ data }) {
  const [hover, setHover] = useState(null);
  const rings = useMemo(() => ringRadii(data.epochs.length), [data.epochs.length]);
  const segs = useMemo(() => data.epochs.map(e => ringSegments(e.samples)), [data]);
  const t = data.today;
  const outerR = rings.length ? rings[rings.length - 1].r1 : 290;
  return (
    <>
      <div className="chartwrap clock">
        <svg data-export viewBox={`0 0 ${S} ${S}`} role="img" aria-label="Cycle clock">
          {/* Dial: quarter marks and the halving at twelve. */}
          {HOURS.map(h => {
            const [x1, y1] = polar(CX, CY, rings[0]?.r0 - 10 || 60, h), [x2, y2] = polar(CX, CY, outerR + 8, h);
            const [lx, ly] = polar(CX, CY, outerR + 22, h);
            return (
              <g key={h}>
                <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--ink-line)" strokeDasharray="2 5" />
                <text x={lx} y={ly + 4} textAnchor="middle" fontSize={12} fill="var(--text-dim)" letterSpacing="0.05em">
                  {h === 0 ? 'HALVING' : `${Math.round(h * 100)}%`}
                </text>
              </g>
            );
          })}
          {data.epochs.map((e, i) => {
            const { r0, r1 } = rings[i];
            return (
              <g key={e.epoch}>
                <circle cx={CX} cy={CY} r={(r0 + r1) / 2} fill="none" stroke="var(--ink-line-soft)" strokeWidth={r1 - r0} />
                {segs[i].map((sg, k) => (
                  <path key={k} d={arcPath(CX, CY, r0, r1, sg.t0, sg.t1)} fill={sg.color}
                    stroke={hover?.epoch === e.epoch && hover?.day === sg.sample.day ? 'var(--text)' : 'none'} strokeWidth={1}
                    onMouseEnter={() => setHover({ epoch: e.epoch, ...sg.sample })} onMouseLeave={() => setHover(null)} />
                ))}
                {/* Epoch number at the ring's start */}
                {(() => { const [x, y] = polar(CX, CY, (r0 + r1) / 2, 0.005); return (
                  <text x={x + 6} y={y + 4} fontSize={11.5} fontWeight={600} fill={EPOCH_COLORS[e.epoch] ?? 'var(--text)'}
                    stroke="var(--deep-black)" strokeWidth={3} paintOrder="stroke">E{e.epoch}</text>
                ); })()}
                {e.peak && (() => { const [x, y] = polar(CX, CY, r1 + 3, e.peak.t); return (
                  <path d={`M ${x} ${y} l -4 -7 h 8 z`} fill="var(--text)" transform={`rotate(${e.peak.t * 360} ${x} ${y})`} />
                ); })()}
                {e.low && (() => { const [x, y] = polar(CX, CY, r0 - 3, e.low.t); return (
                  <path d={`M ${x} ${y} l -4 7 h 8 z`} fill={e.low.provisional ? 'var(--amber)' : 'var(--text)'}
                    transform={`rotate(${e.low.t * 360} ${x} ${y})`} />
                ); })()}
              </g>
            );
          })}
          {/* The hand: today, from the dial's centre out across every ring, with a
              dot where it crosses each ring. The readings under it are listed
              at the top left so they never crowd the rings. */}
          {t && (() => {
            const [sx, sy] = polar(CX, CY, (rings[0]?.r0 ?? 78) - 14, t.t);
            const [hx, hy] = polar(CX, CY, outerR + 6, t.t);
            const readings = data.epochs.map((e, i) => ({
              epoch: e.epoch, ring: rings[i],
              v: e.open ? t.mvrv : data.atHour.find(a => a.epoch === e.epoch)?.mvrv ?? null,
            })).filter(r => r.v !== null && r.v !== undefined);
            return (
              <g>
                <line x1={sx} y1={sy} x2={hx} y2={hy} stroke="var(--text)" strokeWidth={1.6} />
                <circle cx={hx} cy={hy} r={4} fill="var(--text)" />
                {readings.map(r => {
                  const [x, y] = polar(CX, CY, (r.ring.r0 + r.ring.r1) / 2, t.t);
                  return <circle key={r.epoch} cx={x} cy={y} r={2.6} fill="var(--deep-black)" stroke="var(--text)" strokeWidth={1.2} />;
                })}
                <text x={16} y={26} fontSize={11.5} fill="var(--text-dim)" letterSpacing="0.05em">AT THIS HOUR</text>
                {readings.map((r, k) => (
                  <g key={r.epoch}>
                    <circle cx={21} cy={48 + k * 20} r={4.5} fill={mvrvColor(r.v)} />
                    <text x={32} y={52 + k * 20} fontSize={12.5} fill="var(--text-dim)">
                      E{r.epoch} <tspan fontWeight={600} fill="var(--text)" style={{ fontFamily: 'var(--font-data)' }}>{r.v.toFixed(2)}</tspan>
                    </text>
                  </g>
                ))}
              </g>
            );
          })()}
          {/* Centre: the open epoch and its progress. */}
          <text x={CX} y={CY - 6} textAnchor="middle" fontSize={13} fill="var(--text-faint)" letterSpacing="0.1em">EPOCH {t?.epoch ?? ''}</text>
          <text x={CX} y={CY + 22} textAnchor="middle" fontSize={26} fontWeight={600} fill="var(--text)" style={{ fontFamily: 'var(--font-data)' }}>
            {t?.progress !== null && t?.progress !== undefined ? `${Math.round(t.progress * 100)}%` : ''}
          </text>
          {hover && (
            <g>
              <rect x={CX - 118} y={S - 46} width={236} height={36} rx={8} fill="#323140" stroke="#514F60" />
              <text x={CX} y={S - 31} textAnchor="middle" fontSize={11} fill="var(--text-dim)">
                Epoch {hover.epoch} · {fmtDay(hover.day)} · {fmt(hover.price, 'usd')}
              </text>
              <text x={CX} y={S - 16} textAnchor="middle" fontSize={12} fontWeight={600} fill={mvrvColor(hover.mvrv)}>
                MVRV {hover.mvrv?.toFixed(2)}
              </text>
            </g>
          )}
        </svg>
      </div>
      <div className="cycle-key">
        <span className="clock-scale"><i />MVRV, blue below 1 to red above 3</span>
        <span>▲ cycle peak (outer edge)</span>
        <span>▼ cycle low (inner edge)</span>
        <span><i style={{ background: 'var(--text)' }} />today</span>
        <span className="cycle-note">twelve o’clock is the halving · inner ring is the oldest epoch · the open epoch’s length is projected from block progress</span>
      </div>
    </>
  );
}
