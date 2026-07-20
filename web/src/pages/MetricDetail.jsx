import { useEffect, useMemo, useState } from 'react';
import {
  ResponsiveContainer, ComposedChart, Line, Area, AreaChart, Bar, BarChart, Cell,
  XAxis, YAxis, Tooltip, ReferenceArea, ReferenceLine, CartesianGrid,
} from 'recharts';
import { api, fmt, compact, fmtDay } from '../api.js';
import AlertForm from '../components/AlertForm.jsx';

const RANGES = [
  { id: '1y', label: '1Y', days: 365 },
  { id: '4y', label: '4Y', days: 1461 },
  { id: 'cycle', label: 'Halving→', days: null, from: '2024-04-20' },
  { id: 'all', label: 'All', days: null },
];

const SERIES_LABELS = {
  price: 'BTC Price', realized_price: 'Realized Price', balanced_price: 'Balanced Price',
  sth_cost_basis: 'STH Cost Basis', lth_cost_basis: 'LTH Cost Basis',
  circulating_supply: 'Circulating Supply',
};
const MULTI_COLORS = ['var(--btc)', 'var(--aurora)', 'var(--cold)', '#c084fc'];
function seriesColor(c, i) {
  if (c === 'price') return 'var(--btc)';
  if (c.includes('loss')) return 'var(--hot)';
  if (c.includes('profit')) return 'var(--aurora)';
  return MULTI_COLORS[(i + 1) % MULTI_COLORS.length];
}
const seriesLabel = (c) => (c.endsWith('_proj')
  ? `${SERIES_LABELS[c.slice(0, -5)] ?? c.slice(0, -5)} (projected)`
  : SERIES_LABELS[c] ?? c);

const EPOCH_COLORS = { 1: '#6c809a', 2: '#7b6cf0', 3: '#58a8ff', 4: '#4fd7d0', 5: '#4fe3a9' };
const EPOCH_WIDTH = { 5: 2.6 }; // current cycle drawn heavier

const WAVE_COLORS = [
  '#ff6b4a', '#ff8f4a', '#f7b34a', '#e3d24f', '#a8e04f', '#4fe3a9',
  '#4fd7d0', '#58a8ff', '#5f7ff2', '#7b6cf0', '#9a5fd9', '#b04fc4',
];

// Shared tooltip chrome. Item text color comes from each series' own stroke/
// fill; charts whose series carry no usable color (the URPD bars, colored per
// Cell) must set an explicit itemStyle or recharts falls back to black.
const TOOLTIP_PROPS = {
  contentStyle: { background: '#0f1013', border: '1px solid var(--ink-line)', borderRadius: 8, fontSize: 12 },
};

function toneColor(t) {
  return t === 'hot' ? 'rgba(255,107,74,0.10)' : t === 'warm' ? 'rgba(247,179,74,0.10)'
    : t === 'cold' ? 'rgba(88,168,255,0.10)' : 'transparent';
}

export default function MetricDetail({ metric, latestVal, onBack, categories, features }) {
  // Projection metrics open on full history: the schedule is the point.
  const [range, setRange] = useState('all');
  const [logScale, setLogScale] = useState(!!metric.logDefault);
  const [showPrice, setShowPrice] = useState(false);
  const [view, setView] = useState('series'); // 'series' | 'cycles'
  const [data, setData] = useState(null);
  const [cycles, setCycles] = useState(null);
  const [urpd, setUrpd] = useState(null);
  const [err, setErr] = useState(null);
  const [copied, setCopied] = useState('');   // transient confirmation label
  const [shareOpen, setShareOpen] = useState(false);
  const [unitIdx, setUnitIdx] = useState(0);
  const [showProj, setShowProj] = useState(true);
  // Scalar metrics get the full toolbar; 'stacked' and 'urpd' kinds render
  // their own chart form with a reduced toolbar.
  const scalar = metric.kind !== 'stacked' && metric.kind !== 'urpd';
  // The overlay only exists for charts that don't already draw BTC price as
  // one of their native series (and not for the price chart itself).
  const canOverlayPrice = metric.slug !== 'price' && !(metric.columns ?? []).includes('price');

  // Optional display-only unit toggle (catalog `unitToggle`): values are
  // stored, served, and alerted in the first unit; the rest are rescalings.
  const unitOpts = Array.isArray(metric.unitToggle) && metric.unitToggle.length > 1
    ? metric.unitToggle : null;
  const unitFactor = unitOpts?.[unitIdx]?.factor ?? 1;
  const displayUnit = unitOpts?.[unitIdx]?.unit ?? metric.unit;
  const scaleVal = (v) => (v === null || v === undefined || v === '' ? null : Number(v) * unitFactor);

  useEffect(() => { setView('series'); setCycles(null); setUnitIdx(0); setShowProj(true); setShowPrice(false); }, [metric.slug]);

  useEffect(() => {
    if (metric.kind === 'urpd') {
      setUrpd(null); setErr(null);
      api.urpd().then(setUrpd).catch(e => setErr(e.message));
      return;
    }
    if (view === 'cycles') {
      if (!cycles) {
        setErr(null);
        api.cycles(metric.slug).then(setCycles).catch(e => setErr(e.message));
      }
      return;
    }
    const r = RANGES.find(x => x.id === range);
    const from = r.from ?? (r.days
      ? new Date(Date.now() - r.days * 86400e3).toISOString().slice(0, 10)
      : undefined);
    setData(null); setErr(null);
    api.series(metric.slug, { from, price: showPrice, downsample: 1200, project: metric.projection })
      .then(setData).catch(e => setErr(e.message));
  }, [metric.slug, range, showPrice, view]); // eslint-disable-line react-hooks/exhaustive-deps

  const cycleRows = useMemo(() => {
    if (!cycles) return [];
    const byDay = new Map();
    for (const e of cycles.epochs) {
      for (const { d, v } of e.values) {
        if (!byDay.has(d)) byDay.set(d, { d });
        byDay.get(d)['epoch' + e.epoch] = unitOpts ? scaleVal(v) : v;
      }
    }
    const rows = [...byDay.values()].sort((a, b) => a.d - b.d);
    if (logScale) for (const r of rows) for (const k of Object.keys(r))
      if (k !== 'd' && r[k] !== undefined && r[k] !== null && r[k] <= 0) r[k] = null;
    return rows;
  }, [cycles, logScale, unitFactor]); // eslint-disable-line react-hooks/exhaustive-deps

  // Dismiss the share menu on an outside click or Escape.
  useEffect(() => {
    if (!shareOpen) return;
    const close = (e) => { if (!e.target.closest?.('.share-menu')) setShareOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setShareOpen(false); };
    document.addEventListener('click', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('click', close); document.removeEventListener('keydown', esc); };
  }, [shareOpen]);

  // Share menu. `copied` doubles as the transient confirmation label for every
  // action, so only one timer and one piece of state are in play.
  const flash = (msg) => { setCopied(msg); setTimeout(() => setCopied(''), 2200); };

  const copyLink = async () => {
    setShareOpen(false);
    try {
      await navigator.clipboard.writeText(api.shareUrl(metric.slug));
      flash('Link copied');
    } catch { window.prompt('Copy this share link:', api.shareUrl(metric.slug)); }
  };

  const copyCard = async () => {
    setShareOpen(false);
    const url = api.cardUrl(metric.slug);
    try {
      // Safari only accepts a Promise here and requires the write to happen in
      // the same task as the click, so the fetch must be passed unresolved
      // rather than awaited first.
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': fetch(url).then(r => {
          if (!r.ok) throw new Error(`card ${r.status}`);
          return r.blob();
        }) }),
      ]);
      flash('Chart copied');
    } catch {
      // Firefox lacks image clipboard support, and any fetch failure lands here
      // too: open the card so it can be saved or copied by hand.
      window.open(url, '_blank', 'noopener');
    }
  };

  const shareToX = () => {
    setShareOpen(false);
    // Post the share URL, not the image: /share/:slug carries the Open Graph
    // tags, so X unfurls the same card copyCard() puts on the clipboard.
    const text = `${metric.name} · True North Atlas`;
    const href = 'https://x.com/intent/tweet?text=' + encodeURIComponent(text)
      + '&url=' + encodeURIComponent(api.shareUrl(metric.slug));
    window.open(href, '_blank', 'noopener,width=600,height=500');
  };

  const rows = useMemo(() => {
    if (!data) return [];
    if (metric.kind === 'stacked') {
      return data.rows.map(r => {
        const bands = typeof r[metric.slug === 'hodl-waves' ? 'hodl_waves' : 'rc_hodl_waves'] === 'object'
          ? r.hodl_waves ?? r.rc_hodl_waves : null;
        const raw = r[data.columns[0]];
        const obj = raw && typeof raw === 'object' ? raw : bands;
        return { day: r.day, ...(obj || {}) };
      }).filter(r => Object.keys(r).length > 1);
    }
    const out = data.rows.map(r => {
      const row = { day: r.day };
      if (metric.projection) row.t = Date.parse(r.day);
      for (const c of data.columns) row[c] = r[c] === null ? null : Number(r[c]) * unitFactor;
      // The price overlay always draws on a log axis (price spans orders of
      // magnitude even when the metric axis is linear), so non-positive prices
      // must be dropped regardless of logScale — otherwise log(0) breaks the
      // scale and the overlay silently fails to render. Pre-market days
      // (2009-01-03..2010-07-16) are legitimately zero.
      if (r.price !== undefined) { const p = Number(r.price); row.price = p > 0 ? p : null; }
      // Log scale can't render non-positive values.
      if (logScale) for (const k of Object.keys(row)) if (k !== 'day' && k !== 't' && row[k] !== null && row[k] <= 0) row[k] = null;
      return row;
    });
    // Projected continuation (issuance schedule): its own dashed series,
    // seamed onto the last historical point so the two lines connect.
    if (showProj && data.projection?.length && out.length) {
      const c = data.columns[0];
      out[out.length - 1][c + '_proj'] = out[out.length - 1][c];
      for (const p of data.projection) {
        out.push({ day: p.day, t: Date.parse(p.day), [c + '_proj']: Number(p[c]) * unitFactor });
      }
    }
    return out;
  }, [data, metric, logScale, unitFactor, showProj]);

  // Projection metrics plot on a numeric time axis (uniform years per pixel,
  // history and projection to scale); everything else keeps the category axis.
  const timeAxis = !!metric.projection;
  const spanYears = timeAxis && rows.length > 1
    ? (rows[rows.length - 1].t - rows[0].t) / 31_557_600_000 : 0;
  const timeTick = (t) => (spanYears > 6
    ? String(new Date(t).getUTCFullYear())
    : fmtDay(new Date(t).toISOString().slice(0, 10)));

  // Halving markers at their exact dates. The projection runs to the end of
  // issuance (~29 future halvings), so only the first few estimated markers
  // get labels; the rest stay unlabeled hairlines.
  const halvingMarks = useMemo(() => {
    if (!data?.halvings || rows.length === 0) return [];
    const first = rows[0].t, last = rows[rows.length - 1].t;
    let labeledEst = 0;
    return data.halvings
      .map(h => ({ ...h, x: Date.parse(h.day) }))
      .filter(h => (h.estimated ? showProj : true) && h.x >= first && h.x <= last)
      .map(h => ({
        ...h,
        label: !h.estimated || labeledEst++ < 3 ? (h.estimated ? '~' : '') + h.day.slice(0, 4) : null,
      }));
  }, [data, rows, showProj]);

  const catName = categories.find(c => c.id === metric.category)?.name ?? '';
  // Watermark only when a chart is actually on screen, never over loading/empty states.
  const hasChart = !err && (view === 'cycles'
    ? cycleRows.length > 0
    : metric.kind === 'urpd' ? !!urpd : rows.length > 0);
  const waveKeys = metric.kind === 'stacked' && rows.length
    ? Object.keys(rows[rows.length - 1]).filter(k => k !== 'day') : [];

  // URPD: fill the sparse server buckets to a dense, uniform 100-bin series so
  // the category axis spaces linearly; classify each bin against the close.
  const urpdBins = useMemo(() => {
    if (!urpd) return [];
    const byIdx = new Map(urpd.buckets.map(b => [Math.round(b.p / urpd.width), b.v]));
    return Array.from({ length: 100 }, (_, i) => ({
      p: Math.round(i * urpd.width * 100) / 100,
      v: byIdx.get(i) ?? 0,
    }));
  }, [urpd]);
  const spotBin = urpd ? Math.min(Math.floor(urpd.price / urpd.width), 99) : -1;
  const urpdColor = (i) => (i < spotBin ? 'var(--aurora)' : i > spotBin ? 'var(--hot)' : 'var(--btc)');

  return (
    <div className="wrap">
      <div className="detail-hd">
        <div className="crumb">
          <a href="#/" onClick={(e) => { e.preventDefault(); onBack(); }}>← All metrics</a>
          {' '}/ {catName}
        </div>
        <h1>{metric.name}</h1>
        <p className="short">{metric.short}</p>
        {scalar && (
          <div className="bigval">{fmt(unitOpts ? scaleVal(latestVal) : latestVal, metric.format, displayUnit)}</div>
        )}
        {metric.kind === 'urpd' && urpd?.avg != null && (
          <div className="bigval">
            {fmt(urpd.avg, 'usd')}<span className="bigval-sub">average cost basis</span>
          </div>
        )}
      </div>

      <div className="toolbar">
        {scalar && (
          <div className="grp" role="group" aria-label="View">
            <button className={view === 'series' ? 'on' : ''} onClick={() => setView('series')}>Timeline</button>
            <button className={view === 'cycles' ? 'on' : ''} onClick={() => setView('cycles')}>Cycles</button>
          </div>
        )}
        {view === 'series' && metric.kind !== 'urpd' && <div className="grp" role="group" aria-label="Time range">
          {RANGES.map(r => (
            <button key={r.id} className={range === r.id ? 'on' : ''} onClick={() => setRange(r.id)}>{r.label}</button>
          ))}
        </div>}
        {scalar && (
          <div className="grp">
            <button className={!logScale ? 'on' : ''} onClick={() => setLogScale(false)}>Linear</button>
            <button className={logScale ? 'on' : ''} onClick={() => setLogScale(true)}>Log</button>
          </div>
        )}
        {scalar && unitOpts && (
          <div className="grp" role="group" aria-label="Unit">
            {unitOpts.map((u, i) => (
              <button key={u.label} className={unitIdx === i ? 'on' : ''} onClick={() => setUnitIdx(i)}>{u.label}</button>
            ))}
          </div>
        )}
        {view === 'series' && scalar && metric.projection && (
          <div className="grp">
            <button className={showProj ? 'on' : ''} onClick={() => setShowProj(!showProj)}>
              {showProj ? '✓ ' : ''}Projection
            </button>
          </div>
        )}
        {view === 'series' && scalar && canOverlayPrice && (
          <div className="grp">
            <button className={showPrice ? 'on' : ''} onClick={() => setShowPrice(!showPrice)}>
              {showPrice ? '✓ ' : ''}BTC price overlay
            </button>
          </div>
        )}
        <div className="grp share-grp share-menu">
          <button aria-haspopup="menu" aria-expanded={shareOpen}
            onClick={() => setShareOpen(o => !o)}>
            {copied ? `✓ ${copied}` : 'Share ▾'}
          </button>
          {shareOpen && (
            <div className="share-pop" role="menu">
              <button role="menuitem" onClick={copyLink}>Copy link</button>
              <button role="menuitem" onClick={copyCard}>Copy chart image</button>
              <button role="menuitem" onClick={shareToX}>Share on X</button>
            </div>
          )}
        </div>
      </div>

      <div className="chartbox">
        {hasChart && (
          <div className="chart-watermark" aria-hidden="true">
            TRUE NORTH <em>ATLAS</em>
          </div>
        )}
        {err && <div className="err">Could not load series: {err}</div>}
        {view === 'cycles' && !err && !cycles && <div className="loading">Aligning halving cycles…</div>}
        {view === 'cycles' && !err && cycles && cycleRows.length > 0 && (
          <>
            <div className="chartwrap"><ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={cycleRows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="var(--ink-line)" strokeOpacity={0.4} vertical={false} />
                <XAxis dataKey="d" type="number" domain={[0, 'dataMax']}
                  tickFormatter={(d) => d + 'd'} tick={{ fill: 'var(--text-faint)', fontSize: 11 }} />
                <YAxis scale={logScale ? 'log' : 'linear'} domain={['auto', 'auto']} allowDataOverflow
                  tick={{ fill: 'var(--text-faint)', fontSize: 11 }} tickFormatter={(v) => compact(v)} width={64} />
                <Tooltip {...TOOLTIP_PROPS}
                  labelFormatter={(d) => `Day ${d} of epoch`}
                  formatter={(v, n) => [fmt(Number(v), metric.format, displayUnit), n.replace('epoch', 'Epoch ')]} />
                {cycles.epochs.map(e => (
                  <Line key={e.epoch} dataKey={'epoch' + e.epoch} dot={false} isAnimationActive={false}
                    stroke={EPOCH_COLORS[e.epoch] ?? 'var(--cold)'}
                    strokeWidth={EPOCH_WIDTH[e.epoch] ?? 1.4} connectNulls />
                ))}
              </ComposedChart>
            </ResponsiveContainer></div>
            <div className="cycle-key">
              {cycles.epochs.map(e => (
                <span key={e.epoch}><i style={{ background: EPOCH_COLORS[e.epoch] ?? 'var(--cold)' }} />
                  Epoch {e.epoch} <em>({e.start.slice(5, 7)}/{e.start.slice(0, 4)}→)</em></span>
              ))}
              <span className="cycle-note">x-axis: days since epoch start · cycles aligned at their halvings</span>
            </div>
          </>
        )}
        {view === 'cycles' && !err && cycles && cycleRows.length === 0 && (
          <div className="loading">Not enough finalized history yet to compare cycles.</div>
        )}
        {metric.kind === 'urpd' && !err && !urpd && <div className="loading">Loading distribution…</div>}
        {metric.kind === 'urpd' && !err && urpd && (
          <>
            <div className="chartwrap"><ResponsiveContainer width="100%" height="100%">
              <BarChart data={urpdBins} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="18%">
                <CartesianGrid stroke="var(--ink-line)" strokeOpacity={0.4} vertical={false} />
                <XAxis dataKey="p" tickFormatter={(v) => '$' + compact(v)}
                  tick={{ fill: 'var(--text-faint)', fontSize: 11 }} minTickGap={56} />
                <YAxis tickFormatter={(v) => compact(v)}
                  tick={{ fill: 'var(--text-faint)', fontSize: 11 }} width={64} />
                <Tooltip {...TOOLTIP_PROPS} itemStyle={{ color: 'var(--bone)' }}
                  cursor={{ fill: 'rgba(255,255,255,0.04)' }}
                  labelFormatter={(p) => `Acquired $${compact(Number(p))} – $${compact(Number(p) + urpd.width)}`}
                  formatter={(v) => [compact(Number(v)) + ' BTC', 'Supply']} />
                <Bar dataKey="v" isAnimationActive={false}>
                  {urpdBins.map((_, i) => (
                    <Cell key={i} fill={urpdColor(i)} fillOpacity={i === spotBin ? 1 : 0.85} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer></div>
            <div className="cycle-key">
              <span><i style={{ background: 'var(--aurora)' }} />Acquired below the close (in profit)</span>
              <span><i style={{ background: 'var(--hot)' }} />Acquired above the close (underwater)</span>
              <span><i style={{ background: 'var(--btc)' }} />The close sits here: {fmt(urpd.price, 'usd')}</span>
              <span className="cycle-note">as of {fmtDay(urpd.day)}, the latest finalized UTC day · each bar is a ${compact(urpd.width)} price bin</span>
            </div>
          </>
        )}
        {view === 'series' && metric.kind !== 'urpd' && !err && !data && <div className="loading">Loading series…</div>}
        {view === 'series' && !err && data && rows.length === 0 && (
          <div className="loading">No finalized data for this range yet. The sync worker is still building history.</div>
        )}
        {view === 'series' && !err && rows.length > 0 && metric.kind === 'stacked' && (
          <div className="chartwrap"><ResponsiveContainer width="100%" height="100%">
            <AreaChart data={rows} stackOffset="expand" margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <XAxis dataKey="day" tickFormatter={fmtDay} tick={{ fill: 'var(--text-faint)', fontSize: 11 }} minTickGap={60} />
              <YAxis tickFormatter={(v) => (v * 100).toFixed(0) + '%'} tick={{ fill: 'var(--text-faint)', fontSize: 11 }} />
              <Tooltip {...TOOLTIP_PROPS}
                labelFormatter={fmtDay} formatter={(v, n) => [(v * 100).toFixed(2) + '%', n]} />
              {waveKeys.map((k, i) => (
                <Area key={k} dataKey={k} stackId="1" stroke="none"
                  fill={WAVE_COLORS[i % WAVE_COLORS.length]} fillOpacity={0.85} isAnimationActive={false} />
              ))}
            </AreaChart>
          </ResponsiveContainer></div>
        )}
        {view === 'series' && !err && rows.length > 0 && metric.kind !== 'stacked' && (
          <div className="chartwrap"><ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="var(--ink-line)" strokeOpacity={0.4} vertical={false} />
              {timeAxis
                ? <XAxis dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']}
                    tickFormatter={timeTick} tick={{ fill: 'var(--text-faint)', fontSize: 11 }} minTickGap={60} />
                : <XAxis dataKey="day" tickFormatter={fmtDay} tick={{ fill: 'var(--text-faint)', fontSize: 11 }} minTickGap={60} />}
              <YAxis yAxisId="m" scale={logScale ? 'log' : 'linear'} domain={['auto', 'auto']}
                allowDataOverflow tick={{ fill: 'var(--text-faint)', fontSize: 11 }}
                tickFormatter={(v) => compact(v)} width={64} />
              {showPrice && canOverlayPrice && (
                <YAxis yAxisId="p" orientation="right" scale="log" domain={['auto', 'auto']}
                  allowDataOverflow tick={{ fill: 'var(--btc)', fontSize: 11, opacity: 0.7 }}
                  tickFormatter={(v) => '$' + compact(v)} width={64} />
              )}
              {!logScale && (metric.zones ?? []).map((z, i) => z.tone === 'line'
                ? <ReferenceLine key={i} yAxisId="m" y={z.from * unitFactor} stroke="var(--text-faint)" strokeDasharray="4 4" />
                : <ReferenceArea key={i} yAxisId="m" y1={z.from * unitFactor} y2={z.to * unitFactor} fill={toneColor(z.tone)} stroke="none" />)}
              {halvingMarks.map((h, i) => (
                <ReferenceLine key={h.height} yAxisId="m" x={h.x} stroke="var(--text-faint)" strokeDasharray="3 5"
                  strokeOpacity={h.label ? 1 : 0.45}
                  label={h.label ? {
                    value: h.label, position: 'insideTopLeft',
                    fill: 'var(--text-faint)', fontSize: 10, dy: i % 2 ? 14 : 2,
                  } : undefined} />
              ))}
              <Tooltip {...TOOLTIP_PROPS}
                labelFormatter={timeAxis ? (t) => fmtDay(new Date(t).toISOString().slice(0, 10)) : fmtDay}
                formatter={(v, n) => [fmt(Number(v), n === 'price' ? 'usd' : metric.format, displayUnit), seriesLabel(n)]} />
              {(data.columns ?? []).map((c, i) => (
                <Line key={c} yAxisId="m" dataKey={c} dot={false} isAnimationActive={false}
                  stroke={seriesColor(c, i)}
                  strokeWidth={c === 'price' && data.columns.length > 1 ? 2.2 : 1.7} connectNulls />
              ))}
              {showProj && data.projection?.length > 0 && (
                <Line yAxisId="m" dataKey={data.columns[0] + '_proj'} dot={false} isAnimationActive={false}
                  stroke={seriesColor(data.columns[0], 0)} strokeWidth={1.7}
                  strokeDasharray="6 4" strokeOpacity={0.75} connectNulls />
              )}
              {showPrice && canOverlayPrice && (
                <Line yAxisId="p" dataKey="price" dot={false} isAnimationActive={false}
                  stroke="var(--btc)" strokeWidth={1.2} strokeOpacity={0.75} connectNulls />
              )}
            </ComposedChart>
          </ResponsiveContainer></div>
        )}
        {view === 'series' && (data?.columns?.length ?? 0) > 1 && metric.kind !== 'stacked' && (
          <div className="cycle-key">
            {data.columns.map((c, i) => (
              <span key={c}><i style={{ background: seriesColor(c, i) }} />{seriesLabel(c)}</span>
            ))}
          </div>
        )}
      </div>

      <div className="panes">
        <div className="pane">
          <h4>What it tells you</h4>
          <p>{metric.explain}</p>
          {(metric.zones ?? []).filter(z => z.tone !== 'line').length > 0 && (
            <div className="zone-key">
              {metric.zones.filter(z => z.tone !== 'line').map((z, i) => (
                <div key={i} className="zk">
                  <i style={{ background: z.tone === 'hot' ? 'var(--hot)' : z.tone === 'warm' ? '#f7b34a' : 'var(--cold)', opacity: 0.7 }} />
                  {z.label} ({z.from}–{z.to})
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="pane">
          <h4>How it's computed</h4>
          <p>{metric.method}</p>
        </div>
        {scalar && features?.alertSignup && (
          <div className="pane pane-alert">
            <h4>Get the signal</h4>
            <AlertForm metric={metric} currentValue={latestVal} />
          </div>
        )}
      </div>
    </div>
  );
}
