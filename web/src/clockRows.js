// Pure helpers for the Cycle Clock (components/ClockChart.jsx): the MVRV
// color scale, ring geometry, and arc paths. Unit-tested without a DOM.

// Diverging MVRV scale: cold below the cost basis, neutral around 1.5, hot
// when stretched. Stops interpolate in RGB; values clamp at the ends.
const STOPS = [
  [0.6, [96, 165, 250]],   // blue-400
  [1.0, [127, 178, 240]],
  [1.5, [156, 163, 175]],  // neutral gray
  [2.5, [251, 191, 36]],   // amber-400
  [3.5, [248, 113, 113]],  // red-400
];
export function mvrvColor(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return 'rgba(156, 163, 175, 0.25)';
  if (v <= STOPS[0][0]) return rgb(STOPS[0][1]);
  if (v >= STOPS[STOPS.length - 1][0]) return rgb(STOPS[STOPS.length - 1][1]);
  for (let i = 1; i < STOPS.length; i++) {
    if (v <= STOPS[i][0]) {
      const [a, ca] = STOPS[i - 1], [b, cb] = STOPS[i];
      const t = (v - a) / (b - a);
      return rgb(ca.map((x, k) => Math.round(x + (cb[k] - x) * t)));
    }
  }
  return rgb(STOPS[STOPS.length - 1][1]);
}
const rgb = (c) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;

// Fraction of a turn (0 = twelve o'clock, clockwise) -> radians in SVG space.
export const angleOf = (t) => t * 2 * Math.PI - Math.PI / 2;
export const polar = (cx, cy, r, t) => [cx + r * Math.cos(angleOf(t)), cy + r * Math.sin(angleOf(t))];

// Annular sector from t0 to t1 between radii r0 < r1.
export function arcPath(cx, cy, r0, r1, t0, t1) {
  const span = Math.min(0.9999, Math.max(0, t1 - t0));
  const [ax, ay] = polar(cx, cy, r1, t0), [bx, by] = polar(cx, cy, r1, t0 + span);
  const [dx, dy] = polar(cx, cy, r0, t0 + span), [ex, ey] = polar(cx, cy, r0, t0);
  const large = span > 0.5 ? 1 : 0;
  const f = (n) => n.toFixed(2);
  return `M ${f(ax)} ${f(ay)} A ${f(r1)} ${f(r1)} 0 ${large} 1 ${f(bx)} ${f(by)} `
    + `L ${f(dx)} ${f(dy)} A ${f(r0)} ${f(r0)} 0 ${large} 0 ${f(ex)} ${f(ey)} Z`;
}

// Ring radii, innermost first: the oldest epoch sits inside, the current
// one outside and thicker, with a hairline gap between rings.
export function ringRadii(n, { inner = 78, outer = 290, gap = 4 } = {}) {
  if (n <= 0) return [];
  const weights = Array.from({ length: n }, (_, i) => 1 + i * 0.25); // outer rings a little thicker
  const total = weights.reduce((s, w) => s + w, 0);
  const avail = outer - inner - gap * (n - 1);
  const out = [];
  let r = inner;
  for (let i = 0; i < n; i++) {
    const th = avail * (weights[i] / total);
    out.push({ r0: r, r1: r + th });
    r += th + gap;
  }
  return out;
}

// Consecutive samples -> arc segments [{ t0, t1, color, sample }].
export function ringSegments(samples) {
  const segs = [];
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const t1 = i + 1 < samples.length ? samples[i + 1].t : Math.min(1, s.t + 0.004);
    if (t1 <= s.t) continue;
    segs.push({ t0: s.t, t1, color: mvrvColor(s.mvrv), sample: s });
  }
  return segs;
}
