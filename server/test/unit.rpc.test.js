// Exercises the JSON-RPC transport against a real local HTTP server:
// request shape, Basic auth header, result unwrapping, RPC-error propagation.
// RPC_MAX_RETRIES=0 keeps failure paths fast.
process.env.RPC_MAX_RETRIES = '0';
process.env.BITCOIN_RPC_USER = 'ben';
process.env.BITCOIN_RPC_PASSWORD = 'hunter2';

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

let lastReq = null;
let nextResponse = null;

// The mock node must be listening BEFORE config.js is imported (config reads
// BITCOIN_RPC_URL once at module load), so it starts at module top level.
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    lastReq = { headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(nextResponse(lastReq.body)));
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
process.env.BITCOIN_RPC_URL = `http://127.0.0.1:${port}`;

after(() => server.close());

// Import AFTER env is set so config picks it up.
const { rpc, fetchBlocks } = await import('../src/rpc.js');

test('sends well-formed JSON-RPC with Basic auth', async () => {
  nextResponse = (body) => ({ id: body.id, result: { blocks: 900_000 } });
  const info = await rpc.getBlockchainInfo();
  assert.deepEqual(info, { blocks: 900_000 });
  assert.equal(lastReq.body.method, 'getblockchaininfo');
  assert.equal(lastReq.body.jsonrpc, '2.0');
  const expected = 'Basic ' + Buffer.from('ben:hunter2').toString('base64');
  assert.equal(lastReq.headers.authorization, expected);
});

test('passes positional params (getblock verbosity=3)', async () => {
  nextResponse = (body) => ({ id: body.id, result: { hash: body.params[0], height: 1 } });
  const blk = await rpc.getBlockV3('00'.repeat(32));
  assert.equal(blk.hash, '00'.repeat(32));
  assert.deepEqual(lastReq.body.params, ['00'.repeat(32), 3]);
});

test('surfaces node-side RPC errors with method context', async () => {
  nextResponse = (body) => ({ id: body.id, error: { code: -8, message: 'Block height out of range' } });
  await assert.rejects(
    () => rpc.getBlockHash(99_999_999),
    /RPC getblockhash: Block height out of range \(code -8\)/,
  );
});

test('fetchBlocks preserves height order under concurrency', async () => {
  nextResponse = (body) => body.method === 'getblockhash'
    ? ({ id: body.id, result: 'hash-' + body.params[0] })
    : ({ id: body.id, result: { hash: body.params[0], height: Number(body.params[0].split('-')[1]) } });
  const blocks = await fetchBlocks([5, 6, 7, 8, 9, 10]);
  assert.deepEqual(blocks.map(b => b.height), [5, 6, 7, 8, 9, 10]);
});

// The sync worker's stall watchdog feeds on this: without a per-block signal a
// batch that is slow but advancing looks identical to a wedged transport, and
// the watchdog kills the worker mid-progress.
test('fetchBlocks reports progress per block', async () => {
  nextResponse = (body) => body.method === 'getblockhash'
    ? ({ id: body.id, result: 'hash-' + body.params[0] })
    : ({ id: body.id, result: { hash: body.params[0], height: Number(body.params[0].split('-')[1]) } });
  let ticks = 0;
  const blocks = await fetchBlocks([1, 2, 3, 4], () => { ticks++; });
  assert.equal(blocks.length, 4);
  assert.equal(ticks, 4, 'one progress tick per block fetched');
});

test('fetchBlocks works without a progress callback', async () => {
  nextResponse = (body) => body.method === 'getblockhash'
    ? ({ id: body.id, result: 'hash-' + body.params[0] })
    : ({ id: body.id, result: { hash: body.params[0], height: Number(body.params[0].split('-')[1]) } });
  const blocks = await fetchBlocks([1, 2]);
  assert.deepEqual(blocks.map(b => b.height), [1, 2]);
});

test('rejects on malformed (non-JSON) response', async () => {
  const bad = http.createServer((_q, res) => res.end('<html>gateway error</html>'));
  await new Promise(r => bad.listen(0, '127.0.0.1', r));
  const badPort = bad.address().port;
  // Point a one-off request at the bad server through the same transport.
  const savedUrl = process.env.BITCOIN_RPC_URL;
  const { config } = await import('../src/config.js');
  const origUrl = config.rpcUrl;
  config.rpcUrl = `http://127.0.0.1:${badPort}`;
  try {
    await assert.rejects(() => rpc.getBestBlockHash(), /invalid JSON response/);
  } finally {
    config.rpcUrl = origUrl;
    process.env.BITCOIN_RPC_URL = savedUrl;
    bad.close();
  }
});

test('getBlockV1 asks for verbosity 1', async () => {
  nextResponse = (body) => ({ id: body.id, result: { hash: body.params[0], tx: ['aa'] } });
  const blk = await rpc.getBlockV1('11'.repeat(32));
  assert.deepEqual(lastReq.body.params, ['11'.repeat(32), 1]);
  assert.deepEqual(blk.tx, ['aa']);
});

test('getRawTransactionVerbose scopes to a blockhash when given one', async () => {
  nextResponse = (body) => ({ id: body.id, result: { txid: body.params[0] } });
  await rpc.getRawTransactionVerbose('ab'.repeat(32));
  assert.deepEqual(lastReq.body.params, ['ab'.repeat(32), 2]);
  await rpc.getRawTransactionVerbose('ab'.repeat(32), 'cd'.repeat(32));
  assert.deepEqual(lastReq.body.params, ['ab'.repeat(32), 2, 'cd'.repeat(32)]);
});

// A page of transactions is one HTTP round trip (JSON-RPC batch): over Tor the
// round trip, not the bytes, is what a 25-call page would otherwise pay for.
test('getRawTransactionsInBlock batches into one request and keeps order', async () => {
  nextResponse = (batch) => batch.slice().reverse().map(b => ({ id: b.id, result: { txid: b.params[0], bh: b.params[2] } }));
  const ids = ['01'.repeat(32), '02'.repeat(32), '03'.repeat(32)];
  const txs = await rpc.getRawTransactionsInBlock(ids, 'ff'.repeat(32));
  assert.ok(Array.isArray(lastReq.body), 'array body');
  assert.equal(lastReq.body.length, 3);
  assert.ok(lastReq.body.every(b => b.method === 'getrawtransaction' && b.params[1] === 2));
  assert.deepEqual(txs.map(t => t.txid), ids, 'results re-ordered to match the request');
  assert.ok(txs.every(t => t.bh === 'ff'.repeat(32)));
  assert.deepEqual(await rpc.getRawTransactionsInBlock([], 'ff'.repeat(32)), [], 'empty page makes no request');
});

test('a node-side error inside a batch rejects the batch with method context', async () => {
  nextResponse = (batch) => batch.map((b, i) => i === 1
    ? { id: b.id, error: { code: -5, message: 'No such transaction found in the provided block.' } }
    : { id: b.id, result: { txid: b.params[0] } });
  await assert.rejects(
    () => rpc.getRawTransactionsInBlock(['01'.repeat(32), '02'.repeat(32)], 'ff'.repeat(32)),
    /RPC getrawtransaction: No such transaction found in the provided block\. \(code -5\)/,
  );
});

test('per-call retries option overrides the configured default', async () => {
  let n = 0;
  nextResponse = (body) => (++n === 1
    ? { id: body.id, error: { code: -28, message: 'Loading block index...' } }
    : { id: body.id, result: 'ok' });
  // Configured RPC_MAX_RETRIES=0: fails on the first error…
  await assert.rejects(() => rpc.getBestBlockHash(), /Loading block index/);
  // …but a caller may ask for one retry (1 s backoff).
  n = 0;
  assert.equal(await rpc.getBestBlockHash({ retries: 1 }), 'ok');
  assert.equal(n, 2);
});
