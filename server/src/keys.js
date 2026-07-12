// Admin & private-API key management.
//
// Trust model (two tiers):
//   ROOT   — the ADMIN_TOKEN environment variable. Established by whoever
//            controls the deployment (the correct root of trust: it cannot be
//            bootstrapped from inside the app). Root can do everything,
//            including creating and revoking named admins. Treat it like a
//            master key: use it to mint your personal admin token, then put
//            it away.
//   ADMIN  — named, per-person tokens (`tn_admin_…`), minted by root, stored
//            hashed, individually revocable. Admins manage API keys; they
//            cannot create or revoke other admins.
//
// API keys (`tn_live_…`) authenticate applications on /v1 and record which
// admin created them. Only SHA-256 hashes of any secret are stored; plaintext
// is returned exactly once at creation.
import crypto from 'node:crypto';
import express from 'express';
import { pool } from './db.js';

const KEY_PREFIX = 'tn_live_';
const ADMIN_PREFIX = 'tn_admin_';
const sha256 = (s) => crypto.createHash('sha256').update(s).digest();

export function generateKey() {
  return KEY_PREFIX + crypto.randomBytes(32).toString('base64url');
}
export function generateAdminToken() {
  return ADMIN_PREFIX + crypto.randomBytes(32).toString('base64url');
}

function bearerOf(req) {
  return (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
}

function isRoot(presented) {
  const token = process.env.ADMIN_TOKEN;
  if (!token || !presented) return false;
  return crypto.timingSafeEqual(sha256(presented), sha256(token));
}

// Resolve the caller: { root: true, name: 'root' } | { root: false, id, name } | null
async function resolveAdmin(req) {
  const presented = bearerOf(req);
  if (!presented) return null;
  if (isRoot(presented)) return { root: true, name: 'root' };
  if (!presented.startsWith(ADMIN_PREFIX)) return null;
  const r = await pool.query(
    'SELECT id, name, revoked_at FROM admins WHERE token_hash = $1', [sha256(presented)]);
  if (!r.rows.length || r.rows[0].revoked_at) return null;
  pool.query('UPDATE admins SET last_used_at = now() WHERE id = $1', [r.rows[0].id]).catch(() => {});
  return { root: false, id: r.rows[0].id, name: r.rows[0].name };
}

// ---------------------------------------------------------------------------
// Middleware for /v1/*: require an active API key via X-API-Key.
export async function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key || typeof key !== 'string' || !key.startsWith(KEY_PREFIX)) {
    return res.status(401).json({ error: 'missing or malformed API key (X-API-Key header)' });
  }
  try {
    const r = await pool.query(
      'SELECT id, revoked_at FROM api_keys WHERE key_hash = $1', [sha256(key)]);
    if (!r.rows.length) return res.status(401).json({ error: 'unknown API key' });
    if (r.rows[0].revoked_at) return res.status(401).json({ error: 'API key revoked' });
    req.apiKeyId = r.rows[0].id;
    pool.query(
      `UPDATE api_keys SET last_used_at = now(), request_count = request_count + 1 WHERE id = $1`,
      [r.rows[0].id]).catch(() => {});
    next();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// Reusable admin auth (root or active named admin) — also used by the
// newsletter and email-log surfaces.
export async function adminAuth(req, res, next) {
  if (!process.env.ADMIN_TOKEN) {
    return res.status(403).json({ error: 'admin surface disabled: ADMIN_TOKEN not set' });
  }
  try {
    const admin = await resolveAdmin(req);
    if (!admin) return res.status(401).json({ error: 'bad admin credentials' });
    req.admin = admin;
    next();
  } catch (e) { res.status(500).json({ error: e.message }); }
}

// ---------------------------------------------------------------------------
// Admin router: mounted at /api/admin
export function adminRouter() {
  const r = express.Router();
  r.use(express.json());
  r.use(adminAuth);

  // Who am I? Lets the panel adapt (root sees the Admins tab's controls).
  r.get('/whoami', (req, res) => {
    res.json({ name: req.admin.name, root: req.admin.root });
  });

  // ---- API keys (root or any active admin) --------------------------------
  r.post('/keys', async (req, res) => {
    const name = (req.body?.name ?? '').trim();
    if (!name || name.length > 120) return res.status(400).json({ error: 'name required (≤120 chars)' });
    const key = generateKey();
    const ins = await pool.query(
      `INSERT INTO api_keys (name, key_hash, created_by) VALUES ($1, $2, $3)
       RETURNING id, created_at`,
      [name, sha256(key), req.admin.name]);
    res.status(201).json({
      id: ins.rows[0].id, name, key, created_at: ins.rows[0].created_at,
      created_by: req.admin.name,
      note: 'Store this key now — it is not retrievable later.',
    });
  });

  r.get('/keys', async (_req, res) => {
    const r2 = await pool.query(
      `SELECT id, name, created_by, created_at, revoked_at, last_used_at, request_count
       FROM api_keys ORDER BY id`);
    res.json({ keys: r2.rows });
  });

  r.delete('/keys/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
    const r2 = await pool.query(
      `UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL
       RETURNING id`, [id]);
    if (!r2.rows.length) return res.status(404).json({ error: 'key not found or already revoked' });
    res.json({ revoked: id });
  });

  // ---- Admin management (ROOT ONLY) ----------------------------------------
  const rootOnly = (req, res, next) => {
    if (!req.admin.root) {
      return res.status(403).json({ error: 'admin management requires the root ADMIN_TOKEN' });
    }
    next();
  };

  r.post('/admins', rootOnly, async (req, res) => {
    const name = (req.body?.name ?? '').trim();
    if (!name || name.length > 120) return res.status(400).json({ error: 'name required (≤120 chars)' });
    const token = generateAdminToken();
    const ins = await pool.query(
      `INSERT INTO admins (name, token_hash, created_by) VALUES ($1, $2, 'root')
       RETURNING id, created_at`,
      [name, sha256(token)]);
    res.status(201).json({
      id: ins.rows[0].id, name, token, created_at: ins.rows[0].created_at,
      note: 'Give this token to the admin now — it is shown once and cannot be retrieved later.',
    });
  });

  r.get('/admins', rootOnly, async (_req, res) => {
    const r2 = await pool.query(
      `SELECT id, name, created_by, created_at, revoked_at, last_used_at
       FROM admins ORDER BY id`);
    res.json({ admins: r2.rows });
  });

  r.delete('/admins/:id', rootOnly, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
    const r2 = await pool.query(
      `UPDATE admins SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL
       RETURNING id`, [id]);
    if (!r2.rows.length) return res.status(404).json({ error: 'admin not found or already revoked' });
    res.json({ revoked: id });
  });

  return r;
}
