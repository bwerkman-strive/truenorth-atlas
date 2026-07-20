// Render the on-screen chart to a PNG for "Copy chart image", so the shared
// picture is what the viewer is actually looking at (current range, scale,
// overlays, cycles or URPD view) rather than a canned server card.
//
// Four things make this more than "serialize the SVG":
//
//   1. Recharts styles marks with CSS custom properties (var(--btc) and
//      friends). An SVG rasterized through an <img> carries no page
//      stylesheet, so every var() would resolve to nothing. Computed values
//      are copied onto each node first.
//   2. Fonts are self-hosted woff2 and equally unavailable in that context.
//      SVG text inherits `body { font-family: var(--font-body) }`, which
//      resolves to IBM Plex *Sans* (--font-body -> --font-ui), so that is the
//      face embedded as base64. Canvas-drawn text does not need this: it runs
//      in the page context where the fonts are already loaded.
//   3. The legend (.cycle-key) and the watermark are HTML siblings of the
//      chart, not part of the SVG. Dropping them would make a multi-series
//      chart unreadable and a URPD chart meaningless, since its colour key is
//      the only thing explaining the green/red/orange bars.
//   4. The title and latest value live above .chartbox entirely, and a shared
//      image without them has no context.

// Copied verbatim onto every node. Values are NOT filtered for 'none' or
// 'normal': a child computing `stroke: none` under a parent that inherited a
// stroke must say so explicitly, or it picks the parent's up in the clone.
const STYLE_PROPS = [
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity',
  'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin', 'opacity',
  'font-family', 'font-size', 'font-weight', 'font-style', 'letter-spacing',
  'text-anchor', 'dominant-baseline', 'shape-rendering',
];

// --font-body -> --font-ui -> 'IBM Plex Sans'. This is what chart tick labels
// inherit, so it is the only face the embedded SVG needs.
const FONT_URL = '/fonts/ibm-plex-sans-400-normal.woff2';
const FONT_FAMILY = 'IBM Plex Sans';

const UI = '"IBM Plex Sans", system-ui, sans-serif';
const MONO = '"IBM Plex Mono", ui-monospace, monospace';

let fontCssPromise = null;

function toBase64(buf) {
  // Chunked: String.fromCharCode(...bytes) overflows the stack on a font-sized
  // array.
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function fontCss() {
  if (!fontCssPromise) {
    fontCssPromise = fetch(FONT_URL)
      .then(r => (r.ok ? r.arrayBuffer() : Promise.reject(new Error('font'))))
      .then(buf => `@font-face{font-family:'${FONT_FAMILY}';font-style:normal;`
        + `font-weight:400;src:url(data:font/woff2;base64,${toBase64(buf)}) format('woff2');}`)
      .catch(() => ''); // a fallback face beats failing the copy outright
  }
  return fontCssPromise;
}

function inlineStyles(source, clone) {
  const from = [source, ...source.querySelectorAll('*')];
  const to = [clone, ...clone.querySelectorAll('*')];
  for (let i = 0; i < from.length; i++) {
    const computed = window.getComputedStyle(from[i]);
    for (const prop of STYLE_PROPS) {
      const v = computed.getPropertyValue(prop);
      if (v) to[i].setAttribute(prop, v);
    }
  }
}

// The legend is HTML: `<span><i style="background:…"/>label</span>`, plus a
// trailing note span with no swatch.
function readLegend(container) {
  const key = container.querySelector('.cycle-key');
  if (!key) return [];
  return [...key.querySelectorAll(':scope > span')].map(s => {
    const sw = s.querySelector('i');
    return {
      color: sw ? window.getComputedStyle(sw).backgroundColor : null,
      text: s.textContent.trim(),
    };
  }).filter(x => x.text);
}

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

async function rasterizeSvg(svg, w, h, scale) {
  const clone = svg.cloneNode(true);
  inlineStyles(svg, clone);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  // Rasterize the vector AT output resolution. Giving the image its logical
  // size and letting the canvas transform enlarge it would upscale a 1x bitmap
  // and ship a visibly soft chart; the viewBox keeps the coordinate system.
  clone.setAttribute('viewBox', clone.getAttribute('viewBox') || `0 0 ${w} ${h}`);
  clone.setAttribute('width', String(w * scale));
  clone.setAttribute('height', String(h * scale));

  const css = await fontCss();
  if (css) {
    const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent = css;
    clone.insertBefore(style, clone.firstChild);
  }

  const markup = new XMLSerializer().serializeToString(clone);
  const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    return await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('svg rasterize failed'));
      el.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Rasterize the chart inside `container` (the .chartbox element) to a PNG Blob,
 * framed with the metric title, its latest value, the legend and the watermark.
 * Rejects when no chart is on screen so the caller can fall back.
 */
export async function chartToPngBlob(container, { title = '', value = '', scale = 2 } = {}) {
  const svg = container?.querySelector('svg.recharts-surface');
  if (!svg) throw new Error('no chart to copy');

  // Canvas text uses page fonts; make sure they have actually loaded, or the
  // header and legend silently fall back to a system face.
  if (document.fonts?.ready) { try { await document.fonts.ready; } catch { /* non-fatal */ } }

  const box = svg.getBoundingClientRect();
  const cw = Math.max(1, Math.round(box.width));
  const ch = Math.max(1, Math.round(box.height));
  const img = await rasterizeSvg(svg, cw, ch, scale);

  const legend = readLegend(container);
  const PAD = 20;
  const headerH = title ? 40 : 0;
  const legendH = legend.length ? 14 + Math.ceil(legend.length / 3) * 20 : 0;
  const W = cw + PAD * 2;
  const H = headerH + ch + legendH + PAD * 2;

  const canvas = document.createElement('canvas');
  canvas.width = W * scale;
  canvas.height = H * scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);

  const ink = cssVar('--text', '#f2ede3');
  const dim = cssVar('--text-dim', '#9a958c');
  const orange = cssVar('--orange', '#f7931a');
  const panel = getComputedStyle(container).backgroundColor;
  ctx.fillStyle = panel && panel !== 'rgba(0, 0, 0, 0)' ? panel : cssVar('--ink-panel', '#111');
  ctx.fillRect(0, 0, W, H);

  let y = PAD;
  if (title) {
    ctx.textBaseline = 'alphabetic';
    ctx.font = `600 17px ${UI}`;
    ctx.fillStyle = ink;
    ctx.fillText(title, PAD, y + 17);
    if (value) {
      ctx.font = `500 17px ${MONO}`;
      ctx.textAlign = 'right';
      ctx.fillText(value, W - PAD, y + 17);
      ctx.textAlign = 'left';
    }
    y += headerH;
  }

  ctx.drawImage(img, PAD, y, cw, ch);

  // Watermark: centred on the plot itself, matching the on-screen placement.
  ctx.save();
  ctx.globalAlpha = 0.3;
  ctx.font = `700 12px ${UI}`;
  ctx.textBaseline = 'middle';
  const lockup = 'TRUE NORTH ';
  const wl = ctx.measureText(lockup).width;
  const wa = ctx.measureText('ATLAS').width;
  const wx = PAD + (cw - (wl + wa)) / 2;
  const wy = y + ch / 2;
  ctx.fillStyle = ink;
  ctx.fillText(lockup, wx, wy);
  ctx.fillStyle = orange;
  ctx.fillText('ATLAS', wx + wl, wy);
  ctx.restore();

  y += ch + 14;
  if (legend.length) {
    ctx.font = `12px ${UI}`;
    ctx.textBaseline = 'middle';
    let x = PAD;
    for (const item of legend) {
      const tw = ctx.measureText(item.text).width;
      const need = (item.color ? 16 : 0) + tw + 18;
      if (x > PAD && x + need > W - PAD) { x = PAD; y += 20; }
      if (item.color) {
        ctx.fillStyle = item.color;
        ctx.fillRect(x, y + 3, 9, 9);
        x += 16;
      }
      ctx.fillStyle = dim;
      ctx.fillText(item.text, x, y + 7);
      x += tw + 18;
    }
  }

  return await new Promise((resolve, reject) => {
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/png');
  });
}
