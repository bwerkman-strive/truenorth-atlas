// Pure helpers for the Cost Basis Heatmap (components/HeatmapChart.jsx):
// the color ramp, the intensity scale, and the geometry that maps grid rows
// and columns onto pixels. Unit-tested under node:test without a DOM.

// Sequential ramp on the dark ground: nothing -> the brand orange -> a warm
// near-white at the hottest cells. One hue, brightness carries magnitude.
const ORANGE = [247, 148, 29];
const HOT = [255, 241, 220];
const lerp = (a, b, t) => a + (b - a) * t;
export function heatColor(t) {
  const x = Math.max(0, Math.min(1, t));
  if (x <= 0) return 'rgba(247, 148, 29, 0)';
  if (x < 0.55) {
    const u = x / 0.55;
    return `rgba(${ORANGE[0]}, ${ORANGE[1]}, ${ORANGE[2]}, ${(0.12 + 0.88 * u).toFixed(3)})`;
  }
  const u = (x - 0.55) / 0.45;
  return `rgb(${Math.round(lerp(ORANGE[0], HOT[0], u))}, ${Math.round(lerp(ORANGE[1], HOT[1], u))}, ${Math.round(lerp(ORANGE[2], HOT[2], u))})`;
}

// Cells are drawn as a SHARE of that day's supply (resolved cells plus the
// unresolved floor), not raw BTC: supply grew from 3M to 20M coins over the
// picture, and shares keep 2011 and 2026 on one brightness scale.
export const columnTotal = (c) => (c.cells.reduce((s, v) => s + v, 0) + (c.floor ?? 0)) || 1;

// The share that maps to full brightness: the 99th percentile of non-zero
// cell shares, so a handful of extreme cells cannot wash out the rest.
export function clipValue(columns, fallback = 1) {
  const vals = [];
  for (const c of columns ?? []) {
    const total = columnTotal(c);
    for (const v of c.cells) if (v > 0) vals.push(v / total);
  }
  if (!vals.length) return fallback;
  vals.sort((a, b) => a - b);
  return vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.99))] || fallback;
}

// Lay cluster labels out top to bottom without overlapping: each label wants
// its bracket's centre, and is pushed down below the previous one if needed.
export function stackLabels(centers, lineH, minY = -Infinity) {
  const out = [];
  let floor = minY;
  for (const c of [...centers].sort((a, b) => a - b)) {
    const y = Math.max(c, floor);
    out.push(y);
    floor = y + lineH;
  }
  return out;
}

// Linear in share up to the clip: the median cell holds under 1% of supply
// and the brightest about 20%, so a linear ramp keeps the dense clusters
// distinct from the everyday terrain (a square root washed them together).
export const intensity = (v, clip) => (v <= 0 || clip <= 0 ? 0 : Math.min(1, v / clip));

// Log-price -> vertical position within a plot of height h (0 at the top).
export function yForPrice(p, levels, h) {
  const lo = Math.log(levels[0]), hi = Math.log(levels[levels.length - 1]);
  if (!(p > 0)) return h;
  const f = (Math.log(p) - lo) / (hi - lo);
  return h - Math.max(0, Math.min(1, f)) * h;
}

// Decade ticks that fall inside the grid.
export function priceTicks(levels) {
  const out = [];
  for (let e = -2; e <= 7; e++) {
    const p = 10 ** e;
    if (p >= levels[0] && p <= levels[levels.length - 1]) out.push(p);
  }
  return out;
}

// Column index of the first sample in each year.
export function yearColumns(columns) {
  const seen = new Set(), out = [];
  columns.forEach((c, i) => {
    const y = c.day.slice(0, 4);
    if (!seen.has(y)) { seen.add(y); out.push({ i, year: y }); }
  });
  return out;
}

// Pixel -> { ci, ri } within a plot of w x h with the given grid shape.
export function cellAt(px, py, nCols, nRows, w, h) {
  if (px < 0 || py < 0 || px >= w || py >= h) return null;
  const ci = Math.min(nCols - 1, Math.floor((px / w) * nCols));
  const ri = Math.min(nRows - 1, Math.floor(((h - py) / h) * nRows));
  return { ci, ri };
}
