// Integration tests TRUNCATE the tables they use. Pointed at the wrong
// DATABASE_URL, that is a full data-loss event (the July 2026 replay took
// days to rebuild) — so every truncating test file calls this first and
// refuses to run unless the database self-identifies as scratch.
//
// Self-contained on purpose: no import of src/db.js or src/config.js, so it
// can never disturb the "set env BEFORE importing modules" pattern the
// integration tests rely on.
import pg from 'pg';

export async function assertScratchDb() {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const r = await client.query('SELECT current_database() AS db');
    const db = r.rows[0].db;
    if (!/test|scratch/i.test(db) && process.env.ALLOW_DESTRUCTIVE_TESTS !== '1') {
      throw new Error(
        `integration tests TRUNCATE tables; refusing to run against database "${db}". ` +
        `Point DATABASE_URL at a scratch database (name containing "test"), ` +
        `or set ALLOW_DESTRUCTIVE_TESTS=1 if you truly mean it.`);
    }
  } finally {
    await client.end();
  }
}
