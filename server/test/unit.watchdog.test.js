// The sync loop retries transport errors forever by design, so a dead Tor
// path shows up as a silently frozen worker. The stall watchdog converts that
// state into a process exit (the platform restarts workers, which bootstraps
// a fresh Tor daemon). These tests drive the watchdog with millisecond
// thresholds; production uses SYNC_STALL_EXIT_MS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStallWatchdog } from '../src/sync.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test('fires once idle time exceeds the threshold', async () => {
  let fired = 0;
  const wd = createStallWatchdog({ thresholdMs: 40, checkEveryMs: 10, onStall: () => { fired++; } });
  await sleep(150);
  wd.stop();
  assert.ok(fired >= 1, 'onStall fired for an untouched watchdog');
});

test('regular touches keep it quiet', async () => {
  let fired = 0;
  const wd = createStallWatchdog({ thresholdMs: 80, checkEveryMs: 10, onStall: () => { fired++; } });
  for (let i = 0; i < 8; i++) { await sleep(15); wd.touch(); }
  wd.stop();
  assert.equal(fired, 0);
});

test('threshold 0 disables the watchdog entirely', async () => {
  let fired = 0;
  const wd = createStallWatchdog({ thresholdMs: 0, checkEveryMs: 5, onStall: () => { fired++; } });
  await sleep(50);
  wd.touch(); // inert handles must still be callable
  wd.stop();
  assert.equal(fired, 0);
});

test('stop() ends checking', async () => {
  let fired = 0;
  const wd = createStallWatchdog({ thresholdMs: 20, checkEveryMs: 5, onStall: () => { fired++; } });
  wd.stop();
  await sleep(60);
  assert.equal(fired, 0);
});
