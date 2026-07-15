// Wipe all chain-derived data so the sync worker replays from genesis.
//
// Clears: blocks, block_agg, utxos, metrics_daily, chain_state (re-seeded).
// Keeps:  prices (provider daily closes), api_keys, admins, alerts,
//         newsletter subscribers/issues, email_log.
//
// Refuses to run while a sync worker holds the single-writer lock, so it can
// never race a live replay: suspend the worker first, run this, resume.
//
//   DATABASE_URL=... node scripts/reset-chain-data.js --yes-wipe-chain-data
import { pool, migrate } from '../src/db.js';
import { SYNC_LOCK_KEY } from '../src/sync.js';

if (!process.argv.includes('--yes-wipe-chain-data')) {
  console.error('This permanently deletes all synced chain data (blocks, UTXO set,');
  console.error('daily metrics, running counters) so the worker replays from genesis.');
  console.error('Prices, API keys, alerts, subscribers, and the email log are kept.');
  console.error('');
  console.error('Refusing to run without the explicit flag: --yes-wipe-chain-data');
  process.exit(2);
}

const client = await pool.connect();
try {
  const lock = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [SYNC_LOCK_KEY]);
  if (!lock.rows[0].ok) {
    console.error('A sync worker is running (write lock held). Suspend it first, then re-run.');
    process.exit(1);
  }

  const counts = async () => {
    const r = await client.query(`SELECT
      (SELECT COUNT(*) FROM blocks)::int AS blocks,
      (SELECT COUNT(*) FROM utxos)::int AS utxos,
      (SELECT COUNT(*) FROM metrics_daily)::int AS days`);
    return r.rows[0];
  };
  console.log('before:', await counts());

  const alerts = await client.query(
    `SELECT COUNT(*)::int AS c FROM alerts WHERE confirmed_at IS NOT NULL AND unsubscribed_at IS NULL`);
  if (alerts.rows[0].c > 0) {
    console.warn(`note: ${alerts.rows[0].c} confirmed alert(s) exist — replayed history may`
      + ' trigger crossing emails; consider pausing the alert checker during the replay.');
  }

  await client.query('BEGIN');
  await client.query('TRUNCATE blocks, block_agg, utxos, metrics_daily');
  await client.query('DELETE FROM chain_state');
  await client.query('COMMIT');
  await migrate(); // re-seeds the chain_state counters

  console.log('after:', await counts());
  console.log('chain data wiped; resume the sync worker to replay from genesis.');
  await client.query('SELECT pg_advisory_unlock($1)', [SYNC_LOCK_KEY]);
} catch (e) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('reset failed:', e.message);
  process.exit(1);
} finally {
  client.release();
  await pool.end();
}
