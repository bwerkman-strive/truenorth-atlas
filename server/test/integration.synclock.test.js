// The sync worker's single-writer advisory lock, against a real Postgres.
//
// Deploys overlap: the outgoing worker keeps running while the new one boots,
// and two workers racing the same database can pollute day-boundary snapshots
// and misprice spends (stale in-memory block index). These tests pin the lock
// semantics that make that impossible: exclusivity across sessions, and the
// blocked acquirer proceeding the moment the holder lets go.
//
// Set DATABASE_URL before running (the npm script handles the local case).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PGSSLMODE = 'disable';

const { pool } = await import('../src/db.js');
const { acquireSyncLock, releaseSyncLock, SYNC_LOCK_KEY } = await import('../src/sync.js');

after(async () => {
  await releaseSyncLock();
  await pool.end();
});

test('a second worker cannot acquire the write lock while one holds it', async () => {
  await acquireSyncLock();
  const rival = await pool.connect();
  try {
    const r = await rival.query('SELECT pg_try_advisory_lock($1) AS ok', [SYNC_LOCK_KEY]);
    assert.equal(r.rows[0].ok, false);
  } finally { rival.release(); }
  await releaseSyncLock();
});

test('release frees the lock for the next worker', async () => {
  await acquireSyncLock();
  await releaseSyncLock();
  const next = await pool.connect();
  try {
    const r = await next.query('SELECT pg_try_advisory_lock($1) AS ok', [SYNC_LOCK_KEY]);
    assert.equal(r.rows[0].ok, true);
    await next.query('SELECT pg_advisory_unlock($1)', [SYNC_LOCK_KEY]);
  } finally { next.release(); }
});

test('a booting worker blocks behind the holder, then proceeds when it exits', async () => {
  // "Old instance": a plain session holding the lock, like a still-running deploy.
  const holder = await pool.connect();
  await holder.query('SELECT pg_advisory_lock($1)', [SYNC_LOCK_KEY]);

  let acquired = false;
  const boot = acquireSyncLock().then(() => { acquired = true; });

  await new Promise(r => setTimeout(r, 300));
  assert.equal(acquired, false, 'new worker must wait while the old one runs');

  await holder.query('SELECT pg_advisory_unlock($1)', [SYNC_LOCK_KEY]);
  holder.release();
  await boot;
  assert.equal(acquired, true, 'new worker proceeds once the old one releases');
  await releaseSyncLock();
});
