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
