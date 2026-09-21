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
//      SVG text inherits the page faces (Inter for labels, JetBrains Mono for
//      figures), so both variable fonts are embedded as base64. Canvas-drawn
//      text does not need this: it runs in the page context where the fonts
//      are already loaded.
//   3. The legend (.cycle-key) and the watermark are HTML siblings of the
//      chart, not part of the SVG. Dropping them would make a multi-series
//      chart unreadable and a URPD chart meaningless, since its colour key is
//      the only thing explaining the green/red/orange bars.
//   4. The title and latest value live above .chartbox entirely, and a shared
//      image without them has no context.
//
// The output is a "story card": header (title, percentile gauge, headline
// value), the one-sentence takeaway, the chart with its watermark, the
// legend, and an as-of footer. `aspect` frames it as drawn ('auto'), 16:9
// ('wide', for X and LinkedIn) or 1:1 ('square'), padding the ground rather
// than distorting anything.
//
// Two entry points share the drawing code: chartToPngBlob() for a single
// chart box (every recharts surface in it, stacked as on screen), and
// tilesToPngBlob() for a grid of chart tiles (the bear-market bottoms), which
// reproduces each tile at its on-screen position with its own caption and
// watermark under one shared header and legend.

// Copied verbatim onto every node. Values are NOT filtered for 'none' or
// 'normal': a child computing `stroke: none` under a parent that inherited a
// stroke must say so explicitly, or it picks the parent's up in the clone.
const STYLE_PROPS = [
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity',
  'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin', 'opacity',
  'font-family', 'font-size', 'font-weight', 'font-style', 'letter-spacing',
  'text-anchor', 'dominant-baseline', 'shape-rendering',
];

// The two self-hosted variable faces (web/src/fonts.css): Inter for tick
// labels and captions, JetBrains Mono for figures. Both are embedded so the
// SVG rasterizes in the page's own type.
const FONTS = [
  { family: 'Inter', url: '/fonts/inter-latin-wght-normal.woff2' },
  { family: 'JetBrains Mono', url: '/fonts/jetbrains-mono-latin-wght-normal.woff2' },
];

const UI = 'Inter, system-ui, sans-serif';
const MONO = '"JetBrains Mono", ui-monospace, monospace';
const PAD = 20;
const ASPECT = { wide: 16 / 9, square: 1 };

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
    fontCssPromise = Promise.all(FONTS.map(f => fetch(f.url)
      .then(r => (r.ok ? r.arrayBuffer() : Promise.reject(new Error('font'))))
      .then(buf => `@font-face{font-family:'${f.family}';font-style:normal;font-weight:100 900;`
        + `src:url(data:font/woff2;base64,${toBase64(buf)}) format('woff2-variations');}`)
      .catch(() => ''))) // a fallback face beats failing the copy outright
      .then(parts => parts.join(''));
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
  const key = container?.querySelector('.cycle-key');
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

// Rasterize one recharts surface at its on-screen size.
async function snapSvg(svg, scale) {
  const box = svg.getBoundingClientRect();
  const w = Math.max(1, Math.round(box.width));
  const h = Math.max(1, Math.round(box.height));
  return { img: await rasterizeSvg(svg, w, h, scale), w, h };
}

async function fontsReady() {
  // Canvas text uses page fonts; make sure they have actually loaded, or the
  // header and legend silently fall back to a system face.
  if (document.fonts?.ready) { try { await document.fonts.ready; } catch { /* non-fatal */ } }
}

function palette() {
  return {
    ink: cssVar('--text', '#ffffff'),
    dim: cssVar('--text-dim', '#a2aab4'),
    faint: cssVar('--text-faint', '#8f979f'),
    orange: cssVar('--orange', '#f7941d'),
    amber: cssVar('--amber', '#fbbf24'),
    cold: cssVar('--cold', '#60a5fa'),
    aurora: cssVar('--aurora', '#34d399'),
    hot: cssVar('--hot', '#f87171'),
    ground: cssVar('--deep-black', '#1a1a1a'),
    panel: cssVar('--ink-panel', 'rgba(50, 49, 64, 0.3)'),
    line: cssVar('--ink-line', 'rgba(81, 79, 96, 0.3)'),
  };
}

// Card surfaces are a translucent solstice wash over the page ground, so the
// ground has to be laid down first: filling a transparent canvas with the
// wash alone would export a semi-transparent PNG.
function paintGround(ctx, W, H, container, p) {
  ctx.fillStyle = p.ground;
  ctx.fillRect(0, 0, W, H);
  const panel = container ? getComputedStyle(container).backgroundColor : null;
  ctx.fillStyle = panel && panel !== 'rgba(0, 0, 0, 0)' ? panel : p.panel;
  ctx.fillRect(0, 0, W, H);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// The percentile gauge, the Bearing Dial redrawn in canvas: a 234° arc,
// cold below the 20th percentile, hot above the 80th, aurora between.
function drawGauge(ctx, cx, cy, size, pct, p) {
  const r = size / 2 - 3;
  const a0 = Math.PI * 1.15, a1 = Math.PI * -0.15;
  const ang = a0 + (a1 - a0) * Math.max(0, Math.min(1, pct));
  const color = pct < 0.2 ? p.cold : pct > 0.8 ? p.hot : p.aurora;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineWidth = 2.5;
  // Canvas angles run clockwise; the dial's math runs counter-clockwise.
  ctx.strokeStyle = p.line;
  ctx.beginPath(); ctx.arc(cx, cy, r, -a0, -a1, false); ctx.stroke();
  ctx.strokeStyle = color;
  ctx.beginPath(); ctx.arc(cx, cy, r, -a0, -ang, false); ctx.stroke();
  ctx.lineWidth = 1.4;
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + (r - 1) * Math.cos(ang), cy - (r - 1) * Math.sin(ang)); ctx.stroke();
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(cx, cy, 2, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// Title left; headline value right in mono with the gauge just before it.
function drawHeader(ctx, x0, w, y, { title, value, percentile }, p) {
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.font = `600 17px ${UI}`;
  ctx.fillStyle = p.ink;
  ctx.fillText(title, x0 + PAD, y + 17);
  if (value) {
    ctx.font = `500 17px ${MONO}`;
    ctx.textAlign = 'right';
    ctx.fillText(value, x0 + w - PAD, y + 17);
    const vw = ctx.measureText(value).width;
    ctx.textAlign = 'left';
    if (percentile !== null && percentile !== undefined) {
      drawGauge(ctx, x0 + w - PAD - vw - 24, y + 13, 30, percentile, p);
    }
  }
}

// Watermark: centred on the plot itself, matching the on-screen treatment
// (.chart-watermark at laptop width and up: 600 weight, 20px, 0.1em tracking;
// 15px inside the bottoms tiles).
function drawWatermark(ctx, x, y, w, h, p, size = 20) {
  ctx.save();
  ctx.globalAlpha = 0.3;
  ctx.font = `600 ${size}px ${UI}`;
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${size / 10}px`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const lockup = 'TRUE NORTH ';
  const wl = ctx.measureText(lockup).width;
  const wa = ctx.measureText('ATLAS').width;
  const wx = x + (w - (wl + wa)) / 2;
  const wy = y + h / 2;
  ctx.fillStyle = p.ink;
  ctx.fillText(lockup, wx, wy);
  ctx.fillStyle = p.orange;
  ctx.fillText('ATLAS', wx + wl, wy);
  ctx.restore();
}

// Word-wrap `text` to `maxW` with the given font; returns the lines.
function wrapText(text, font, maxW) {
  if (!text) return [];
  const m = document.createElement('canvas').getContext('2d');
  m.font = font;
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (line && m.measureText(next).width > maxW) { lines.push(line); line = word; } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

// Lay the legend out into rows up front (measured with the same font the
// drawing pass uses) so the canvas height is exact and each row can be
// centered under the plot, matching the on-screen .cycle-key flex row.
function layoutLegend(legend, cw) {
  const measure = document.createElement('canvas').getContext('2d');
  measure.font = `12px ${UI}`;
  const rows = [];
  let row = [], rowW = 0;
  for (const item of legend) {
    const w = (item.color ? 16 : 0) + measure.measureText(item.text).width;
    if (row.length && rowW + 18 + w > cw) {
      rows.push({ items: row, width: rowW });
      row = []; rowW = 0;
    }
    rowW += (row.length ? 18 : 0) + w;
    row.push({ ...item, w });
  }
  if (row.length) rows.push({ items: row, width: rowW });
  return { rows, height: rows.length ? 14 + rows.length * 20 : 0 };
}

function drawLegend(ctx, rows, x0, y, cw, p) {
  ctx.font = `12px ${UI}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  for (const row of rows) {
    let x = x0 + Math.max(0, (cw - row.width) / 2);
    for (const item of row.items) {
      if (item.color) {
        ctx.fillStyle = item.color;
        ctx.fillRect(x, y + 3, 9, 9);
        x += 16;
      }
      ctx.fillStyle = p.dim;
      ctx.fillText(item.text, x, y + 7);
      x += item.w - (item.color ? 16 : 0) + 18;
    }
    y += 20;
  }
  return y;
}

// The story card's text blocks, measured for the given content width.
const TAKEAWAY_FONT = `13px ${UI}`;
function layoutCard({ title, takeaway, asOf }, cw) {
  const lines = wrapText(takeaway, TAKEAWAY_FONT, cw);
  return {
    headerH: title ? 40 : 0,
    takeawayLines: lines,
    takeawayH: lines.length ? lines.length * 18 + 8 : 0,
    footerH: asOf ? 22 : 0,
  };
}

function drawTakeaway(ctx, lines, x, y, p) {
  ctx.font = TAKEAWAY_FONT;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillStyle = p.dim;
  for (const line of lines) { ctx.fillText(line, x, y + 13); y += 18; }
  return y + 8;
}

function drawFooter(ctx, x0, w, y, asOf, p) {
  ctx.font = `11px ${UI}`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = p.faint;
  ctx.textAlign = 'left';
  const m = String(asOf).match(/^(\d{4})-(\d{2})-(\d{2})/);
  ctx.fillText(`As of ${m ? `${m[2]}/${m[3]}/${m[1]}` : asOf} UTC`, x0 + PAD, y + 14);
  ctx.textAlign = 'right';
  ctx.fillText('True North Atlas', x0 + w - PAD, y + 14);
  ctx.textAlign = 'left';
}

// Frame a content block of W0 x H0 into the requested aspect: the canvas
// grows (never shrinks) and the content is centred, so nothing is scaled.
function frame(W0, H0, aspect) {
  const r = ASPECT[aspect];
  if (!r) return { W: W0, H: H0, ox: 0, oy: 0 };
  let W = W0, H = H0;
  if (W0 / H0 >= r) H = Math.ceil(W0 / r); else W = Math.ceil(H0 * r);
  return { W, H, ox: Math.round((W - W0) / 2), oy: Math.round((H - H0) / 2) };
}

function toBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/png');
  });
}

/**
 * Rasterize the chart inside `container` (a .chartbox element) to a PNG Blob,
 * framed as a story card: title, percentile gauge and latest value, the
 * takeaway sentence, the chart(s) with the watermark, the legend and an
 * as-of footer. `legendFrom` reads the legend from another element when the
 * key is shared by several tiles and lives outside the one being copied;
 * `watermarkSize` matches the on-screen .chart-watermark of the element being
 * copied; `aspect` is 'auto' | 'wide' | 'square'.
 * Rejects when no chart is on screen so the caller can fall back.
 */
export async function chartToPngBlob(container, {
  title = '', value = '', takeaway = '', asOf = null, percentile = null,
  scale = 2, legendFrom = null, watermarkSize = 20, aspect = 'auto',
} = {}) {
  // Every recharts surface in the box, at its on-screen offset: a chart made
  // of stacked panes (price over rallies) copies as one plot, the gap between
  // the panes included, and the watermark centres on the whole.
  // Recharts surfaces, plus hand-drawn SVG panels that opt in with data-export
  // (the cycle scorecard).
  const svgs = [...(container?.querySelectorAll('svg.recharts-surface, svg[data-export]') ?? [])];
  if (!svgs.length) throw new Error('no chart to copy');
  await fontsReady();

  const snaps = await Promise.all(svgs.map(async (svg) => {
    const r = svg.getBoundingClientRect();
    return { x: r.left, y: r.top, ...(await snapSvg(svg, scale)) };
  }));
  const minX = Math.min(...snaps.map(s => s.x)), minY = Math.min(...snaps.map(s => s.y));
  const cw = Math.round(Math.max(...snaps.map(s => s.x + s.w)) - minX);
  const ch = Math.round(Math.max(...snaps.map(s => s.y + s.h)) - minY);

  const legend = layoutLegend(readLegend(legendFrom ?? container), cw);
  const card = layoutCard({ title, takeaway, asOf }, cw);
  const W0 = cw + PAD * 2;
  const H0 = PAD + card.headerH + card.takeawayH + ch + 14 + legend.height + card.footerH + PAD;
  const { W, H, ox, oy } = frame(W0, H0, aspect);

  const canvas = document.createElement('canvas');
  canvas.width = W * scale;
  canvas.height = H * scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);

  const p = palette();
  paintGround(ctx, W, H, container, p);

  let y = oy + PAD;
  if (title) { drawHeader(ctx, ox, W0, y, { title, value, percentile }, p); y += card.headerH; }
  if (card.takeawayLines.length) y = drawTakeaway(ctx, card.takeawayLines, ox + PAD, y, p);
  for (const s of snaps) ctx.drawImage(s.img, ox + PAD + Math.round(s.x - minX), y + Math.round(s.y - minY), s.w, s.h);
  drawWatermark(ctx, ox + PAD, y, cw, ch, p, watermarkSize);
  y += ch + 14;
  if (legend.rows.length) y = drawLegend(ctx, legend.rows, ox + PAD, y, cw, p);
  if (asOf) drawFooter(ctx, ox, W0, y, asOf, p);

  return toBlob(canvas);
}

// A tile's caption, read from its header: the bold epoch label, the plain
// spans, and the optional chip (rendered as an uppercase amber tag).
function readCaption(tile) {
  const hd = tile.querySelector('.bc-hd');
  if (!hd) return { title: '', meta: '', chip: '' };
  const title = hd.querySelector('b')?.textContent.trim() ?? '';
  const meta = [...hd.querySelectorAll(':scope > span:not(.bc-chip)')]
    .map(s => s.textContent.trim().replace(/\s+/g, ' ')).filter(Boolean).join(' · ');
  const chip = hd.querySelector('.bc-chip')?.textContent.trim() ?? '';
  return { title, meta, chip };
}

/**
 * Rasterize every chart tile inside `container` (elements matching `.bc-tile`,
 * each holding one recharts surface and a `.bc-hd` caption) into ONE PNG that
 * reproduces the on-screen layout: tiles at their relative positions, each
 * with its own card, caption and watermark, under the story-card header and
 * takeaway, with the shared legend and as-of footer below. Rejects when there
 * is nothing to copy.
 */
export async function tilesToPngBlob(container, {
  title = '', value = '', takeaway = '', asOf = null, percentile = null, scale = 2, aspect = 'auto',
} = {}) {
  const tiles = [...(container?.querySelectorAll('.bc-tile') ?? [])]
    .filter(t => t.querySelector('svg.recharts-surface'));
  if (!tiles.length) throw new Error('no chart to copy');
  await fontsReady();

  // Geometry relative to the container; the grid on screen IS the layout.
  const box = container.getBoundingClientRect();
  const gw = Math.max(1, Math.round(box.width));
  const snaps = await Promise.all(tiles.map(async (t) => {
    const r = t.getBoundingClientRect();
    const svg = t.querySelector('svg.recharts-surface');
    const s = svg.getBoundingClientRect();
    return {
      x: r.left - box.left, y: r.top - box.top, w: r.width, h: r.height,
      sx: s.left - box.left, sy: s.top - box.top,
      snap: await snapSvg(svg, scale),
      caption: readCaption(t),
    };
  }));
  const gridH = Math.ceil(Math.max(...snaps.map(s => s.y + s.h)));

  const legend = layoutLegend(readLegend(container), gw);
  const card = layoutCard({ title, takeaway, asOf }, gw);
  const W0 = gw + PAD * 2;
  const H0 = PAD + card.headerH + card.takeawayH + gridH + 14 + legend.height + card.footerH + PAD;
  const { W, H, ox, oy } = frame(W0, H0, aspect);

  const canvas = document.createElement('canvas');
  canvas.width = W * scale;
  canvas.height = H * scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);

  const p = palette();
  // The group sits on the page ground; each tile paints its own card wash.
  ctx.fillStyle = p.ground;
  ctx.fillRect(0, 0, W, H);

  let y = oy + PAD;
  if (title) { drawHeader(ctx, ox, W0, y, { title, value, percentile }, p); y += card.headerH; }
  if (card.takeawayLines.length) y = drawTakeaway(ctx, card.takeawayLines, ox + PAD, y, p);

  for (const s of snaps) {
    const tx = ox + PAD + s.x, ty = y + s.y;
    roundRect(ctx, tx, ty, s.w, s.h, 12);
    ctx.fillStyle = p.panel;
    ctx.fill();
    ctx.strokeStyle = p.line;
    ctx.lineWidth = 1;
    ctx.stroke();

    // Caption: bold epoch, dim meta, amber chip, on one line at the top.
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    let cx = tx + 14;
    const cy = ty + 24;
    if (s.caption.title) {
      ctx.font = `600 12px ${UI}`;
      ctx.fillStyle = p.ink;
      ctx.fillText(s.caption.title, cx, cy);
      cx += ctx.measureText(s.caption.title).width + 10;
    }
    if (s.caption.meta) {
      ctx.font = `12px ${UI}`;
      ctx.fillStyle = p.dim;
      ctx.fillText(s.caption.meta, cx, cy);
      cx += ctx.measureText(s.caption.meta).width + 10;
    }
    if (s.caption.chip) {
      ctx.font = `600 9px ${UI}`;
      if ('letterSpacing' in ctx) ctx.letterSpacing = '1px';
      const label = s.caption.chip.toUpperCase();
      const lw = ctx.measureText(label).width + 14;
      roundRect(ctx, cx, cy - 11, lw, 15, 7.5);
      ctx.strokeStyle = 'rgba(251, 191, 36, 0.30)';
      ctx.stroke();
      ctx.fillStyle = p.amber;
      ctx.fillText(label, cx + 7, cy);
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    }

    const ix = ox + PAD + s.sx, iy = y + s.sy;
    ctx.drawImage(s.snap.img, ix, iy, s.snap.w, s.snap.h);
    drawWatermark(ctx, ix, iy, s.snap.w, s.snap.h, p, 15);
  }

  y += gridH + 14;
  if (legend.rows.length) y = drawLegend(ctx, legend.rows, ox + PAD, y, gw, p);
  if (asOf) drawFooter(ctx, ox, W0, y, asOf, p);

  return toBlob(canvas);
}

/**
 * Put a PNG (given as a pending Promise<Blob>) on the clipboard, falling back
 * to a download where image clipboard writes are unsupported (Firefox) or the
 * rasterize fails mid-way. Safari only accepts a Promise in ClipboardItem and
 * requires the write to be issued in the same task as the click, which is why
 * callers hand over the promise unresolved.
 * Resolves to 'copied' | 'downloaded' | 'failed' for the caller's confirmation.
 */
export async function copyPng(png, filename) {
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    return 'copied';
  } catch {
    try {
      const url = URL.createObjectURL(await png);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      return 'downloaded';
    } catch { return 'failed'; }
  }
}
