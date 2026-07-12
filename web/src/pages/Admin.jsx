// Admin panel (#/admin). Two tabs:
//   Keys          — create / list / revoke private-API keys
//   API Reference — how to authenticate, every endpoint, example output
//
// The admin token is held in component state only — never persisted to
// storage — and sent as a Bearer header on each admin call.
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { API_AUTH_DOC, API_ENDPOINTS } from '../apiReference.js';
import NewsletterTab from '../components/NewsletterTab.jsx';

const when = (t) => (t ? new Date(t).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—');

function Json({ value }) {
  return <pre className="xjson">{JSON.stringify(value, null, 2)}</pre>;
}

// ---------------------------------------------------------------------------
function KeysTab({ token }) {
  const [keys, setKeys] = useState(null);
  const [err, setErr] = useState(null);
  const [name, setName] = useState('');
  const [fresh, setFresh] = useState(null); // { name, key } just created
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    try { setErr(null); setKeys((await api.admin.listKeys(token)).keys); }
    catch (e) { setErr(e.message); }
  };
  useEffect(() => { refresh(); }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await api.admin.createKey(token, name.trim());
      setFresh({ name: r.name, key: r.key });
      setName('');
      await refresh();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const revoke = async (id, keyName) => {
    if (!window.confirm(`Revoke "${keyName}"? Applications using it lose access immediately.`)) return;
    try { await api.admin.revokeKey(token, id); await refresh(); }
    catch (e) { setErr(e.message); }
  };

  return (
    <>
      {err && <div className="err">{err}</div>}

      {fresh && (
        <div className="xfresh">
          <strong>Key created for “{fresh.name}” — copy it now.</strong> It is shown once and
          cannot be retrieved later; only its hash is stored.
          <div className="xfresh-key mono">
            {fresh.key}
            <button onClick={() => navigator.clipboard?.writeText(fresh.key)}>Copy</button>
          </div>
          <button className="xdismiss" onClick={() => setFresh(null)}>I've stored it</button>
        </div>
      )}

      <div className="xsearch">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && create()}
          placeholder="Key name — e.g. sata-dashboard, treasury-bot…"
          maxLength={120}
        />
        <button onClick={create} disabled={busy || !name.trim()}>{busy ? '…' : 'Create key'}</button>
      </div>

      {keys && keys.length === 0 && <div className="syncnote">No keys yet. Create one above to open the private API to an application.</div>}
      {keys && keys.length > 0 && (
        <div className="xcard">
          {keys.map(k => (
            <div className="xrow" key={k.id}>
              <div className="xval">
                <span>
                  <strong>{k.name}</strong>{' '}
                  {k.revoked_at
                    ? <em className="xspent">revoked {when(k.revoked_at)}</em>
                    : <em className="xunspent">active</em>}
                  <span className="xmeta"> · by {k.created_by ?? '—'} · created {when(k.created_at)} · {Number(k.request_count).toLocaleString()} requests
                    {k.last_used_at ? ` · last used ${when(k.last_used_at)}` : ' · never used'}</span>
                </span>
                {!k.revoked_at && (
                  <button className="xrevoke" onClick={() => revoke(k.id, k.name)}>Revoke</button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
function AdminsTab({ token, isRoot }) {
  const [admins, setAdmins] = useState(null);
  const [err, setErr] = useState(null);
  const [name, setName] = useState('');
  const [fresh, setFresh] = useState(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    try { setErr(null); setAdmins((await api.admin.listAdmins(token)).admins); }
    catch (e) { setErr(e.message); }
  };
  useEffect(() => { if (isRoot) refresh(); }, [token, isRoot]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!isRoot) {
    return (
      <div className="syncnote">
        Admin management requires the root <code>ADMIN_TOKEN</code>. You are signed in with a
        named admin token, which can manage API keys but not other admins.
      </div>
    );
  }

  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await api.admin.createAdmin(token, name.trim());
      setFresh({ name: r.name, token: r.token });
      setName('');
      await refresh();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const revoke = async (id, adminName) => {
    if (!window.confirm(`Revoke admin "${adminName}"? Their token stops working immediately. API keys they created remain active.`)) return;
    try { await api.admin.revokeAdmin(token, id); await refresh(); }
    catch (e) { setErr(e.message); }
  };

  return (
    <>
      <div className="syncnote">
        Admin tokens can create, list, and revoke <strong>API keys</strong>. Only the root{' '}
        <code>ADMIN_TOKEN</code> (this session) can manage <strong>admins</strong>. Hand each
        person their own token so access is individually revocable and every API key records
        who created it.
      </div>
      {err && <div className="err">{err}</div>}

      {fresh && (
        <div className="xfresh">
          <strong>Admin token created for “{fresh.name}” — hand it over securely now.</strong>{' '}
          It is shown once; only its hash is stored.
          <div className="xfresh-key mono">
            {fresh.token}
            <button onClick={() => navigator.clipboard?.writeText(fresh.token)}>Copy</button>
          </div>
          <button className="xdismiss" onClick={() => setFresh(null)}>Done</button>
        </div>
      )}

      <div className="xsearch">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && create()}
          placeholder="Admin name — e.g. jane-ops, treasury-team…"
          maxLength={120}
        />
        <button onClick={create} disabled={busy || !name.trim()}>{busy ? '…' : 'Add admin'}</button>
      </div>

      {admins && admins.length === 0 && (
        <div className="syncnote">No named admins yet — you are operating on the root token alone.
        Mint yourself a personal admin token for day-to-day use and keep root locked away.</div>
      )}
      {admins && admins.length > 0 && (
        <div className="xcard">
          {admins.map(a => (
            <div className="xrow" key={a.id}>
              <div className="xval">
                <span>
                  <strong>{a.name}</strong>{' '}
                  {a.revoked_at
                    ? <em className="xspent">revoked {when(a.revoked_at)}</em>
                    : <em className="xunspent">active</em>}
                  <span className="xmeta"> · created {when(a.created_at)}
                    {a.last_used_at ? ` · last used ${when(a.last_used_at)}` : ' · never used'}</span>
                </span>
                {!a.revoked_at && (
                  <button className="xrevoke" onClick={() => revoke(a.id, a.name)}>Revoke</button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
function EmailLogTab({ token }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [kind, setKind] = useState('');
  const refresh = async (k) => {
    try { setErr(null); setData(await api.admin.emailLog(token, k)); }
    catch (e) { setErr(e.message); }
  };
  useEffect(() => { refresh(kind); }, [token, kind]); // eslint-disable-line react-hooks/exhaustive-deps

  const KINDS = ['', 'alert_confirm', 'alert_fire', 'subscribe_confirm', 'newsletter', 'newsletter_test'];
  const whenTs = (t) => new Date(t).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

  return (
    <>
      <div className="syncnote">
        The complete, immutable record of every email this platform has attempted to send — recipient,
        subject, type, outcome, and the provider's message ID. Failures are recorded too.
      </div>
      {err && <div className="err">{err}</div>}
      <nav className="catnav" aria-label="Email kinds">
        {KINDS.map(k => (
          <button key={k || 'all'} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>
            {k === '' ? 'All' : k.replace('_', ' ')}
          </button>
        ))}
      </nav>
      {data && (
        <>
          <div className="xmeta" style={{ padding: '4px 2px 10px' }}>
            {data.stats.map(s => `${s.kind} ${s.status}: ${s.c}`).join(' · ') || 'No emails sent yet.'}
          </div>
          <div className="xcard">
            {data.entries.length === 0 && <div className="xrow"><div className="xval">Nothing here yet.</div></div>}
            {data.entries.map(e => (
              <div className="xrow" key={e.id}>
                <div className="xval">
                  <span>
                    <span className="mono">{e.recipient}</span>{' '}
                    {e.status === 'sent'
                      ? <em className="xunspent">sent</em>
                      : <em className="xspent">failed</em>}
                    <span className="xmeta"> · {e.kind} · {whenTs(e.sent_at)}
                      {e.provider_id ? ` · ${e.provider_id}` : ''}</span>
                    <br /><span className="xmeta">{e.subject}</span>
                    {e.error && <><br /><span className="xmeta" style={{ color: 'var(--hot)' }}>{e.error}</span></>}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
function ApiTab() {
  return (
    <>
      <div className="sec"><h2>Authentication</h2></div>
      <div className="xcard xdoc">
        <p>
          Programmatic access lives under <code>/v1</code> and requires an active key in the{' '}
          <code>{API_AUTH_DOC.header}</code> header. Keys look like{' '}
          <code>{API_AUTH_DOC.keyFormat}</code> and are unmetered — the public{' '}
          <code>/api/explorer</code> surface is identical but rate-limited per IP.
        </p>
        <pre className="xjson">{API_AUTH_DOC.curl}</pre>
        <p>Authentication failures:</p>
        {API_AUTH_DOC.errors.map((e, i) => (
          <div className="xerr-line mono" key={i}>HTTP {e.status} → {JSON.stringify(e.body)}</div>
        ))}
      </div>

      {API_ENDPOINTS.map(ep => (
        <div key={ep.path}>
          <div className="sec"><h2>{ep.title}</h2></div>
          <div className="xcard xdoc">
            <div className="xendpoint mono"><span className="xmethod">{ep.method}</span> {ep.path}</div>
            <p>{ep.desc}</p>
            <p className="xexample mono">Example: <code>{ep.example}</code></p>
            <p className="xlabel-sm">Example response</p>
            <Json value={ep.response} />
            {ep.notes && <p className="xnotes">{ep.notes}</p>}
          </div>
        </div>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
export default function Admin() {
  const [token, setToken] = useState('');
  const [catalog, setCatalog] = useState(null);
  const [entered, setEntered] = useState('');
  const [tab, setTab] = useState('keys');
  const [who, setWho] = useState(null);
  const [unlockErr, setUnlockErr] = useState(null);

  const unlock = async () => {
    const t = entered.trim();
    if (!t) return;
    setUnlockErr(null);
    try {
      const w = await api.admin.whoami(t);
      setWho(w);
      setToken(t);
      api.catalog().then(setCatalog).catch(() => {});
    } catch (e) {
      setUnlockErr(e.message === 'bad admin credentials'
        ? 'Not a valid root or admin token.' : e.message);
    }
  };

  if (!token) {
    return (
      <div className="wrap">
        <div className="hero">
          <h1>Admin</h1>
          <p>Enter the root <code>ADMIN_TOKEN</code> (from the API service's environment) or a
          personal admin token issued to you.</p>
        </div>
        <div className="xsearch" style={{ maxWidth: 560 }}>
          <input
            type="password"
            value={entered}
            onChange={(e) => setEntered(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && unlock()}
            placeholder="Root or admin token…"
            autoFocus
          />
          <button onClick={unlock}>Unlock</button>
          {unlockErr && <div className="xmiss">{unlockErr}</div>}
        </div>
        <div className="syncnote">
          The token is held in memory for this tab only and sent as a Bearer header on admin
          requests — it is never written to storage. A wrong token simply gets 401s from the API.
        </div>
      </div>
    );
  }

  return (
    <div className="wrap">
      <div className="hero">
        <h1>Admin</h1>
        <p>Signed in as <strong>{who?.name}</strong>{who?.root ? ' (root)' : ''} — private-API key
        management{who?.root ? ', admin management,' : ''} and integration reference.</p>
      </div>
      <nav className="catnav" aria-label="Admin sections">
        <button className={tab === 'keys' ? 'on' : ''} onClick={() => setTab('keys')}>API Keys</button>
        <button className={tab === 'admins' ? 'on' : ''} onClick={() => setTab('admins')}>Admins</button>
        <button className={tab === 'newsletter' ? 'on' : ''} onClick={() => setTab('newsletter')}>Newsletter</button>
        <button className={tab === 'emaillog' ? 'on' : ''} onClick={() => setTab('emaillog')}>Email Log</button>
        <button className={tab === 'api' ? 'on' : ''} onClick={() => setTab('api')}>API Reference</button>
        <button className="xlock" onClick={() => { setToken(''); setEntered(''); setWho(null); }}>Lock</button>
      </nav>
      {tab === 'keys' ? <KeysTab token={token} />
        : tab === 'admins' ? <AdminsTab token={token} isRoot={!!who?.root} />
        : tab === 'newsletter' ? <NewsletterTab token={token} catalog={catalog} />
        : tab === 'emaillog' ? <EmailLogTab token={token} />
        : <ApiTab />}
    </div>
  );
}
