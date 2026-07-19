// Phase instrumentation. A stalled sync loop used to be a black box: the
// watchdog reported only how long it had been idle, never what it was doing.
// phase() maintains a stack of in-flight stages so the fatal log can name the
// culprit. These tests pin the naming, nesting, and the guarantee that the
// stack unwinds on the failure path (a leaked frame would mislabel every
// later stall).
process.env.SYNC_SLOW_PHASE_MS = '1000000'; // keep these tests off the info path

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { phase, inFlightPhase, inFlightPhaseMs } from '../src/sync.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test('no phase is in flight when idle', () => {
  assert.equal(inFlightPhase(), null);
  assert.equal(inFlightPhaseMs(), null);
});

test('names the stage while it runs and clears it after', async () => {
  let seen = null;
  const out = await phase('fetchBlocks', { from: 1, to: 25 }, async () => {
    seen = inFlightPhase();
    return 'result';
  });
  assert.equal(out, 'result');
  assert.equal(seen, 'fetchBlocks');
  assert.equal(inFlightPhase(), null);
});

test('nested stages read as a path, innermost last', async () => {
  let seen = null;
  await phase('batch', {}, () => phase('snapshotDay', { day: '2013-04-01' }, async () => {
    seen = inFlightPhase();
  }));
  assert.equal(seen, 'batch > snapshotDay');
  assert.equal(inFlightPhase(), null);
});

test('reports elapsed time for the innermost stage', async () => {
  let ms = null;
  await phase('outer', {}, () => phase('inner', {}, async () => {
    await sleep(30);
    ms = inFlightPhaseMs();
  }));
  assert.ok(ms >= 25, `inner elapsed ${ms}ms should reflect the sleep`);
});

test('rethrows and still unwinds the stack', async () => {
  await assert.rejects(
    () => phase('processBlocks', { from: 1, to: 2 }, async () => { throw new Error('deadlock'); }),
    /deadlock/,
  );
  // A leaked frame here would make the next stall blame the wrong stage.
  assert.equal(inFlightPhase(), null);
});

test('a failing inner stage unwinds only itself', async () => {
  let afterInner = null;
  await phase('batch', {}, async () => {
    await assert.rejects(() => phase('inner', {}, async () => { throw new Error('boom'); }));
    afterInner = inFlightPhase();
  });
  assert.equal(afterInner, 'batch');
  assert.equal(inFlightPhase(), null);
});
