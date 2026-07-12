// Explorer + private-API integration suite (own process, own mock node).
//
// Seeds a two-block chain with addressed outputs through the real sync path,
// then verifies:
//   - address balances/UTXOs straight from the UTXO set
//   - block lookup by height and hash (DB-only and RPC-enriched)
//   - tx lookup WITHOUT txindex (blockhash learned from our UTXO table)
//   - search dispatch (height / hash / txid / address / garbage)
//   - the full API-key lifecycle: admin auth, create, use, list, revoke, reject
//   - public rate limiting kicks in at the configured threshold
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.PGSSLMODE = 'disable';
process.env.RPC_MAX_RETRIES = '0';
process.env.ADMIN_TOKEN = 'test-admin-secret';
process.env.PUBLIC_RATE_LIMIT_PER_MIN = '50';

// ---- mock Bitcoin node ------------------------------------------------------
// Serves the same two blocks the test pushes into the DB. getrawtransaction
// always errors (simulating no txindex) to prove the blockhash fallback path.
const T0 = Date.parse('2024-06-01T06:00:00Z') / 1000;
const ADDR1 = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'; // receives 2 coinbases
const ADDR2 = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2';          // receives the spend
const TX_CB1 = '11'.repeat(32), TX_CB2 = '22'.repeat(32), TX_SPEND = 'dd'.repeat(32);
const HASH1 = 'e1'.repeat(32), HASH2 = 'e2'.repeat(32);

const BLOCKS = {
  [HASH1]: {
    hash: HASH1, height: 1, time: T0, size: 285, weight: 1140, version: 1,
    merkleroot: 'ab'.repeat(32), nonce: 1, bits: '1d00ffff', difficulty: 1,
    previousblockhash: '00'.repeat(32),
    tx: [{
      txid: TX_CB1, vin: [{ coinbase: '01' }],
      vout: [{ n: 0, value: 50, scriptPubKey: { type: 'v0_p2wpkh', address: ADDR1 } }],
    }],
  },
  [HASH2]: {
    hash: HASH2, height: 2, time: T0 + 600, size: 500, weight: 2000, version: 1,
    merkleroot: 'cd'.repeat(32), nonce: 2, bits: '1d00ffff', difficulty: 1,
    previousblockhash: HASH1,
    tx: [
      {
        txid: TX_CB2, vin: [{ coinbase: '01' }],
        vout: [{ n: 0, value: 50.0001, scriptPubKey: { type: 'v0_p2wpkh', address: ADDR1 } }],
      },
      {
        txid: TX_SPEND,
        vin: [{ txid: TX_CB1, vout: 0, prevout: { value: 50, height: 1, scriptPubKey: { address: ADDR1 } } }],
        vout: [
          { n: 0, value: 20, scriptPubKey: { type: 'pubkeyhash', address: ADDR2 } },
          { n: 1, value: 29.9999, scriptPubKey: { type: 'v0_p2wpkh', address: ADDR1 } },
        ],
      },
    ],
  },
};

const mock = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString());
    res.setHeader('content-type', 'application/json');
    const reply = (result) => res.end(JSON.stringify({ id: body.id, result }));
    const fail = (code, message) => res.end(JSON.stringify({ id: body.id, error: { code, message } }));
    switch (body.method) {
      case 'getbestblockhash': return reply(HASH2);
      case 'getblockhash': {
        const h = body.params[0];
        return h === 1 ? reply(HASH1) : h === 2 ? reply(HASH2) : fail(-8, 'Block height out of range');
      }
      case 'getblock': {
        const b = BLOCKS[body.params[0]];
        return b ? reply(b) : fail(-5, 'Block not found');
      }
      case 'getrawtransaction': return fail(-5, 'No such mempool or blockchain transaction (txindex off)');
      default: return fail(-32601, 'not mocked');
    }
  });
});
await new Promise(r => mock.listen(0, '127.0.0.1', r));
process.env.BITCOIN_RPC_URL = `http://127.0.0.1:${mock.address().port}`;
process.env.BITCOIN_RPC_USER = 'x'; // marks RPC as "configured" for the probe

const { pool, migrate } = await import('../src/db.js');
const { processBlocks, heightMeta } = await import('../src/sync.js');
const { bustPriceCache } = await import('../src/prices.js');
const { classify } = await import('../src/explorer.js');
const { app } = await import('../src/api.js');

let srv, base;
const get = (p, headers = {}) => fetch(base + p, { headers });
const getJson = async (p, headers = {}) => {
  const r = await get(p, headers);
  return { status: r.status, body: await r.json() };
};

before(async () => {
  await migrate();
  await pool.query('TRUNCATE blocks, block_agg, utxos, prices, metrics_daily, chain_state, api_keys, admins');
  await pool.query(`INSERT INTO prices (day, close_usd) VALUES ('2024-06-01', 100)`);
  bustPriceCache();
  heightMeta.length = 0;
  await processBlocks([BLOCKS[HASH1], BLOCKS[HASH2]]);
  srv = app.listen(0);
  base = `http://127.0.0.1:${srv.address().port}`;
});

after(async () => { srv.close(); mock.close(); await pool.end(); });

// ---------------------------------------------------------------------------
test('classify: heights, hashes, addresses, garbage', () => {
  assert.equal(classify('840000').type, 'block');
  assert.equal(classify(HASH1).type, 'hash64');
  assert.equal(classify(ADDR1).type, 'address');
  assert.equal(classify(ADDR2).type, 'address');
  assert.equal(classify('bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297').type, 'address'); // taproot
  assert.equal(classify('hello world').type, 'unknown');
});

test('address balance and UTXOs come straight from the UTXO set', async () => {
  // ADDR1: +50 (spent), +50.0001, +29.9999 change => live balance 80.0000
  const { status, body } = await getJson(`/api/explorer/address/${ADDR1}`);
  assert.equal(status, 200);
  assert.equal(body.balance_btc, 80.0000);
  assert.equal(body.utxo_count, 2);
  assert.equal(body.balance_usd, 80.0000 * 100, 'valued at latest close');
  const txids = body.utxos.map(u => u.txid).sort();
  assert.deepEqual(txids, [TX_CB2, TX_SPEND].sort());

  const a2 = (await getJson(`/api/explorer/address/${ADDR2}`)).body;
  assert.equal(a2.balance_btc, 20);
  assert.equal(a2.utxo_count, 1);
});

test('unknown-but-valid address returns a clean zero, not a 404', async () => {
  const { status, body } = await getJson('/api/explorer/address/1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');
  assert.equal(status, 200);
  assert.equal(body.balance_sat, 0);
  assert.deepEqual(body.utxos, []);
});

test('block lookup by height and by hash, RPC-enriched with full txids', async () => {
  const byH = (await getJson('/api/explorer/block/2')).body;
  assert.equal(byH.hash, HASH2);
  assert.equal(byH.tx_count, 2);
  assert.equal(byH.fees_sat, 10000, '0.0001 BTC fee recorded by sync');
  assert.equal(byH.rpc, true);
  assert.deepEqual(byH.detail.txids, [TX_CB2, TX_SPEND]);

  const byHash = (await getJson(`/api/explorer/block/${HASH1}`)).body;
  assert.equal(byHash.height, 1);

  assert.equal((await get('/api/explorer/block/999999')).status, 404);
  assert.equal((await get('/api/explorer/block/not-a-block')).status, 400);
});

test('tx lookup succeeds WITHOUT txindex via the UTXO-table blockhash fallback', async () => {
  const { status, body } = await getJson(`/api/explorer/tx/${TX_SPEND}`);
  assert.equal(status, 200);
  assert.equal(body.rpc, true, 'resolved through getblock fallback');
  assert.equal(body.block_height, 2);
  assert.equal(body.block_hash, HASH2);
  assert.equal(body.coinbase, false);
  assert.equal(body.inputs[0].address, ADDR1);
  assert.equal(body.inputs[0].value_btc, 50);
  assert.equal(body.outputs.length, 2);
  assert.equal(body.outputs[0].address, ADDR2);
  assert.equal(body.outputs[0].spent, false, 'spentness merged from our UTXO set');

  assert.equal((await get(`/api/explorer/tx/${'ab'.repeat(32)}`)).status, 404);
  assert.equal((await get('/api/explorer/tx/xyz')).status, 400);
});

test('search dispatches height, hash, txid, address, and garbage correctly', async () => {
  assert.equal((await getJson('/api/explorer/search?q=1')).body.found, 'block');
  assert.equal((await getJson(`/api/explorer/search?q=${HASH2}`)).body.found, 'block');
  const t = (await getJson(`/api/explorer/search?q=${TX_SPEND}`)).body;
  assert.equal(t.found, 'tx');
  assert.equal(t.tx.txid, TX_SPEND);
  assert.equal((await getJson(`/api/explorer/search?q=${ADDR1}`)).body.found, 'address');
  const g = (await getJson('/api/explorer/search?q=what%20is%20bitcoin')).body;
  assert.equal(g.found, null);
  assert.ok(g.hint);
});

test('recent blocks feed', async () => {
  const { body } = await getJson('/api/explorer/blocks/recent');
  assert.deepEqual(body.blocks.map(b => b.height), [2, 1]);
});

// ---------------------------------------------------------------------------
let liveKey;

test('admin: create key requires the admin token; plaintext returned once', async () => {
  const noAuth = await fetch(base + '/api/admin/keys', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'sata-app' }),
  });
  assert.equal(noAuth.status, 401);

  const r = await fetch(base + '/api/admin/keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-admin-secret' },
    body: JSON.stringify({ name: 'sata-app' }),
  });
  assert.equal(r.status, 201);
  const body = await r.json();
  assert.match(body.key, /^tn_live_[A-Za-z0-9_-]{43}$/);
  liveKey = body.key;

  // Only the hash is stored.
  const db = await pool.query('SELECT key_hash FROM api_keys WHERE id=$1', [body.id]);
  assert.notEqual(db.rows[0].key_hash.toString('hex'), liveKey);
});

test('/v1 requires an active key; identical payloads to the public surface', async () => {
  assert.equal((await get('/v1/block/1')).status, 401, 'no key');
  assert.equal((await get('/v1/block/1', { 'x-api-key': 'tn_live_' + 'A'.repeat(43) })).status, 401, 'unknown key');

  const keyed = (await getJson('/v1/block/1', { 'x-api-key': liveKey }));
  assert.equal(keyed.status, 200);
  const pub = (await getJson('/api/explorer/block/1'));
  assert.deepEqual(keyed.body, pub.body, 'same explorer, two doors');

  const addr = (await getJson(`/v1/address/${ADDR1}`, { 'x-api-key': liveKey })).body;
  assert.equal(addr.balance_btc, 80);
});

test('admin: list shows usage, revoke kills the key immediately', async () => {
  const list = await (await fetch(base + '/api/admin/keys',
    { headers: { authorization: 'Bearer test-admin-secret' } })).json();
  assert.equal(list.keys.length, 1);
  assert.equal(list.keys[0].name, 'sata-app');
  const id = list.keys[0].id;

  const rev = await fetch(base + `/api/admin/keys/${id}`, {
    method: 'DELETE', headers: { authorization: 'Bearer test-admin-secret' } });
  assert.equal(rev.status, 200);

  assert.equal((await get('/v1/block/1', { 'x-api-key': liveKey })).status, 401, 'revoked key rejected');

  const again = await fetch(base + `/api/admin/keys/${id}`, {
    method: 'DELETE', headers: { authorization: 'Bearer test-admin-secret' } });
  assert.equal(again.status, 404, 'double-revoke is a 404');
});

test('bad admin token is rejected in constant-time comparison path', async () => {
  const r = await fetch(base + '/api/admin/keys',
    { headers: { authorization: 'Bearer wrong-secret' } });
  assert.equal(r.status, 401);
});

test('public surface rate-limits per IP; keyed surface is unmetered', async () => {
  // Use a dedicated client IP (limiter keys on x-forwarded-for) so this test
  // can't interfere with — or be interfered with by — the rest of the suite.
  let limited = false;
  for (let i = 0; i < 55; i++) {
    const r = await get('/api/explorer/blocks/recent', { 'x-forwarded-for': '203.0.113.9' });
    if (r.status === 429) { limited = true; break; }
  }
  assert.ok(limited, 'public requests eventually 429');

  // A fresh key sails through.
  const mk = await (await fetch(base + '/api/admin/keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-admin-secret' },
    body: JSON.stringify({ name: 'burst-app' }),
  })).json();
  for (let i = 0; i < 25; i++) {
    const r = await get('/v1/blocks/recent', { 'x-api-key': mk.key });
    assert.equal(r.status, 200);
  }
});

// ---------------------------------------------------------------------------
// Documentation contract: the admin panel's API Reference ships example
// responses (web/src/apiReference.js). This test compares the documented key
// sets against LIVE responses from the seeded chain, so the docs can never
// silently drift from the actual serializers.
test('admin-panel API reference examples match live response shapes', async () => {
  const { API_ENDPOINTS } = await import('../../web/src/apiReference.js');
  const doc = Object.fromEntries(API_ENDPOINTS.map(e => [e.path.split('/')[2].split('?')[0], e]));

  const keysOf = (o) => Object.keys(o).sort();

  // block — top-level and RPC detail keys
  const liveBlock = (await getJson('/api/explorer/block/2')).body;
  assert.deepEqual(keysOf(doc.block.response), keysOf(liveBlock), 'block: top-level keys');
  assert.deepEqual(keysOf(doc.block.response.detail), keysOf(liveBlock.detail), 'block: detail keys');

  // tx — top-level, input, and output keys
  const liveTx = (await getJson(`/api/explorer/tx/${TX_SPEND}`)).body;
  assert.deepEqual(keysOf(doc.tx.response), keysOf(liveTx), 'tx: top-level keys');
  assert.deepEqual(keysOf(doc.tx.response.inputs[0]), keysOf(liveTx.inputs[0]), 'tx: input keys');
  assert.deepEqual(keysOf(doc.tx.response.outputs[0]), keysOf(liveTx.outputs[0]), 'tx: output keys');

  // address — top-level and utxo entry keys
  const liveAddr = (await getJson(`/api/explorer/address/${ADDR1}`)).body;
  assert.deepEqual(keysOf(doc.address.response), keysOf(liveAddr), 'address: top-level keys');
  assert.deepEqual(keysOf(doc.address.response.utxos[0]), keysOf(liveAddr.utxos[0]), 'address: utxo keys');

  // blocks/recent — feed entry keys
  const liveRecent = (await getJson('/api/explorer/blocks/recent',
    { 'x-forwarded-for': '203.0.113.77' })).body; // fresh IP: rate-limit test may have burned the default one
  assert.deepEqual(keysOf(doc.blocks.response.blocks[0]), keysOf(liveRecent.blocks[0]), 'recent: entry keys');

  // search — documented dispatch key present in live response
  const liveSearch = (await getJson('/api/explorer/search?q=2',
    { 'x-forwarded-for': '203.0.113.77' })).body;
  assert.equal(liveSearch.found, 'block');
  assert.ok(doc.search.response.found, 'search example documents the "found" discriminator');
});

// ---------------------------------------------------------------------------
// Two-tier admin model: root (ADMIN_TOKEN env) vs named admin tokens.
let adminToken;

test('root bootstraps a named admin; token returned once, hash stored', async () => {
  const who = await (await fetch(base + '/api/admin/whoami',
    { headers: { authorization: 'Bearer test-admin-secret' } })).json();
  assert.deepEqual(who, { name: 'root', root: true });

  const r = await fetch(base + '/api/admin/admins', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-admin-secret' },
    body: JSON.stringify({ name: 'jane-ops' }),
  });
  assert.equal(r.status, 201);
  const body = await r.json();
  assert.match(body.token, /^tn_admin_[A-Za-z0-9_-]{43}$/);
  adminToken = body.token;

  const db = await pool.query('SELECT token_hash, created_by FROM admins WHERE id=$1', [body.id]);
  assert.notEqual(db.rows[0].token_hash.toString('utf8'), adminToken, 'plaintext never stored');
  assert.equal(db.rows[0].created_by, 'root');
});

test('admin token manages API keys; key records who created it', async () => {
  const who = await (await fetch(base + '/api/admin/whoami',
    { headers: { authorization: `Bearer ${adminToken}` } })).json();
  assert.deepEqual(who, { name: 'jane-ops', root: false });

  const r = await fetch(base + '/api/admin/keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ name: 'janes-integration' }),
  });
  assert.equal(r.status, 201);
  const key = await r.json();
  assert.equal(key.created_by, 'jane-ops');

  const list = await (await fetch(base + '/api/admin/keys',
    { headers: { authorization: `Bearer ${adminToken}` } })).json();
  const mine = list.keys.find(k => k.name === 'janes-integration');
  assert.equal(mine.created_by, 'jane-ops', 'attribution survives to the list');

  // ...and the key actually works on /v1.
  const use = await get('/v1/block/1', { 'x-api-key': key.key });
  assert.equal(use.status, 200);
});

test('privilege separation: admin tokens cannot manage admins', async () => {
  for (const [method, path] of [
    ['POST', '/api/admin/admins'],
    ['GET', '/api/admin/admins'],
    ['DELETE', '/api/admin/admins/1'],
  ]) {
    const r = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: method === 'POST' ? JSON.stringify({ name: 'sneaky' }) : undefined,
    });
    assert.equal(r.status, 403, `${method} ${path} must be root-only`);
  }
});

test('root revokes an admin; their token dies, keys they created live on', async () => {
  const admins = await (await fetch(base + '/api/admin/admins',
    { headers: { authorization: 'Bearer test-admin-secret' } })).json();
  const jane = admins.admins.find(a => a.name === 'jane-ops' && !a.revoked_at);
  assert.ok(jane.last_used_at, 'usage tracked');

  const rev = await fetch(base + `/api/admin/admins/${jane.id}`, {
    method: 'DELETE', headers: { authorization: 'Bearer test-admin-secret' } });
  assert.equal(rev.status, 200);

  // Revoked admin token: rejected everywhere on the admin surface.
  assert.equal((await fetch(base + '/api/admin/whoami',
    { headers: { authorization: `Bearer ${adminToken}` } })).status, 401);
  assert.equal((await fetch(base + '/api/admin/keys',
    { headers: { authorization: `Bearer ${adminToken}` } })).status, 401);

  // But the API key she minted keeps serving her application.
  const list = await (await fetch(base + '/api/admin/keys',
    { headers: { authorization: 'Bearer test-admin-secret' } })).json();
  const hers = list.keys.find(k => k.name === 'janes-integration');
  assert.equal(hers.revoked_at, null, 'API keys outlive their creator by design');
});

test('random tn_admin_-shaped token is rejected', async () => {
  const fake = 'tn_admin_' + 'B'.repeat(43);
  assert.equal((await fetch(base + '/api/admin/whoami',
    { headers: { authorization: `Bearer ${fake}` } })).status, 401);
});
