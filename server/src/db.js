import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: config.pgSsl ? { rejectUnauthorized: false } : false,
  max: 10,
});

export async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
}

export async function getState(client, key) {
  const r = await client.query('SELECT value FROM chain_state WHERE key=$1', [key]);
  return r.rows.length ? Number(r.rows[0].value) : 0;
}
export async function setState(client, key, value) {
  await client.query(
    `INSERT INTO chain_state(key,value) VALUES($1,$2)
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [key, value]);
}
