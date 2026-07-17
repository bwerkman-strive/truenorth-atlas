// The RPC timeout must bound the SOCKS handshake itself: a wedged Tor daemon
// can accept the TCP connection and then never answer the SOCKS greeting,
// which the http-level timeout does not cover (it only arms once the proxy
// hands over a socket). Without the agent-level timeout this call hangs
// forever; with it, the promise must reject promptly.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

// A proxy that accepts connections and then ignores the client entirely.
const blackhole = net.createServer(() => { /* never reads, never replies */ });
await new Promise(r => blackhole.listen(0, '127.0.0.1', r));

// config captures env at import time: set everything before importing rpc.js.
process.env.TOR_SOCKS_PROXY = `socks5h://127.0.0.1:${blackhole.address().port}`;
process.env.BITCOIN_RPC_URL = 'http://exampleexampleexample.onion:8332';
process.env.BITCOIN_RPC_TIMEOUT_MS = '300';
process.env.RPC_MAX_RETRIES = '0';
const { rpc } = await import('../src/rpc.js');

test('a SOCKS handshake that never completes rejects within the RPC timeout', async () => {
  const t0 = Date.now();
  await assert.rejects(rpc.getBestBlockHash());
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 5000, `rejected in ${elapsed}ms, not hung`);
});

after(() => blackhole.close());
