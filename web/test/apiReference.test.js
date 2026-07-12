// The admin panel's API Reference is data-driven (src/apiReference.js). The
// server-side contract test proves the example SHAPES match live responses;
// this suite proves the document itself is complete and internally coherent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { API_AUTH_DOC, API_ENDPOINTS } from '../src/apiReference.js';

test('every documented endpoint is complete', () => {
  assert.ok(API_ENDPOINTS.length >= 5, 'all five explorer endpoints documented');
  for (const ep of API_ENDPOINTS) {
    assert.equal(ep.method, 'GET', `${ep.path}: explorer surface is read-only`);
    assert.match(ep.path, /^\/v1\//, `${ep.path}: documents the private surface`);
    assert.ok(ep.title?.length > 3, `${ep.path}: has a title`);
    assert.ok(ep.desc?.length > 40, `${ep.path}: has a real description`);
    assert.ok(ep.example?.startsWith('/v1/'), `${ep.path}: has a concrete example request`);
    assert.ok(ep.response && typeof ep.response === 'object', `${ep.path}: has an example response`);
  }
});

test('example responses are serializable JSON (what the panel renders)', () => {
  for (const ep of API_ENDPOINTS) {
    const text = JSON.stringify(ep.response, null, 2);
    assert.ok(text.length > 50, `${ep.path}: non-trivial example`);
    assert.deepEqual(JSON.parse(text), ep.response, `${ep.path}: round-trips`);
  }
});

test('the five endpoint families are all present', () => {
  const families = API_ENDPOINTS.map(e => e.path.split('/')[2].split('?')[0]).sort();
  assert.deepEqual(families, ['address', 'block', 'blocks', 'search', 'tx']);
});

test('auth doc: header, key format, curl example, and error catalog', () => {
  assert.equal(API_AUTH_DOC.header, 'X-API-Key');
  assert.match(API_AUTH_DOC.keyFormat, /^tn_live_/);
  assert.ok(API_AUTH_DOC.curl.includes('X-API-Key'), 'curl example shows the auth header');
  assert.ok(API_AUTH_DOC.curl.includes('/v1/'), 'curl example targets the private surface');
  assert.equal(API_AUTH_DOC.errors.length, 3, 'all three 401 variants documented');
  for (const e of API_AUTH_DOC.errors) {
    assert.equal(e.status, 401);
    assert.ok(e.body.error);
  }
});

test('example values are realistic (heights, hashes, addresses parse)', () => {
  for (const ep of API_ENDPOINTS) {
    const flat = JSON.stringify(ep.response);
    // No obvious template junk left in shipped docs.
    assert.ok(!flat.includes('TODO') && !flat.includes('lorem'), `${ep.path}: no placeholder text`);
  }
  const block = API_ENDPOINTS.find(e => e.path.includes('/block/'));
  assert.match(block.response.hash, /^[0-9a-f]{64}$/, 'block hash is 64 hex');
  const addr = API_ENDPOINTS.find(e => e.path.includes('/address/'));
  assert.match(addr.response.address, /^bc1q/, 'address example is a real bech32 shape');
  assert.equal(addr.response.balance_sat / 1e8, addr.response.balance_btc, 'sat and BTC figures agree');
});
