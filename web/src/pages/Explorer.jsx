// Block explorer UI. One component handles all four views (home/search,
// block, transaction, address); routing arrives via props from App.jsx:
//   #/explorer            -> home: search box + recent blocks
//   #/b/:heightOrHash     -> block view
//   #/tx/:txid            -> transaction view
//   #/a/:address          -> address view
import { useEffect, useState } from 'react';
import { api, fmt, compact } from '../api.js';

const btc = (v) => (v === null || v === undefined ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 8 }) + ' BTC');
const sat2btc = (s) => btc(Number(s) / 1e8);
const when = (t) => (t ? new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '—');
const mid = (s, n = 12) => (s && s.length > n * 2 + 3 ? s.slice(0, n) + '…' + s.slice(-n) : s);

function go(hash) { window.location.hash = hash; window.scrollTo(0, 0); }

export function SearchBox({ initial = '', autoFocus = false }) {
  const [q, setQ] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [miss, setMiss] = useState(null);

  const submit = async () => {
    const query = q.trim();
    if (!query || busy) return;
    setBusy(true); setMiss(null);
    try {
      const r = await api.explorerSearch(query);
      if (r.found === 'block') go(`#/b/${r.block.height}`);
      else if (r.found === 'tx') go(`#/tx/${r.tx.txid}`);
      else if (r.found === 'address') go(`#/a/${r.address.address}`);
      else setMiss(r.hint ?? 'Nothing found for that query on the synced chain.');
    } catch (e) {
      setMiss('Search failed: ' + e.message);
    } finally { setBusy(false); }
  };

  return (
    <div className="xsearch">
      <input
        value={q}
        autoFocus={autoFocus}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
        placeholder="Block height, block hash, transaction ID, or address…"
        aria-label="Search the blockchain"
        spellCheck="false"
      />
      <button onClick={submit} disabled={busy}>{busy ? '…' : 'Search'}</button>
      {miss && <div className="xmiss">{miss}</div>}
    </div>
  );
}

function Row({ label, children, monoValue }) {
  return (
    <div className="xrow">
      <div className="xlabel">{label}</div>
      <div className={monoValue ? 'xval mono' : 'xval'}>{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
function ExplorerHome() {
  const [recent, setRecent] = useState(null);
  useEffect(() => { api.explorerRecent().then(r => setRecent(r.blocks)).catch(() => setRecent([])); }, []);
  return (
    <>
      <div className="hero wrap">
        <p className="eyebrow">Every Block. Every Coin. First-Hand.</p>
        <h1>Block Explorer</h1>
        <p>
          Search blocks, transactions, and addresses, served from the same fully-validating
          node behind the analytics. <span className="free">Free, for the community.</span>
        </p>
      </div>
      <div className="wrap">
        <SearchBox autoFocus />
        <div className="sec"><h2>Latest blocks</h2></div>
        {!recent && <div className="loading">Loading…</div>}
        {recent && recent.length === 0 && (
          <div className="syncnote">No blocks synced yet. The worker is starting its replay from genesis.</div>
        )}
        {recent && recent.length > 0 && (
          <div className="xtable" role="table">
            <div className="xthead" role="row">
              <span>Height</span><span>Time</span><span>Txs</span><span>Fees</span>
            </div>
            {recent.map(b => (
              <button key={b.height} className="xtr" role="row" onClick={() => go(`#/b/${b.height}`)}>
                <span className="mono">{b.height.toLocaleString()}</span>
                <span>{when(b.time)}</span>
                <span>{b.tx_count?.toLocaleString?.() ?? b.tx_count}</span>
                <span>{sat2btc(b.fees_sat)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
function BlockView({ id }) {
  const [b, setB] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    setB(null); setErr(null);
    api.explorerBlock(id).then(setB).catch(e => setErr(e.message));
  }, [id]);

  if (err) return <div className="wrap"><div className="err">Block not found: {err}</div></div>;
  if (!b) return <div className="wrap"><div className="loading">Loading block…</div></div>;
  return (
    <div className="wrap">
      <div className="detail-hd">
        <div className="crumb"><a href="#/explorer">← Explorer</a> / Block</div>
        <h1>Block {b.height.toLocaleString()}</h1>
      </div>
      <div className="xcard">
        <Row label="Hash" monoValue>{b.hash}</Row>
        <Row label="Time">{when(b.time)}</Row>
        <Row label="Transactions">{b.tx_count?.toLocaleString?.() ?? '—'}</Row>
        <Row label="Subsidy">{sat2btc(b.subsidy_sat)}</Row>
        <Row label="Fees">{sat2btc(b.fees_sat)}</Row>
        <Row label="Difficulty">{b.difficulty ? compact(b.difficulty) : '—'}</Row>
        {b.detail && <>
          <Row label="Size / Weight">{b.detail.size?.toLocaleString()} B / {b.detail.weight?.toLocaleString()} WU</Row>
          <Row label="Merkle root" monoValue>{mid(b.detail.merkleroot)}</Row>
          <Row label="Previous block" monoValue>
            <a href={`#/b/${b.detail.previousblockhash}`}>{mid(b.detail.previousblockhash)}</a>
          </Row>
          {b.detail.nextblockhash &&
            <Row label="Next block" monoValue>
              <a href={`#/b/${b.detail.nextblockhash}`}>{mid(b.detail.nextblockhash)}</a>
            </Row>}
        </>}
      </div>
      {b.detail?.txids && (
        <>
          <div className="sec"><h2>Transactions <span>{b.detail.txids.length.toLocaleString()}</span></h2></div>
          <div className="xcard">
            {b.detail.txids.slice(0, 200).map(t => (
              <div className="xrow" key={t}>
                <div className="xval mono"><a href={`#/tx/${t}`}>{mid(t, 20)}</a></div>
              </div>
            ))}
            {b.detail.txids.length > 200 && (
              <div className="xrow"><div className="xval">…and {(b.detail.txids.length - 200).toLocaleString()} more.</div></div>
            )}
          </div>
        </>
      )}
      {!b.rpc && (
        <div className="syncnote">
          Summary served from the local index. Full transaction listings require the API's
          node connection, which is currently unavailable.
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
function TxView({ txid }) {
  const [t, setT] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    setT(null); setErr(null);
    api.explorerTx(txid).then(setT).catch(e => setErr(e.message));
  }, [txid]);

  if (err) return <div className="wrap"><div className="err">Transaction not found: {err}</div></div>;
  if (!t) return <div className="wrap"><div className="loading">Loading transaction…</div></div>;
  const totalOut = (t.outputs ?? []).reduce((a, o) => a + (o.value_btc ?? 0), 0);
  return (
    <div className="wrap">
      <div className="detail-hd">
        <div className="crumb"><a href="#/explorer">← Explorer</a> / Transaction</div>
        <h1 className="mono xh-hash">{mid(t.txid, 16)}</h1>
      </div>
      <div className="xcard">
        <Row label="Transaction ID" monoValue>{t.txid}</Row>
        <Row label="Block">{t.block_height !== null
          ? <a href={`#/b/${t.block_height}`}>{t.block_height.toLocaleString()}</a> : 'unconfirmed / unknown'}</Row>
        <Row label="Time">{when(t.time)}</Row>
        <Row label="Type">{t.coinbase ? 'Coinbase (block reward)' : 'Transfer'}</Row>
        <Row label="Total output">{btc(totalOut)}</Row>
      </div>

      <div className="xsplit">
        <div>
          <div className="sec"><h2>Inputs</h2></div>
          <div className="xcard">
            {t.coinbase && <div className="xrow"><div className="xval">New coins (block subsidy + fees)</div></div>}
            {!t.coinbase && (t.inputs ?? []).map((i, n) => (
              <div className="xrow" key={n}>
                <div className="xval">
                  <span className="mono">{i.address ? <a href={`#/a/${i.address}`}>{mid(i.address, 10)}</a> : mid(i.txid, 10) + ':' + i.vout}</span>
                  <span className="xamt">{i.value_btc !== null ? btc(i.value_btc) : ''}</span>
                </div>
              </div>
            ))}
            {!t.coinbase && !t.inputs && (
              <div className="xrow"><div className="xval">Input detail requires the API's node connection.</div></div>
            )}
          </div>
        </div>
        <div>
          <div className="sec"><h2>Outputs</h2></div>
          <div className="xcard">
            {(t.outputs ?? []).map(o => (
              <div className="xrow" key={o.n}>
                <div className="xval">
                  <span className="mono">{o.address ? <a href={`#/a/${o.address}`}>{mid(o.address, 10)}</a> : 'non-standard'}</span>
                  <span className="xamt">{btc(o.value_btc)}
                    {o.spent === true && <em className="xspent"> spent</em>}
                    {o.spent === false && <em className="xunspent"> unspent</em>}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
function AddressView({ addr }) {
  const [a, setA] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    setA(null); setErr(null);
    api.explorerAddress(addr).then(setA).catch(e => setErr(e.message));
  }, [addr]);

  if (err) return <div className="wrap"><div className="err">Lookup failed: {err}</div></div>;
  if (!a) return <div className="wrap"><div className="loading">Loading address…</div></div>;
  return (
    <div className="wrap">
      <div className="detail-hd">
        <div className="crumb"><a href="#/explorer">← Explorer</a> / Address</div>
        <h1 className="mono xh-hash">{mid(a.address, 14)}</h1>
        <div className="bigval">{btc(a.balance_btc)}
          {a.balance_usd !== null && <span className="xusd"> ≈ {fmt(a.balance_usd, 'usd')}</span>}
        </div>
      </div>
      <div className="xcard">
        <Row label="Address" monoValue>{a.address}</Row>
        <Row label="Confirmed balance">{btc(a.balance_btc)}</Row>
        <Row label="Unspent outputs">{a.utxo_count.toLocaleString()}</Row>
      </div>
      <div className="sec"><h2>UTXOs <span>{a.utxos.length < a.utxo_count ? `showing ${a.utxos.length} of ${a.utxo_count}` : ''}</span></h2></div>
      <div className="xcard">
        {a.utxos.length === 0 && <div className="xrow"><div className="xval">No unspent outputs.</div></div>}
        {a.utxos.map(u => (
          <div className="xrow" key={u.txid + ':' + u.vout}>
            <div className="xval">
              <span className="mono"><a href={`#/tx/${u.txid}`}>{mid(u.txid, 10)}</a>:{u.vout}</span>
              <span className="xamt">{sat2btc(u.value_sat)} · block {u.height.toLocaleString()}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="syncnote">{a.note}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
export default function Explorer({ view, param }) {
  if (view === 'block' || view === 'tx' || view === 'address') {
    return (
      <>
        <div className="wrap xsub-search"><SearchBox /></div>
        {view === 'block' ? <BlockView id={param} />
          : view === 'tx' ? <TxView txid={param} />
          : <AddressView addr={param} />}
      </>
    );
  }
  return <ExplorerHome />;
}
