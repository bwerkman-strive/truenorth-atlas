// Minimal, resilient Bitcoin Core JSON-RPC client.
// Requirements on the node: server=1, rpcauth/rpcuser+rpcpassword, and
// txindex is NOT required — we use getblock verbosity=3 (prevout data inline),
// available since Bitcoin Core 25.0 (verified against Core 29.x).
//
// Transport: plain HTTP(S) via node:http(s), with optional SOCKS5 proxying so
// the worker can reach a Tor hidden service (Start9 / Umbrel nodes expose RPC
// as a .onion by default). Set TOR_SOCKS_PROXY=socks5h://127.0.0.1:9050, or
// RPC_SOCKS_PROXY for a non-Tor SOCKS path (e.g. Tailscale's userspace proxy).
import http from 'node:http';
import https from 'node:https';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { config } from './config.js';

let idCounter = 0;
let cachedAgent = null;

function agentFor(url) {
  if (config.rpcSocksProxy) {
    // timeout also bounds the SOCKS handshake itself; without it a wedged
    // proxy daemon that accepts the connection but never completes CONNECT
    // would hang the request forever (the http-level timeout only arms after
    // the proxy hands over a socket).
    if (!cachedAgent) cachedAgent = new SocksProxyAgent(config.rpcSocksProxy, { keepAlive: true, timeout: config.rpcTimeoutMs });
    return cachedAgent;
  }
  if (!cachedAgent) {
    const isHttps = url.protocol === 'https:';
    cachedAgent = new (isHttps ? https.Agent : http.Agent)({ keepAlive: true, maxSockets: 16 });
  }
  return cachedAgent;
}

function httpPost(urlStr, body, timeoutMs) {
  const url = new URL(urlStr);
  const mod = url.protocol === 'https:' ? https : http;
  const options = {
    method: 'POST',
    agent: agentFor(url),
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      authorization: 'Basic ' + Buffer.from(`${config.rpcUser}:${config.rpcPass}`).toString('base64'),
    },
    timeout: timeoutMs,
  };
  return new Promise((resolve, reject) => {
    const req = mod.request(url, options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (e) {
          reject(new Error(`RPC: invalid JSON response (HTTP ${res.statusCode})`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`RPC: timed out after ${timeoutMs}ms`)));
    req.on('error', reject);
    req.end(body);
  });
}

// Bitcoin Core's JSON-RPC errors come back with HTTP 500 and a JSON body;
// httpPost resolves either way, so the transport rejects only on socket-level
// failures (timeout, reset, SOCKS handshake).
function rpcError(method, e) {
  const err = new Error(`RPC ${method}: ${e.message} (code ${e.code})`);
  err.rpcCode = e.code;
  return err;
}

// opts.timeoutMs / opts.retries override the worker defaults for callers with
// different tolerances: the explorer answers a person holding a spinner, so it
// passes { retries: 0 } and lets its own re-poll act as the retry.
async function call(method, params = [], opts = {}) {
  const timeoutMs = opts.timeoutMs ?? config.rpcTimeoutMs;
  const retries = opts.retries ?? config.rpcMaxRetries;
  const body = JSON.stringify({ jsonrpc: '2.0', id: ++idCounter, method, params });
  for (let attempt = 0; ; attempt++) {
    try {
      const json = await httpPost(config.rpcUrl, body, timeoutMs);
      if (json.error) throw rpcError(method, json.error);
      return json.result;
    } catch (err) {
      if (attempt >= retries) throw err;
      await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}

// One HTTP round trip for many calls (JSON-RPC batch). Results come back in
// the order requested; a node-side error on any item rejects the whole batch,
// which is what page-of-transactions callers want (a partial page is useless).
async function callBatch(calls, opts = {}) {
  if (!calls.length) return [];
  const timeoutMs = opts.timeoutMs ?? config.rpcTimeoutMs;
  const retries = opts.retries ?? config.rpcMaxRetries;
  const base = idCounter;
  idCounter += calls.length;
  const body = JSON.stringify(calls.map(([method, params], i) =>
    ({ jsonrpc: '2.0', id: base + i + 1, method, params })));
  for (let attempt = 0; ; attempt++) {
    try {
      const json = await httpPost(config.rpcUrl, body, timeoutMs);
      if (!Array.isArray(json)) {
        // A malformed batch is rejected as a single error object.
        throw json?.error ? rpcError('batch', json.error) : new Error('RPC batch: non-array response');
      }
      const byId = new Map(json.map(r => [r.id, r]));
      return calls.map(([method], i) => {
        const r = byId.get(base + i + 1);
        if (!r) throw new Error(`RPC batch: missing response for ${method}`);
        if (r.error) throw rpcError(method, r.error);
        return r.result;
      });
    } catch (err) {
      if (attempt >= retries) throw err;
      await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}

export const rpc = {
  getBlockchainInfo: (opts) => call('getblockchaininfo', [], opts),
  getBlockHash: (height, opts) => call('getblockhash', [height], opts),
  getBlockHeader: (hash, opts) => call('getblockheader', [hash], opts),
  // verbosity 1 => header fields + txids only. ~30x smaller than verbosity 3
  // for a full modern block (0.4 MB vs 13 MB measured), so this is what the
  // explorer pulls over Tor; per-page tx detail comes from getRawTransactionsInBlock.
  getBlockV1: (hash, opts) => call('getblock', [hash, 1], opts),
  // verbosity 3 => full tx objects including prevout {value, ...} on every input.
  getBlockV3: (hash, opts) => call('getblock', [hash, 3], opts),
  getBestBlockHash: (opts) => call('getbestblockhash', [], opts),
  // verbosity 2 => decoded tx with prevout info. Without a blockhash this
  // needs txindex=1 (or the tx in the mempool); with one, Core reads the
  // block directly, so it works on any node (Core 25+).
  getRawTransactionVerbose: (txid, blockhash, opts) =>
    call('getrawtransaction', blockhash ? [txid, 2, blockhash] : [txid, 2], opts),
  // A page of transactions from one block in a single round trip.
  getRawTransactionsInBlock: (txids, blockhash, opts) =>
    callBatch(txids.map(t => ['getrawtransaction', [t, 2, blockhash]]), opts),
};

// Map heights -> parsed blocks with limited concurrency.
// onProgress fires after each block lands, so callers (the sync worker's stall
// watchdog) can tell a slow-but-advancing batch from a wedged transport — a
// whole batch over Tor can outlast the stall window while making real headway.
export async function fetchBlocks(heights, onProgress) {
  const results = new Array(heights.length);
  let i = 0;
  async function lane() {
    while (i < heights.length) {
      const idx = i++;
      const hash = await rpc.getBlockHash(heights[idx]);
      results[idx] = await rpc.getBlockV3(hash);
      onProgress?.();
    }
  }
  await Promise.all(Array.from({ length: Math.min(config.rpcConcurrency, heights.length) }, lane));
  return results;
}

export function blockSubsidySat(height) {
  const halvings = Math.floor(height / 210000);
  if (halvings >= 64) return 0;
  return Math.floor(50e8 / 2 ** halvings);
}
