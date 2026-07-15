import { useEffect, useState, useCallback } from 'react';
import { api, fmt, fmtDay, isEmbed } from './api.js';
import Overview from './pages/Overview.jsx';
import MetricDetail from './pages/MetricDetail.jsx';
import Explorer from './pages/Explorer.jsx';
import Admin from './pages/Admin.jsx';
import EpochRings from './components/EpochRings.jsx';
import SubscribeForm from './components/SubscribeForm.jsx';

// Hash routing (#/ and #/m/:slug) so the module works identically as a
// standalone site, behind any path on tnorth.com, or inside an iframe.
function useRoute() {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const fn = () => setHash(window.location.hash);
    window.addEventListener('hashchange', fn);
    return () => window.removeEventListener('hashchange', fn);
  }, []);
  const m = hash.match(/^#\/m\/([a-z0-9-]+)/);
  if (m) return { page: 'metric', slug: m[1] };
  if (hash.startsWith('#/admin')) return { page: 'admin' };
  const x = hash.match(/^#\/(explorer)$|^#\/(b|tx|a)\/([A-Za-z0-9]+)/);
  if (x) {
    if (x[1]) return { page: 'explorer', view: 'home' };
    const view = x[2] === 'b' ? 'block' : x[2] === 'tx' ? 'tx' : 'address';
    return { page: 'explorer', view, param: x[3] };
  }
  return { page: 'overview' };
}

const BASE_TITLE = 'True North Atlas';

export default function App() {
  const route = useRoute();
  const [catalog, setCatalog] = useState(null);
  const [latest, setLatest] = useState(null);
  const [status, setStatus] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    Promise.all([api.catalog(), api.latest(), api.status()])
      .then(([c, l, s]) => { setCatalog(c); setLatest(l); setStatus(s); })
      .catch(e => setErr(e.message));
    const t = setInterval(() => {
      api.latest().then(setLatest).catch(() => {});
      api.status().then(setStatus).catch(() => {});
    }, 5 * 60 * 1000);
    return () => clearInterval(t);
  }, []);

  const metricForTitle = route.page === 'metric' && catalog
    ? catalog.metrics.find(m => m.slug === route.slug) : null;
  useEffect(() => {
    document.title =
      route.page === 'admin' ? `Admin · ${BASE_TITLE}`
      : route.page === 'explorer' ? (
          route.view === 'block' ? `Block ${route.param} · ${BASE_TITLE}`
          : route.view === 'tx' ? `Transaction · ${BASE_TITLE}`
          : route.view === 'address' ? `Address · ${BASE_TITLE}`
          : `Explorer · ${BASE_TITLE}`)
      : metricForTitle ? `${metricForTitle.name} · ${BASE_TITLE}`
      : BASE_TITLE;
  }, [route, metricForTitle]);

  const [spot, setSpot] = useState(null);
  useEffect(() => {
    let alive = true;
    const tick = () => api.spot().then(s => alive && s.price && setSpot(s)).catch(() => {});
    tick();
    const t = setInterval(tick, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const open = useCallback((slug) => { window.location.hash = `#/m/${slug}`; window.scrollTo(0, 0); }, []);
  const back = useCallback(() => { window.location.hash = '#/'; }, []);

  if (err) return <div className="err">The analytics API is unreachable ({err}). It may still be deploying; retry in a moment.</div>;
  if (!catalog || !latest) return (
    <div className="loading loading-boot">
      <EpochRings size={64} title="True North Atlas" />
      <div>Loading on-chain data…</div>
    </div>
  );

  const stale = status?.latestMetricsDay
    ? (Date.now() - Date.parse(status.latestMetricsDay)) > 3 * 86400e3
    : true;

  const metric = route.page === 'metric' ? catalog.metrics.find(m => m.slug === route.slug) : null;

  return (
    <>
      {!isEmbed && (
        <header className="hdr">
          <div className="hdr-in wrap">
            <a className="brand" href="#/">
              <EpochRings height={status?.syncedHeight ?? null} size={30} />
              <span>TRUE NORTH <em>ATLAS</em></span>
            </a>
            <nav className="hdr-nav">
              <a href="#/" className={route.page !== 'explorer' ? 'on' : ''}>Metrics</a>
              <a href="#/explorer" className={route.page === 'explorer' ? 'on' : ''}>Explorer</a>
            </nav>
            <div className="hdr-status">
              <span className="hide-sm" title={status?.latestMetricsDay
                ? `Latest finalized day: ${fmtDay(status.latestMetricsDay)}` : undefined}>
                <span className={'dot' + (stale ? ' stale' : '')} />
                {status?.syncedHeight
                  ? `block ${Number(status.syncedHeight).toLocaleString()}`
                  : 'sync starting'}
              </span>
              {(spot?.price ?? latest.price)
                ? <span className="hdr-price" title={spot?.source === 'massive_live'
                    ? 'Live consolidated price (Massive)' : 'Latest daily close'}>
                    {spot?.source === 'massive_live' && <i className="live-dot" aria-hidden="true" />}
                    BTC {fmt(spot?.price ?? latest.price, 'usd')}
                  </span> : null}
            </div>
          </div>
        </header>
      )}

      {route.page === 'admin'
        ? <Admin />
        : route.page === 'explorer'
        ? <Explorer view={route.view} param={route.param} />
        : metric
          ? <MetricDetail metric={metric} categories={catalog.categories}
              latestVal={latest.values?.[metric.slug]?.value ?? null} onBack={back}
              features={status?.features} />
          : <Overview catalog={catalog} latest={latest} onOpen={open} />}

      {!isEmbed && (
        <footer className="foot">
          <div className="wrap">
            {status?.features?.newsletterSignup && (
              <div className="foot-subscribe">
                <h3>Stay on Course. Get the Signal.</h3>
                <p>Chart-driven reads on the Bitcoin ledger, straight from a fully-validating node.</p>
                <SubscribeForm />
              </div>
            )}
          </div>
          <div className="wrap disclaimer">
            True North Atlas is for informational and educational purposes only. Nothing here is
            investment advice or an offer of any security or investment product. Consult your own
            investment and tax advisors.
            <div className="foot-network">
              Powered by <a href="https://strive.com" target="_blank" rel="noopener">Strive</a>
            </div>
            <div className="foot-copyright">
              © 2026 Strive, Inc. All rights reserved.
            </div>
          </div>
        </footer>
      )}
    </>
  );
}
