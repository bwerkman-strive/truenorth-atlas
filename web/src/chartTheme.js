// Shared recharts chrome, so every chart's tooltip reads the same.
//
// Follows the style guide's §6.4 convention: solid solstice fill, equinox
// border, light-sky label text. Item text color comes from each series' own
// stroke/fill; charts whose series carry no usable color (bars colored per
// Cell) must set an explicit itemStyle or recharts falls back to black.
export const TOOLTIP_PROPS = {
  contentStyle: { background: '#323140', border: '1px solid #514F60', borderRadius: 8, fontSize: 12 },
  labelStyle: { color: '#C4CEDA' },
};

export const AXIS_TICK = { fill: 'var(--text-faint)', fontSize: 11 };

// Data labels drawn over a plot. 12px is the floor for anything a reader has
// to read off the picture (the guide's fine-print floor), and a 3px ground-
// colored halo (paint-order stroke) keeps the text legible where it crosses
// a line or a fill. LABEL is a caption; LABEL_STRONG carries a value.
export const HALO = { stroke: 'var(--deep-black)', strokeWidth: 3, paintOrder: 'stroke' };
export const LABEL = { fontSize: 12, fill: 'var(--text-dim)', ...HALO };
export const LABEL_STRONG = { fontSize: 12.5, fontWeight: 600, fill: 'var(--text)', ...HALO };

// Halving epochs are ordered, so this is a ramp rather than a categorical set:
// the guide's neutral benchmark gray for the oldest epoch, then cool -> green
// through the §2.4 palette, with the current cycle drawn heavier. Every chart
// that colors by epoch (cycle overlays, bear rallies) reads from here so an
// epoch keeps one color across the app.
export const EPOCH_COLORS = { 1: '#9CA3AF', 2: '#C084FC', 3: '#60A5FA', 4: '#22D3EE', 5: '#4ADE80' };
export const EPOCH_WIDTH = { 5: 2.6 }; // current cycle drawn heavier
