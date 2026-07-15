// The "bearing dial" — this module's signature element.
// A compass-style arc showing where today's reading sits within the metric's
// entire history (percentile 0–100). Cold (blue) = historically depressed,
// aurora (green) = mid-range, hot (orange-red) = historically stretched.
// For an allocator, "where are we vs. all of history" is the first question;
// the dial answers it before a single chart is opened.
export default function BearingDial({ percentile, size = 46 }) {
  if (percentile === null || percentile === undefined) {
    return <svg className="dial" width={size} height={size} aria-hidden="true" />;
  }
  const p = Math.max(0, Math.min(1, percentile));
  const cx = size / 2, cy = size / 2 + 3, r = size / 2 - 5;
  const a0 = Math.PI * 1.15, a1 = Math.PI * -0.15; // 234° sweep
  const ang = a0 + (a1 - a0) * p;
  const pt = (a, rad) => [cx + rad * Math.cos(a), cy - rad * Math.sin(a)];
  const arc = (from, to, rad) => {
    const [x0, y0] = pt(from, rad), [x1, y1] = pt(to, rad);
    const large = Math.abs(to - from) > Math.PI ? 1 : 0;
    return `M ${x0} ${y0} A ${rad} ${rad} 0 ${large} 1 ${x1} ${y1}`;
  };
  const color = p < 0.2 ? 'var(--cold)' : p > 0.8 ? 'var(--hot)' : 'var(--aurora)';
  const [nx, ny] = pt(ang, r - 1);

  return (
    <svg className="dial" width={size} height={size} role="img"
      aria-label={`Historical percentile ${(p * 100).toFixed(0)}`}>
      <title>{`Bearing: today's value is higher than ${(p * 100).toFixed(0)}% of all history: ` +
        (p < 0.2 ? 'historically depressed' : p > 0.8 ? 'historically stretched' : 'mid-range')}</title>
      <path d={arc(a0, a1, r)} stroke="var(--ink-line)" strokeWidth="3" fill="none" strokeLinecap="round" />
      <path d={arc(a0, ang, r)} stroke={color} strokeWidth="3" fill="none" strokeLinecap="round" />
      <line x1={cx} y1={cy} x2={nx} y2={ny} stroke={color} strokeWidth="1.6" />
      <circle cx={cx} cy={cy} r="2.2" fill={color} />
      <text x={cx} y={size - 1} textAnchor="middle" fontSize="9.5" fill="var(--text-faint)">
        {(p * 100).toFixed(0)}
      </text>
    </svg>
  );
}
