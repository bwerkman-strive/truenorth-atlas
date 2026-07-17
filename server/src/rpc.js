// Minimal, resilient Bitcoin Core JSON-RPC client.
// Requirements on the node: server=1, rpcauth/rpcuser+rpcpassword, and
// txindex is NOT required — we use getblock verbosity=3 (prevout data inline),
// available since Bitcoin Core 25.0 (verified against Core 29.x).
//
// Transport: plain HTTP(S) via node:http(s), with optional SOCKS5 proxying so
// the worker can reach a Tor hidden service (Start9 / Umbrel nodes expose RPC
// as a .onion by default). Set TOR_SOCKS_PROXY=socks5h://127.0.0.1:9050.
import http from 'node:http';
import https from 'node:https';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { config } from './config.js';

let idCounter = 0;
let cachedAgent = null;

function agentFor(url) {
  if (config.torSocksProxy) {
    // timeout also bounds the SOCKS handshake itself; without it a wedged Tor
    // daemon that accepts the connection but never completes CONNECT would
    // hang the request forever (the http-level timeout only arms after the
    // proxy hands over a socket).
    if (!cachedAgent) cachedAgent = new SocksProxyAgent(config.torSocksProxy, { keepAlive: true, timeout: config.rpcTimeoutMs });
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

async function call(method, params = [], attempt = 0) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: ++idCounter, method, params });
  try {
    const json = await httpPost(config.rpcUrl, body, config.rpcTimeoutMs);
    if (json.error) throw new Error(`RPC ${method}: ${json.error.message} (code ${json.error.code})`);
    return json.result;
  } catch (err) {
    if (attempt < config.rpcMaxRetries) {
      const backoff = 1000 * 2 ** attempt;
      await new Promise(r => setTimeout(r, backoff));
      return call(method, params, attempt + 1);
    }
    throw err;
  }
}

export const rpc = {
  getBlockchainInfo: () => call('getblockchaininfo'),
  getBlockHash: (height) => call('getblockhash', [height]),
  getBlockHeader: (hash) => call('getblockheader', [hash]),
  // verbosity 3 => full tx objects including prevout {value, ...} on every input.
  getBlockV3: (hash) => call('getblock', [hash, 3]),
  getBestBlockHash: () => call('getbestblockhash'),
  // verbosity 2 => decoded tx with prevout info (needs txindex=1 unless the
  // caller supplies a blockhash; explorer.js handles the no-txindex fallback).
  getRawTransactionVerbose: (txid) => call('getrawtransaction', [txid, 2]),
};

// Map heights -> parsed blocks with limited concurrency.
export async function fetchBlocks(heights) {
  const results = new Array(heights.length);
  let i = 0;
  async function lane() {
    while (i < heights.length) {
      const idx = i++;
      const hash = await rpc.getBlockHash(heights[idx]);
      results[idx] = await rpc.getBlockV3(hash);
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
