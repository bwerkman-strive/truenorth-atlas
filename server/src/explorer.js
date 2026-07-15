// Block explorer backend.
//
// Data strategy: DB-first, RPC-enriched.
//   - blocks table       -> block summaries (height, hash, time, fees, difficulty)
//   - utxos table        -> address balances + live UTXO listings (exact,
//                           because the sync worker maintains the full UTXO set
//                           with addresses from genesis)
//   - Bitcoin Core RPC   -> full block tx lists and transaction detail, when
//                           the API service can reach the node. Without RPC,
//                           the explorer still works: DB-backed answers with
//                           `rpc: false` flagged in responses.
//
// Transaction lookup works even WITHOUT txindex on the node: if any output of
// the tx is still tracked in our UTXO table (unspent, or spent within the
// prune window), we know its block and fetch it by blockhash.
import express from 'express';
import { pool } from './db.js';
import { rpc } from './rpc.js';
import { config } from './config.js';

const HEX64 = /^[0-9a-f]{64}$/i;
const HEIGHT = /^\d{1,9}$/;
// Mainnet address shapes: P2PKH (1…), P2SH (3…), bech32 (bc1q…), taproot (bc1p…)
const ADDR = /^(1[a-km-zA-HJ-NP-Z1-9]{25,34}|3[a-km-zA-HJ-NP-Z1-9]{25,34}|bc1[qp][a-z0-9]{38,58})$/;

let rpcAvailable = null; // tri-state: null=unknown, true/false=probed
async function rpcUp() {
  if (rpcAvailable !== null) return rpcAvailable;
  if (!config.rpcUser && !config.rpcPass && config.rpcUrl.includes('127.0.0.1')) {
    rpcAvailable = false; return false; // clearly unconfigured
  }
  try { await rpc.getBestBlockHash(); rpcAvailable = true; }
  catch { rpcAvailable = false; }
  setTimeout(() => { rpcAvailable = null; }, 60_000).unref?.(); // re-probe every minute
  return rpcAvailable;
}

// ---------------------------------------------------------------------------
const r8 = (v) => (v == null ? null : +v.toFixed(8)); // trim float-sum artifacts
const toSat = (btc) => (btc == null ? null : Math.round(btc * 1e8));

async function tipHeight() {
  const r = await pool.query('SELECT MAX(height)::int AS tip FROM blocks');
  return r.rows[0].tip ?? null;
}

// Per-transaction summary card for block listings: amounts and fee from the
// verbosity-3 payload we already fetch. Input/output previews are capped;
// in_count/out_count carry the true totals.
const TX_PAGE = 25;
const TX_PREVIEW = 8;
function txSummary(t) {
  const coinbase = t.vin?.[0]?.coinbase !== undefined;
  const outSum = (t.vout ?? []).reduce((a, o) => a + (o.value ?? 0), 0);
  let fee = coinbase ? null : t.fee ?? null;
  if (fee == null && !coinbase && (t.vin ?? []).length &&
      t.vin.every(v => v.prevout?.value != null)) {
    fee = t.vin.reduce((a, v) => a + v.prevout.value, 0) - outSum;
  }
  return {
    txid: t.txid,
    coinbase,
    fee_sat: toSat(fee),
    vsize: t.vsize ?? (t.weight ? Math.ceil(t.weight / 4) : null),
    total_out_btc: r8(outSum),
    in_count: t.vin?.length ?? 0,
    out_count: t.vout?.length ?? 0,
    inputs: coinbase ? [] : (t.vin ?? []).slice(0, TX_PREVIEW).map(v => ({
      address: v.prevout?.scriptPubKey?.address ?? null,
      value_btc: r8(v.prevout?.value ?? null),
    })),
    outputs: (t.vout ?? []).slice(0, TX_PREVIEW).map(o => ({
      address: o.scriptPubKey?.address ?? null,
      value_btc: r8(o.value ?? null),
    })),
  };
}

// Serialized-block cache: confirmed blocks are immutable, and a verbosity-3
// fetch is expensive (especially over Tor), so keep the derived header +
// tx summaries for recently viewed blocks. Tip blocks (no nextblockhash yet)
// are never cached — their nextblockhash is still changing.
const blockCache = new Map(); // hash -> { node, txsAll }
const BLOCK_CACHE_MAX = 12;
function blockCachePut(hash, entry) {
  blockCache.delete(hash);
  blockCache.set(hash, entry);
  if (blockCache.size > BLOCK_CACHE_MAX) blockCache.delete(blockCache.keys().next().value);
}

async function blockFromDb(idOrHash) {
  const byHeight = HEIGHT.test(idOrHash);
  const r = await pool.query(
    `SELECT height, hash, EXTRACT(EPOCH FROM time)::bigint AS time, day::text,
            tx_count, subsidy_sat, fees_sat, difficulty, size_bytes, weight
     FROM blocks WHERE ${byHeight ? 'height = $1' : 'hash = $1'}`,
    [byHeight ? Number(idOrHash) : idOrHash.toLowerCase()]);
  return r.rows[0] ?? null;
}

export async function getBlock(idOrHash, txStart = 0) {
  const db = await blockFromDb(idOrHash);
  let node = null, txsAll = null;
  if (await rpcUp()) {
    try {
      const hash = db?.hash ?? (HEIGHT.test(idOrHash)
        ? await rpc.getBlockHash(Number(idOrHash))
        : idOrHash.toLowerCase());
      const cached = blockCache.get(hash);
      if (cached) {
        ({ node, txsAll } = cached);
      } else {
        const b = await rpc.getBlockV3(hash);
        node = {
          hash: b.hash, height: b.height, time: b.time, size: b.size, weight: b.weight,
          version: b.version, merkleroot: b.merkleroot, nonce: b.nonce, bits: b.bits,
          difficulty: b.difficulty, mediantime: b.mediantime ?? null,
          previousblockhash: b.previousblockhash,
          nextblockhash: b.nextblockhash ?? null,
          txids: b.tx.map(t => t.txid),
        };
        txsAll = b.tx.map(txSummary);
        if (node.nextblockhash) blockCachePut(hash, { node, txsAll });
      }
    } catch { /* fall through to DB-only */ }
  }
  if (!db && !node) return null;
  // Lazy backfill: rows synced before the size columns existed get them the
  // first time the block is viewed with RPC available.
  if (node && db && db.size_bytes == null && node.size != null) {
    await pool.query(
      'UPDATE blocks SET size_bytes = $1, weight = $2 WHERE height = $3 AND size_bytes IS NULL',
      [node.size, node.weight ?? null, node.height]).catch(() => {});
    db.size_bytes = node.size; db.weight = node.weight ?? null;
  }
  const height = node?.height ?? db.height;
  const tip = await tipHeight();
  return {
    height,
    hash: node?.hash ?? db.hash,
    time: node?.time ?? Number(db.time),
    tx_count: node?.txids?.length ?? db?.tx_count ?? null,
    size_bytes: node?.size ?? db?.size_bytes ?? null,
    weight: node?.weight ?? db?.weight ?? null,
    confirmations: tip != null && tip >= height ? tip - height + 1 : null, // null: beyond our synced tip
    subsidy_sat: db ? Number(db.subsidy_sat) : null,
    fees_sat: db ? Number(db.fees_sat) : null,
    difficulty: node?.difficulty ?? (db ? Number(db.difficulty) : null),
    detail: node,           // null when RPC unreachable
    txs: txsAll ? txsAll.slice(txStart, txStart + TX_PAGE) : null,
    tx_start: txStart,
    rpc: !!node,
  };
}

// ---------------------------------------------------------------------------
// Find the block containing a txid using our own UTXO table (works without
// txindex as long as one output is still tracked).
async function blockHashForTx(txid) {
  const r = await pool.query(
    `SELECT b.hash FROM utxos u JOIN blocks b ON b.height = u.created_height
     WHERE u.txid = $1 LIMIT 1`, [Buffer.from(txid, 'hex')]);
  return r.rows[0]?.hash ?? null;
}

export async function getTx(txid) {
  txid = txid.toLowerCase();
  const outsR = await pool.query(
    `SELECT vout, value_sat, address, created_height, spent_height, coinbase,
            encode(spent_txid, 'hex') AS spent_txid
     FROM utxos WHERE txid = $1 ORDER BY vout`, [Buffer.from(txid, 'hex')]);
  const tracked = outsR.rows;

  let node = null;
  if (await rpcUp()) {
    try {
      // Prefer direct lookup (works if node has txindex=1)…
      node = await rpc.getRawTransactionVerbose(txid);
    } catch {
      // …fall back to fetching by blockhash learned from our UTXO table.
      const bh = await blockHashForTx(txid);
      if (bh) {
        try {
          const blk = await rpc.getBlockV3(bh);
          const t = blk.tx.find(x => x.txid === txid);
          if (t) node = { ...t, blockhash: blk.hash, blocktime: blk.time, blockheight: blk.height };
        } catch { /* DB-only */ }
      }
    }
  }
  if (!node && !tracked.length) return null;

  const tip = await tipHeight();
  const blockHeight = node?.blockheight ?? tracked[0]?.created_height ?? null;
  const coinbase = node ? (node.vin?.[0]?.coinbase !== undefined) : !!tracked[0]?.coinbase;

  // Totals and fee. Prevout values arrive via verbosity-2/3; when every input
  // value is known, fee = in - out (Core's own `fee` field is preferred when
  // present). Coinbase transactions have no fee by definition.
  const outSum = node
    ? (node.vout ?? []).reduce((a, o) => a + (o.value ?? 0), 0)
    : tracked.reduce((a, t) => a + Number(t.value_sat), 0) / 1e8;
  let inSum = null;
  if (node && !coinbase && (node.vin ?? []).length &&
      node.vin.every(v => v.prevout?.value != null)) {
    inSum = node.vin.reduce((a, v) => a + v.prevout.value, 0);
  }
  const feeSat = coinbase ? null
    : node?.fee != null ? toSat(node.fee)
    : inSum != null ? toSat(inSum - outSum)
    : null;
  const vsize = node?.vsize ?? (node?.weight ? Math.ceil(node.weight / 4) : null);
  const sequencesKnown = node && !coinbase && (node.vin ?? []).every(v => v.sequence != null);

  return {
    txid,
    block_height: blockHeight,
    block_hash: node?.blockhash ?? null,
    time: node?.blocktime ?? null,
    // Confirmed: depth from our synced tip. Known to the node but not in a
    // block: 0 (mempool). DB-only with no synced tip: null.
    confirmations: blockHeight != null && tip != null && tip >= blockHeight
      ? tip - blockHeight + 1 : (node && blockHeight == null ? 0 : null),
    coinbase,
    size: node?.size ?? null,
    vsize,
    weight: node?.weight ?? null,
    version: node?.version ?? null,
    locktime: node?.locktime ?? null,
    rbf: sequencesKnown ? node.vin.some(v => v.sequence < 0xfffffffe) : null,
    fee_sat: feeSat,
    fee_rate: feeSat != null && vsize ? Math.round((feeSat / vsize) * 100) / 100 : null, // sat/vB
    total_in_btc: r8(inSum),
    total_out_btc: r8(outSum),
    inputs: node?.vin?.map(v => v.coinbase !== undefined
      ? { coinbase: true }
      : { txid: v.txid, vout: v.vout, value_btc: r8(v.prevout?.value ?? null),
          address: v.prevout?.scriptPubKey?.address ?? null,
          sequence: v.sequence ?? null,
          scriptsig_asm: v.scriptSig?.asm ?? null,
          witness: v.txinwitness ?? null }) ?? null,
    outputs: node
      ? node.vout.map(o => {
          const row = tracked.find(t => t.vout === o.n);
          return {
            n: o.n, value_btc: r8(o.value), address: o.scriptPubKey?.address ?? null,
            type: o.scriptPubKey?.type ?? null,
            scriptpubkey_asm: o.scriptPubKey?.asm ?? null,
            spent: row ? row.spent_height != null : null,
            spent_txid: row?.spent_txid ?? null,
          };
        })
      : tracked.map(t => ({
          n: t.vout, value_btc: Number(t.value_sat) / 1e8, address: t.address,
          type: null, scriptpubkey_asm: null,
          spent: t.spent_height != null,
          spent_txid: t.spent_txid ?? null,
        })),
    rpc: !!node,
  };
}

// ---------------------------------------------------------------------------
export async function getAddress(addr) {
  const [bal, utxoR, priceR] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(value_sat),0)::bigint AS sat, COUNT(*)::int AS n
       FROM utxos WHERE address = $1 AND spent_height IS NULL`, [addr]),
    pool.query(
      `SELECT encode(txid,'hex') AS txid, vout, value_sat::bigint AS value_sat,
              created_height, EXTRACT(EPOCH FROM created_time)::bigint AS created_time
       FROM utxos WHERE address = $1 AND spent_height IS NULL
       ORDER BY created_height DESC LIMIT 500`, [addr]),
    pool.query(`SELECT close_usd::float p FROM prices ORDER BY day DESC LIMIT 1`),
  ]);
  const sat = Number(bal.rows[0].sat);
  const px = priceR.rows[0]?.p ?? null;
  return {
    address: addr,
    balance_sat: sat,
    balance_btc: sat / 1e8,
    balance_usd: px != null ? (sat / 1e8) * px : null,
    utxo_count: bal.rows[0].n,
    utxos: utxoR.rows.map(u => ({
      txid: u.txid, vout: u.vout, value_sat: Number(u.value_sat),
      height: u.created_height, time: Number(u.created_time),
    })),
    note: 'Balance and UTXOs reflect the synced chain tip. Spent-output history is retained only for recent blocks.',
  };
}

// ---------------------------------------------------------------------------
export function classify(q) {
  q = q.trim();
  if (HEIGHT.test(q)) return { type: 'block', q };
  if (ADDR.test(q)) return { type: 'address', q };
  if (HEX64.test(q)) return { type: 'hash64', q: q.toLowerCase() };
  return { type: 'unknown', q };
}

export async function search(q) {
  const c = classify(q);
  if (c.type === 'block') {
    const b = await getBlock(c.q);
    return b ? { found: 'block', block: b } : { found: null };
  }
  if (c.type === 'address') {
    return { found: 'address', address: await getAddress(c.q) };
  }
  if (c.type === 'hash64') {
    // 64-hex is ambiguous: block hash or txid. Blocks are cheap to check first.
    const b = await getBlock(c.q);
    if (b) return { found: 'block', block: b };
    const t = await getTx(c.q);
    if (t) return { found: 'tx', tx: t };
    return { found: null };
  }
  return { found: null, hint: 'Enter a block height, block hash, transaction ID, or address.' };
}

// ---------------------------------------------------------------------------
// Simple fixed-window per-IP rate limiter for the free public surface.
// (Keyed /v1 traffic is not limited here.)
const hits = new Map();
export function publicRateLimit(req, res, next) {
  const limit = config.publicRateLimit;
  if (limit <= 0) return next();
  const now = Date.now();
  const win = Math.floor(now / 60_000);
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
  const k = `${ip}:${win}`;
  const n = (hits.get(k) ?? 0) + 1;
  hits.set(k, n);
  if (hits.size > 50_000) { // bounded memory
    for (const key of hits.keys()) { if (!key.endsWith(`:${win}`)) hits.delete(key); }
  }
  if (n > limit) return res.status(429).json({ error: 'rate limited — get an API key for programmatic access' });
  next();
}

// ---------------------------------------------------------------------------
// One router serves both surfaces; the caller mounts it publicly at
// /api/explorer (rate-limited) and privately at /v1 (behind requireApiKey).
export function explorerRouter() {
  const r = express.Router();

  r.get('/search', async (req, res) => {
    try { res.json(await search(String(req.query.q ?? ''))); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  r.get('/block/:id', async (req, res) => {
    const id = String(req.params.id);
    if (!HEIGHT.test(id) && !HEX64.test(id)) return res.status(400).json({ error: 'block height or hash required' });
    const txStart = Math.min(Math.max(parseInt(req.query.txstart, 10) || 0, 0), 1_000_000);
    try {
      const b = await getBlock(id, txStart);
      b ? res.json(b) : res.status(404).json({ error: 'block not found (or not yet synced)' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  r.get('/tx/:txid', async (req, res) => {
    if (!HEX64.test(req.params.txid)) return res.status(400).json({ error: 'txid must be 64 hex chars' });
    try {
      const t = await getTx(req.params.txid);
      t ? res.json(t) : res.status(404).json({ error: 'transaction not found' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  r.get('/address/:addr', async (req, res) => {
    if (!ADDR.test(req.params.addr)) return res.status(400).json({ error: 'unrecognized address format' });
    try { res.json(await getAddress(req.params.addr)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  r.get('/blocks/recent', async (_req, res) => {
    try {
      const r2 = await pool.query(
        `SELECT height, hash, EXTRACT(EPOCH FROM time)::bigint AS time, tx_count,
                fees_sat::bigint AS fees_sat, size_bytes, weight
         FROM blocks ORDER BY height DESC LIMIT 12`);
      res.json({ blocks: r2.rows.map(b => ({ ...b, time: Number(b.time), fees_sat: Number(b.fees_sat) })) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return r;
}
