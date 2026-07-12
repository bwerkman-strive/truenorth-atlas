// API base: same-origin '/api' by default (dev proxy / reverse proxy), or an
// absolute origin via VITE_API_URL when the static site and API live apart.
const BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

async function get(path) {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

async function authed(method, path, token, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `API ${res.status}`);
  return json;
}

export const api = {
  catalog: () => get('/api/catalog'),
  explorerSearch: (q) => get('/api/explorer/search?q=' + encodeURIComponent(q)),
  explorerBlock: (id) => get('/api/explorer/block/' + encodeURIComponent(id)),
  explorerTx: (txid) => get('/api/explorer/tx/' + encodeURIComponent(txid)),
  explorerAddress: (a) => get('/api/explorer/address/' + encodeURIComponent(a)),
  explorerRecent: () => get('/api/explorer/blocks/recent'),
  cycles: (slug) => get(`/api/cycles/${slug}`),
  spot: () => get('/api/spot'),
  createAlert: (body) => fetch(BASE + '/api/alerts', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.error ?? `API ${r.status}`); return j; }),
  shareUrl: (slug) => (BASE || window.location.origin) + '/share/' + slug,
  admin: {
    whoami: (token) => authed('GET', '/api/admin/whoami', token),
    listKeys: (token) => authed('GET', '/api/admin/keys', token),
    createKey: (token, name) => authed('POST', '/api/admin/keys', token, { name }),
    revokeKey: (token, id) => authed('DELETE', `/api/admin/keys/${id}`, token),
    listAdmins: (token) => authed('GET', '/api/admin/admins', token),
    listNewsletters: (token) => authed('GET', '/api/admin/newsletters', token),
    getNewsletter: (token, id) => authed('GET', `/api/admin/newsletters/${id}`, token),
    createNewsletter: (token, body) => authed('POST', '/api/admin/newsletters', token, body),
    updateNewsletter: (token, id, body) => authed('PUT', `/api/admin/newsletters/${id}`, token, body),
    testNewsletter: (token, id, email) => authed('POST', `/api/admin/newsletters/${id}/test`, token, { email }),
    scheduleNewsletter: (token, id, send_at) => authed('POST', `/api/admin/newsletters/${id}/schedule`, token, { send_at }),
    cancelNewsletter: (token, id) => authed('POST', `/api/admin/newsletters/${id}/cancel`, token, {}),
    emailLog: (token, kind) => authed('GET', '/api/admin/email-log' + (kind ? `?kind=${kind}` : ''), token),
    createAdmin: (token, name) => authed('POST', '/api/admin/admins', token, { name }),
    revokeAdmin: (token, id) => authed('DELETE', `/api/admin/admins/${id}`, token),
  },
  latest: () => get('/api/latest'),
  status: () => get('/api/status'),
  series: (slug, { from, to, price, downsample } = {}) => {
    const q = new URLSearchParams();
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    if (price) q.set('price', '1');
    if (downsample) q.set('downsample', String(downsample));
    return get(`/api/series/${slug}?${q}`);
  },
};

// Formatters live in a pure module so they are unit-testable; re-exported
// here to keep existing import sites (`import { fmt } from '../api.js'`) working.
export { fmt, compact } from './format.js';

export const isEmbed = new URLSearchParams(window.location.search).get('embed') === '1';
