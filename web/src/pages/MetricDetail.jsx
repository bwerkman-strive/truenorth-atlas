import { useEffect, useMemo, useState } from 'react';
import {
  ResponsiveContainer, ComposedChart, Line, Area, AreaChart, XAxis, YAxis,
  Tooltip, ReferenceArea, ReferenceLine, CartesianGrid,
} from 'recharts';
import { api, fmt, compact } from '../api.js';
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
};
const MULTI_COLORS = ['var(--btc)', 'var(--aurora)', 'var(--cold)', '#c084fc'];
function seriesColor(c, i) {
  if (c === 'price') return 'var(--btc)';
  if (c.includes('loss')) return 'var(--hot)';
  if (c.includes('profit')) return 'var(--aurora)';
  return MULTI_COLORS[(i + 1) % MULTI_COLORS.length];
}
const seriesLabel = (c) => SERIES_LABELS[c] ?? c;

const EPOCH_COLORS = { 1: '#6c809a', 2: '#7b6cf0', 3: '#58a8ff', 4: '#4fd7d0', 5: '#4fe3a9' };
const EPOCH_WIDTH = { 5: 2.6 }; // current cycle drawn heavier

const WAVE_COLORS = [
  '#ff6b4a', '#ff8f4a', '#f7b34a', '#e3d24f', '#a8e04f', '#4fe3a9',
  '#4fd7d0', '#58a8ff', '#5f7ff2', '#7b6cf0', '#9a5fd9', '#b04fc4',
];

function toneColor(t) {
  return t === 'hot' ? 'rgba(255,107,74,0.10)' : t === 'warm' ? 'rgba(247,179,74,0.10)'
    : t === 'cold' ? 'rgba(88,168,255,0.10)' : 'transparent';
}

export default function MetricDetail({ metric, latestVal, onBack, categories, features }) {
  const [range, setRange] = useState(metric.kind === 'stacked' ? 'all' : '4y');
  const [logScale, setLogScale] = useState(!!metric.logDefault);
  const [showPrice, setShowPrice] = useState(!!metric.overlayPrice);
  const [view, setView] = useState('series'); // 'series' | 'cycles'
  const [data, setData] = useState(null);
  const [cycles, setCycles] = useState(null);
  const [err, setErr] = useState(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => { setView('series'); setCycles(null); }, [metric.slug]);

  useEffect(() => {
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
    api.series(metric.slug, { from, price: showPrice, downsample: 1200 })
      .then(setData).catch(e => setErr(e.message));
  }, [metric.slug, range, showPrice, view]); // eslint-disable-line react-hooks/exhaustive-deps

  const cycleRows = useMemo(() => {
    if (!cycles) return [];
    const byDay = new Map();
    for (const e of cycles.epochs) {
      for (const { d, v } of e.values) {
        if (!byDay.has(d)) byDay.set(d, { d });
        byDay.get(d)['epoch' + e.epoch] = v;
      }
    }
    const rows = [...byDay.values()].sort((a, b) => a.d - b.d);
    if (logScale) for (const r of rows) for (const k of Object.keys(r))
      if (k !== 'd' && r[k] !== undefined && r[k] !== null && r[k] <= 0) r[k] = null;
    return rows;
  }, [cycles, logScale]);

  const share = async () => {
    try {
      await navigator.clipboard.writeText(api.shareUrl(metric.slug));
      setCopied(true); setTimeout(() => setCopied(false), 2200);
    } catch { window.prompt('Copy this share link:', api.shareUrl(metric.slug)); }
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
    return data.rows.map(r => {
      const out = { day: r.day };
      for (const c of data.columns) out[c] = r[c] === null ? null : Number(r[c]);
      if (r.price !== undefined) out.price = Number(r.price);
      // Log scale can't render non-positive values.
      if (logScale) for (const k of Object.keys(out)) if (k !== 'day' && out[k] !== null && out[k] <= 0) out[k] = null;
      return out;
    });
  }, [data, metric, logScale]);

  const catName = categories.find(c => c.id === metric.category)?.name ?? '';
  const waveKeys = metric.kind === 'stacked' && rows.length
    ? Object.keys(rows[rows.length - 1]).filter(k => k !== 'day') : [];

  return (
    <div className="wrap">
      <div className="detail-hd">
        <div className="crumb">
          <a href="#/" onClick={(e) => { e.preventDefault(); onBack(); }}>← All metrics</a>
          {' '}/ {catName}
        </div>
        <h1>{metric.name}</h1>
        <p className="short">{metric.short}</p>
        {metric.kind !== 'stacked' && (
          <div className="bigval">{fmt(latestVal, metric.format, metric.unit)}</div>
        )}
      </div>

      <div className="toolbar">
        {metric.kind !== 'stacked' && (
          <div className="grp" role="group" aria-label="View">
            <button className={view === 'series' ? 'on' : ''} onClick={() => setView('series')}>Timeline</button>
            <button className={view === 'cycles' ? 'on' : ''} onClick={() => setView('cycles')}>Cycles</button>
          </div>
        )}
        {view === 'series' && <div className="grp" role="group" aria-label="Time range">
          {RANGES.map(r => (
            <button key={r.id} className={range === r.id ? 'on' : ''} onClick={() => setRange(r.id)}>{r.label}</button>
          ))}
        </div>}
        {metric.kind !== 'stacked' && (
          <div className="grp">
            <button className={!logScale ? 'on' : ''} onClick={() => setLogScale(false)}>Linear</button>
            <button className={logScale ? 'on' : ''} onClick={() => setLogScale(true)}>Log</button>
          </div>
        )}
        {view === 'series' && metric.kind !== 'stacked' && metric.slug !== 'price'
          && !(metric.columns ?? []).includes('price') && (
          <div className="grp">
            <button className={showPrice ? 'on' : ''} onClick={() => setShowPrice(!showPrice)}>
              {showPrice ? '✓ ' : ''}BTC price overlay
            </button>
          </div>
        )}
        <div className="grp share-grp">
          <button onClick={share}>{copied ? '✓ Link copied' : 'Share'}</button>
        </div>
      </div>

      <div className="chartbox">
        <div className="chart-watermark" aria-hidden="true">
          TRUE NORTH <em>ATLAS</em><span> · atlas.tnorth.com</span>
        </div>
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
                <Tooltip contentStyle={{ background: '#0d1526', border: '1px solid var(--ink-line)', borderRadius: 8, fontSize: 12 }}
                  labelFormatter={(d) => `Day ${d} of epoch`}
                  formatter={(v, n) => [fmt(Number(v), metric.format, metric.unit), n.replace('epoch', 'Epoch ')]} />
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
                  Epoch {e.epoch} <em>({e.start.slice(0, 7)}→)</em></span>
              ))}
              <span className="cycle-note">x-axis: days since epoch start — cycles aligned at their halvings</span>
            </div>
          </>
        )}
        {view === 'cycles' && !err && cycles && cycleRows.length === 0 && (
          <div className="loading">Not enough finalized history yet to compare cycles.</div>
        )}
        {view === 'series' && !err && !data && <div className="loading">Loading series…</div>}
        {view === 'series' && !err && data && rows.length === 0 && (
          <div className="loading">No finalized data for this range yet — the sync worker is still building history.</div>
        )}
        {view === 'series' && !err && rows.length > 0 && metric.kind === 'stacked' && (
          <div className="chartwrap"><ResponsiveContainer width="100%" height="100%">
            <AreaChart data={rows} stackOffset="expand" margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <XAxis dataKey="day" tick={{ fill: 'var(--text-faint)', fontSize: 11 }} minTickGap={60} />
              <YAxis tickFormatter={(v) => (v * 100).toFixed(0) + '%'} tick={{ fill: 'var(--text-faint)', fontSize: 11 }} />
              <Tooltip contentStyle={{ background: '#0d1526', border: '1px solid var(--ink-line)', borderRadius: 8, fontSize: 12 }}
                formatter={(v, n) => [(v * 100).toFixed(2) + '%', n]} />
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
              <XAxis dataKey="day" tick={{ fill: 'var(--text-faint)', fontSize: 11 }} minTickGap={60} />
              <YAxis yAxisId="m" scale={logScale ? 'log' : 'linear'} domain={['auto', 'auto']}
                allowDataOverflow tick={{ fill: 'var(--text-faint)', fontSize: 11 }}
                tickFormatter={(v) => compact(v)} width={64} />
              {showPrice && metric.slug !== 'price' && (
                <YAxis yAxisId="p" orientation="right" scale="log" domain={['auto', 'auto']}
                  allowDataOverflow tick={{ fill: 'var(--btc)', fontSize: 11, opacity: 0.7 }}
                  tickFormatter={(v) => '$' + compact(v)} width={64} />
              )}
              {!logScale && (metric.zones ?? []).map((z, i) => z.tone === 'line'
                ? <ReferenceLine key={i} yAxisId="m" y={z.from} stroke="var(--text-faint)" strokeDasharray="4 4" />
                : <ReferenceArea key={i} yAxisId="m" y1={z.from} y2={z.to} fill={toneColor(z.tone)} stroke="none" />)}
              <Tooltip contentStyle={{ background: '#0d1526', border: '1px solid var(--ink-line)', borderRadius: 8, fontSize: 12 }}
                formatter={(v, n) => [fmt(Number(v), n === 'price' ? 'usd' : metric.format, metric.unit), seriesLabel(n)]} />
              {(data.columns ?? []).map((c, i) => (
                <Line key={c} yAxisId="m" dataKey={c} dot={false} isAnimationActive={false}
                  stroke={seriesColor(c, i)}
                  strokeWidth={c === 'price' && data.columns.length > 1 ? 2.2 : 1.7} connectNulls />
              ))}
              {showPrice && metric.slug !== 'price' && (
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
        {metric.kind !== 'stacked' && features?.alertSignup && (
          <div className="pane pane-alert">
            <h4>Get the signal</h4>
            <AlertForm metric={metric} currentValue={latestVal} />
          </div>
        )}
      </div>
    </div>
  );
}
