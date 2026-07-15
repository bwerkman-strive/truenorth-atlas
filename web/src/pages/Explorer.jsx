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
const when = (t) => {
  if (!t) return '—';
  const iso = new Date(t * 1000).toISOString();
  return `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)} ${iso.slice(11, 19)} UTC`;
};
const mid = (s, n = 12) => (s && s.length > n * 2 + 3 ? s.slice(0, n) + '…' + s.slice(-n) : s);
const blkSize = (bytes) => (bytes == null ? '—'
  : bytes >= 1e6 ? (bytes / 1e6).toFixed(2) + ' MB'
  : (bytes / 1e3).toFixed(1) + ' kB');

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
          node behind the analytics.
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
              <span>Height</span><span>Time</span><span>Txs</span><span>Size</span><span>Fees</span>
            </div>
            {recent.map(b => (
              <button key={b.height} className="xtr" role="row" onClick={() => go(`#/b/${b.height}`)}>
                <span className="mono">{b.height.toLocaleString()}</span>
                <span>{when(b.time)}</span>
                <span>{b.tx_count?.toLocaleString?.() ?? b.tx_count}</span>
                <span>{blkSize(b.size_bytes)}</span>
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
const TX_PAGE = 25;

// One transaction inside a block listing: txid + fee up top, then the
// input -> output flow with amounts (previews capped server-side; the
// counts carry the true totals).
function TxCard({ t }) {
  const feeNote = t.coinbase ? 'coinbase'
    : t.fee_sat != null
      ? `fee ${t.fee_sat.toLocaleString()} sat${t.vsize ? ` · ${(t.fee_sat / t.vsize).toFixed(1)} sat/vB` : ''}`
      : '';
  return (
    <div className="xtxcard">
      <div className="xtxhead">
        <a className="mono" href={`#/tx/${t.txid}`}>{mid(t.txid, 16)}</a>
        <span className="xmeta">{feeNote}{feeNote && ' · '}{btc(t.total_out_btc)}</span>
      </div>
      <div className="xsplit">
        <div>
          {t.coinbase && <div className="xioline">New coins (subsidy + fees)</div>}
          {!t.coinbase && t.inputs.map((i, n) => (
            <div className="xioline" key={n}>
              <span className="mono">{i.address ? <a href={`#/a/${i.address}`}>{mid(i.address, 8)}</a> : 'non-standard'}</span>
              <span className="xamt">{i.value_btc != null ? btc(i.value_btc) : ''}</span>
            </div>
          ))}
          {!t.coinbase && t.in_count > t.inputs.length && (
            <div className="xioline xmeta">…{(t.in_count - t.inputs.length).toLocaleString()} more inputs</div>
          )}
        </div>
        <div>
          {t.outputs.map((o, n) => (
            <div className="xioline" key={n}>
              <span className="mono">{o.address ? <a href={`#/a/${o.address}`}>{mid(o.address, 8)}</a> : 'non-standard'}</span>
              <span className="xamt">{o.value_btc != null ? btc(o.value_btc) : ''}</span>
            </div>
          ))}
          {t.out_count > t.outputs.length && (
            <div className="xioline xmeta">…{(t.out_count - t.outputs.length).toLocaleString()} more outputs</div>
          )}
        </div>
      </div>
    </div>
  );
}

function BlockView({ id }) {
  const [b, setB] = useState(null);
  const [err, setErr] = useState(null);
  const [page, setPage] = useState(0);
  useEffect(() => {
    setErr(null);
    api.explorerBlock(id, page * TX_PAGE).then(setB).catch(e => setErr(e.message));
  }, [id, page]);

  if (err) return <div className="wrap"><div className="err">Block not found: {err}</div></div>;
  if (!b) return <div className="wrap"><div className="loading">Loading block…</div></div>;
  const d = b.detail;
  const vsize = b.weight ? Math.ceil(b.weight / 4) : null;
  const txFrom = page * TX_PAGE;
  const hasPager = b.txs && b.tx_count > TX_PAGE;
  return (
    <div className="wrap">
      <div className="detail-hd">
        <div className="crumb"><a href="#/explorer">← Explorer</a> / Block</div>
        <h1>Block {b.height.toLocaleString()}</h1>
      </div>
      <div className="xcard">
        <Row label="Hash" monoValue>{b.hash}</Row>
        <Row label="Time">{when(b.time)}</Row>
        {b.confirmations != null &&
          <Row label="Confirmations">{b.confirmations.toLocaleString()}</Row>}
        <Row label="Transactions">{b.tx_count?.toLocaleString?.() ?? '—'}</Row>
        <Row label="Subsidy">{sat2btc(b.subsidy_sat)}</Row>
        <Row label="Fees">{sat2btc(b.fees_sat)}</Row>
        <Row label="Difficulty">{b.difficulty ? compact(b.difficulty) : '—'}</Row>
        {b.size_bytes != null &&
          <Row label="Size / Weight">
            {b.size_bytes.toLocaleString()} B / {b.weight?.toLocaleString()} WU{vsize ? ` (${vsize.toLocaleString()} vB)` : ''}
          </Row>}
        {d && <>
          {d.mediantime != null && <Row label="Median time">{when(d.mediantime)}</Row>}
          <Row label="Version / Bits / Nonce" monoValue>
            0x{d.version?.toString(16)} / {d.bits} / {d.nonce?.toLocaleString()}
          </Row>
          <Row label="Merkle root" monoValue>{mid(d.merkleroot)}</Row>
          <Row label="Previous block" monoValue>
            <a href={`#/b/${d.previousblockhash}`}>{mid(d.previousblockhash)}</a>
          </Row>
          {d.nextblockhash &&
            <Row label="Next block" monoValue>
              <a href={`#/b/${d.nextblockhash}`}>{mid(d.nextblockhash)}</a>
            </Row>}
        </>}
      </div>
      {b.txs && b.txs.length > 0 && (
        <>
          <div className="sec"><h2>Transactions <span>
            {b.tx_count > TX_PAGE
              ? `${(txFrom + 1).toLocaleString()}–${(txFrom + b.txs.length).toLocaleString()} of ${b.tx_count.toLocaleString()}`
              : b.tx_count.toLocaleString()}
          </span></h2></div>
          <div className="xcard">
            {b.txs.map(t => <TxCard key={t.txid} t={t} />)}
          </div>
          {hasPager && (
            <div className="xpager">
              <button onClick={() => setPage(p => p - 1)} disabled={page === 0}>← Previous</button>
              <span>page {(page + 1).toLocaleString()} of {Math.ceil(b.tx_count / TX_PAGE).toLocaleString()}</span>
              <button onClick={() => setPage(p => p + 1)}
                disabled={txFrom + b.txs.length >= b.tx_count}>Next →</button>
            </div>
          )}
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
  const [scripts, setScripts] = useState(false);
  useEffect(() => {
    setT(null); setErr(null); setScripts(false);
    api.explorerTx(txid).then(setT).catch(e => setErr(e.message));
  }, [txid]);

  if (err) return <div className="wrap"><div className="err">Transaction not found: {err}</div></div>;
  if (!t) return <div className="wrap"><div className="loading">Loading transaction…</div></div>;
  const unconfirmed = t.block_height === null && t.rpc;
  return (
    <div className="wrap">
      <div className="detail-hd">
        <div className="crumb"><a href="#/explorer">← Explorer</a> / Transaction</div>
        <h1 className="mono xh-hash">{mid(t.txid, 16)}</h1>
      </div>
      <div className="xcard">
        <Row label="Transaction ID" monoValue>{t.txid}</Row>
        <Row label="Status">{unconfirmed
          ? 'Unconfirmed (in mempool)'
          : t.confirmations != null
            ? `Confirmed · ${t.confirmations.toLocaleString()} confirmation${t.confirmations === 1 ? '' : 's'}`
            : 'Confirmed'}</Row>
        <Row label="Block">{t.block_height !== null
          ? <a href={`#/b/${t.block_height}`}>{t.block_height.toLocaleString()}</a> : '—'}</Row>
        <Row label="Time">{when(t.time)}</Row>
        <Row label="Type">{t.coinbase ? 'Coinbase (block reward)' : 'Transfer'}</Row>
        {t.fee_sat != null && (
          <Row label="Fee">{t.fee_sat.toLocaleString()} sat{t.fee_rate != null ? ` (${t.fee_rate} sat/vB)` : ''}</Row>
        )}
        {t.size != null && (
          <Row label="Size">{t.size.toLocaleString()} B · {t.vsize?.toLocaleString()} vB · {t.weight?.toLocaleString()} WU</Row>
        )}
        {t.version != null && <Row label="Version / Locktime">{t.version} / {t.locktime}</Row>}
        {t.rbf != null && <Row label="Replaceable (RBF)">{t.rbf ? 'Yes (BIP-125 signaled)' : 'No'}</Row>}
        {t.total_in_btc != null && <Row label="Total input">{btc(t.total_in_btc)}</Row>}
        <Row label="Total output">{btc(t.total_out_btc)}</Row>
      </div>

      {t.rpc && (
        <div className="xsec-flex">
          <button className="xtoggle" onClick={() => setScripts(s => !s)}>
            {scripts ? 'Hide script details' : 'Show script details'}
          </button>
        </div>
      )}

      <div className="xsplit">
        <div>
          <div className="sec"><h2>Inputs {t.inputs && <span>{t.inputs.length.toLocaleString()}</span>}</h2></div>
          <div className="xcard">
            {t.coinbase && <div className="xrow"><div className="xval">New coins (block subsidy + fees)</div></div>}
            {!t.coinbase && (t.inputs ?? []).map((i, n) => (
              <div className="xrow" key={n}>
                <div className="xval">
                  <span className="mono">{i.address ? <a href={`#/a/${i.address}`}>{mid(i.address, 10)}</a> : mid(i.txid, 10) + ':' + i.vout}</span>
                  <span className="xamt">{i.value_btc !== null ? btc(i.value_btc) : ''}</span>
                  {scripts && <>
                    <div className="xscript">outpoint {mid(i.txid, 8)}:{i.vout}{i.sequence != null ? ` · sequence ${i.sequence}` : ''}</div>
                    {i.scriptsig_asm ? <div className="xscript">scriptSig: {i.scriptsig_asm}</div> : null}
                    {(i.witness ?? []).map((w, k) => <div className="xscript" key={k}>witness[{k}]: {w}</div>)}
                  </>}
                </div>
              </div>
            ))}
            {!t.coinbase && !t.inputs && (
              <div className="xrow"><div className="xval">Input detail requires the API's node connection.</div></div>
            )}
          </div>
        </div>
        <div>
          <div className="sec"><h2>Outputs {t.outputs && <span>{t.outputs.length.toLocaleString()}</span>}</h2></div>
          <div className="xcard">
            {(t.outputs ?? []).map(o => (
              <div className="xrow" key={o.n}>
                <div className="xval">
                  <span className="mono">{o.address ? <a href={`#/a/${o.address}`}>{mid(o.address, 10)}</a> : 'non-standard'}</span>
                  <span className="xamt">{btc(o.value_btc)}
                    {o.type && <em className="xtype">{o.type}</em>}
                    {o.spent === true && (o.spent_txid
                      ? <em className="xspent"> <a href={`#/tx/${o.spent_txid}`}>spent →</a></em>
                      : <em className="xspent"> spent</em>)}
                    {o.spent === false && <em className="xunspent"> unspent</em>}
                  </span>
                  {scripts && o.scriptpubkey_asm && <div className="xscript">{o.scriptpubkey_asm}</div>}
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
  const hasBasis = a.cost_basis_usd > 0;
  const pnl = a.unrealized_pnl_usd;
  const utxoPnl = (u) => (a.price_usd != null && u.created_price != null
    ? (u.value_sat / 1e8) * (a.price_usd - u.created_price) : null);
  return (
    <div className="wrap">
      <div className="detail-hd">
        <div className="crumb"><a href="#/explorer">← Explorer</a> / Address</div>
        <h1 className="mono xh-hash">{mid(a.address, 14)}</h1>
        <div className="bigval">{btc(a.balance_btc)}
          {a.balance_usd !== null && <span className="xusd"> ≈ {fmt(a.balance_usd, 'usd')}</span>}
        </div>
        {hasBasis && pnl != null && (
          <div className={pnl >= 0 ? 'xpnl up' : 'xpnl down'}>
            {pnl >= 0 ? '+' : '−'}{fmt(Math.abs(pnl), 'usd')}
            {a.unrealized_pnl_pct != null && ` (${pnl >= 0 ? '+' : '−'}${Math.abs(a.unrealized_pnl_pct).toFixed(1)}%)`} unrealized
          </div>
        )}
      </div>
      <div className="xcard">
        <Row label="Address" monoValue>{a.address}</Row>
        <Row label="Confirmed balance">{btc(a.balance_btc)}</Row>
        <Row label="Unspent outputs">{a.utxo_count.toLocaleString()}</Row>
        {hasBasis && <>
          <Row label="Cost basis">{fmt(a.cost_basis_usd, 'usd')}
            {a.avg_cost_usd != null && <span className="xmeta"> avg {fmt(a.avg_cost_usd, 'usd')} / BTC</span>}
          </Row>
          {pnl != null &&
            <Row label="Unrealized P&L">
              <span className={pnl >= 0 ? 'xpnl-inline up' : 'xpnl-inline down'}>
                {pnl >= 0 ? '+' : '−'}{fmt(Math.abs(pnl), 'usd')}
              </span>
            </Row>}
        </>}
      </div>
      <div className="sec"><h2>UTXOs <span>{a.utxos.length < a.utxo_count ? `showing ${a.utxos.length} of ${a.utxo_count}` : ''}</span></h2></div>
      <div className="xcard">
        {a.utxos.length === 0 && <div className="xrow"><div className="xval">No unspent outputs.</div></div>}
        {a.utxos.map(u => {
          const p = utxoPnl(u);
          return (
            <div className="xrow" key={u.txid + ':' + u.vout}>
              <div className="xval">
                <span className="mono"><a href={`#/tx/${u.txid}`}>{mid(u.txid, 10)}</a>:{u.vout}</span>
                <span className="xamt">{sat2btc(u.value_sat)} · block {u.height.toLocaleString()}
                  {u.created_price != null && (u.created_price === 0
                    ? <em className="xtype">pre-market</em>
                    : <> · @ {fmt(u.created_price, 'usd')}</>)}
                  {p != null && u.created_price > 0 && (
                    <em className={p >= 0 ? 'xunspent' : 'xspent'}> {p >= 0 ? '+' : '−'}{fmt(Math.abs(p), 'usd')}</em>
                  )}
                </span>
              </div>
            </div>
          );
        })}
      </div>
      <div className="syncnote">{a.note} UTXOs are marked with the USD close of their creation day, the address's on-chain cost basis.</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
export default function Explorer({ view, param }) {
  if (view === 'block' || view === 'tx' || view === 'address') {
    return (
      <>
        <div className="wrap xsub-search"><SearchBox /></div>
        {view === 'block' ? <BlockView key={param} id={param} />
          : view === 'tx' ? <TxView txid={param} />
          : <AddressView addr={param} />}
      </>
    );
  }
  return <ExplorerHome />;
}
