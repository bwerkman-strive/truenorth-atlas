import { useMemo, useState } from 'react';
import BearingDial from '../components/BearingDial.jsx';
import { fmt } from '../api.js';

function Spark({ data }) {
  if (!data || data.filter(v => v !== null).length < 2) return <div className="spark" />;
  const vals = data.filter(v => v !== null);
  const min = Math.min(...vals), max = Math.max(...vals);
  const w = 240, h = 34;
  const pts = data.map((v, i) => v === null ? null :
    `${(i / (data.length - 1)) * w},${max === min ? h / 2 : h - ((v - min) / (max - min)) * (h - 4) - 2}`)
    .filter(Boolean).join(' ');
  const up = vals[vals.length - 1] >= vals[0];
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} width="100%" height="34" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={pts} fill="none" stroke={up ? 'var(--aurora)' : 'var(--hot)'}
        strokeWidth="1.6" strokeLinejoin="round" opacity="0.9" />
    </svg>
  );
}

export default function Overview({ catalog, latest, onOpen }) {
  const [cat, setCat] = useState('all');
  const groups = useMemo(() => {
    const g = {};
    for (const c of catalog.categories) g[c.id] = { ...c, metrics: [] };
    for (const m of catalog.metrics) g[m.category]?.metrics.push(m);
    return catalog.categories.map(c => g[c.id]);
  }, [catalog]);

  const shown = cat === 'all' ? groups : groups.filter(g => g.id === cat);

  return (
    <>
      <div className="hero wrap">
        <p className="eyebrow">Navigating the Bitcoin Ledger</p>
        <h1>Atlas <span className="h1-sub">/ Bitcoin On-Chain Analytics</span></h1>
      </div>

      <nav className="catnav wrap" aria-label="Metric categories">
        <button className={cat === 'all' ? 'on' : ''} onClick={() => setCat('all')}>All metrics</button>
        {catalog.categories.map(c => (
          <button key={c.id} className={cat === c.id ? 'on' : ''} onClick={() => setCat(c.id)}>{c.name}</button>
        ))}
      </nav>

      <div className="wrap">
        {latest.day === null && (
          <div className="syncnote">
            The node sync is still building history. Metrics appear here as each day of the
            chain is finalized; valuation series populate from 2010 onward as the sync advances.
          </div>
        )}
        {shown.map(g => (
          <section key={g.id}>
            <div className="sec"><h2>{g.name} <span>{g.blurb}</span></h2></div>
            <div className="grid">
              {g.metrics.map(m => {
                const v = latest.values?.[m.slug];
                return (
                  <button key={m.slug} className="card" onClick={() => onOpen(m.slug)}>
                    <div className="card-top">
                      <div>
                        <h3>{m.name}</h3>
                        <div className="val" style={m.slug === 'price' ? { color: 'var(--btc)' } : undefined}>
                          {m.kind === 'stacked' ? 'View bands →'
                            : m.kind === 'urpd' ? 'View distribution →'
                            : fmt(v?.value, m.format, m.unit)}
                        </div>
                      </div>
                      {m.kind !== 'stacked' && m.kind !== 'urpd' && <BearingDial percentile={v?.percentile} />}
                    </div>
                    {m.kind !== 'stacked' && m.kind !== 'urpd' && <Spark data={v?.spark} />}
                    <p className="short">{m.short}</p>
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </>
  );
}
