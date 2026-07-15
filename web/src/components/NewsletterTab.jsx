// Newsletter workflow for admins: draft -> attach charts -> test -> schedule.
import { useEffect, useState } from 'react';
import { api } from '../api.js';

const when = (t) => {
  if (!t) return '—';
  const iso = new Date(t).toISOString();
  return `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)} ${iso.slice(11, 16)} UTC`;
};
const STATUS_TONE = { draft: 'xmeta', scheduled: 'xunspent', sending: 'xunspent', sent: 'xmeta' };

export default function NewsletterTab({ token, catalog }) {
  const [list, setList] = useState(null);
  const [subs, setSubs] = useState(0);
  const [err, setErr] = useState(null);
  const [editing, setEditing] = useState(null); // null | {id?, subject, preheader, body_md, charts:Set}
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [testEmail, setTestEmail] = useState('');
  const [sendAt, setSendAt] = useState('');

  const lineMetrics = (catalog?.metrics ?? []).filter(m => m.kind !== 'stacked');

  const refresh = async () => {
    try {
      setErr(null);
      const r = await api.admin.listNewsletters(token);
      setList(r.newsletters); setSubs(r.confirmedSubscribers);
    } catch (e) { setErr(e.message); }
  };
  useEffect(() => { refresh(); }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  const blank = () => setEditing({ subject: '', preheader: '', body_md: '', charts: new Set() });
  const openExisting = async (id) => {
    try {
      const n = await api.admin.getNewsletter(token, id);
      setEditing({ id: n.id, status: n.status, subject: n.subject, preheader: n.preheader ?? '',
        body_md: n.body_md, charts: new Set(n.charts ?? []) });
      setNotice('');
    } catch (e) { setErr(e.message); }
  };

  const save = async () => {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const body = { subject: editing.subject, preheader: editing.preheader,
        body_md: editing.body_md, charts: [...editing.charts] };
      if (editing.id) await api.admin.updateNewsletter(token, editing.id, body);
      else {
        const r = await api.admin.createNewsletter(token, body);
        setEditing(e => ({ ...e, id: r.id, status: 'draft' }));
      }
      setNotice('Draft saved.');
      await refresh();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const sendTest = async () => {
    if (!editing?.id) { setErr('Save the draft first.'); return; }
    setBusy(true); setErr(null);
    try {
      const r = await api.admin.testNewsletter(token, editing.id, testEmail.trim());
      setNotice(r.message);
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const schedule = async (now) => {
    if (!editing?.id) { setErr('Save the draft first.'); return; }
    const at = now ? 'now' : new Date(sendAt).toISOString();
    if (!now && (!sendAt || Number.isNaN(Date.parse(sendAt)))) { setErr('Pick a valid send time.'); return; }
    if (!window.confirm(now
      ? `Send "${editing.subject}" to ${subs} confirmed subscribers now?`
      : `Schedule "${editing.subject}" for ${at} to ${subs} confirmed subscribers?`)) return;
    setBusy(true); setErr(null);
    try {
      await api.admin.scheduleNewsletter(token, editing.id, at);
      setNotice(now ? 'Queued; sending within the next minute.' : `Scheduled for ${at}.`);
      setEditing(null);
      await refresh();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const cancel = async (id) => {
    try { await api.admin.cancelNewsletter(token, id); await refresh(); }
    catch (e) { setErr(e.message); }
  };

  const toggleChart = (slug) => setEditing(e => {
    const charts = new Set(e.charts);
    charts.has(slug) ? charts.delete(slug) : charts.add(slug);
    if (charts.size > 8) return e;
    return { ...e, charts };
  });

  // ---------------- list view ----------------
  if (!editing) {
    return (
      <>
        <div className="syncnote">
          <strong>{subs.toLocaleString()}</strong> confirmed subscribers. Drafts render in the standard
          Atlas email format; attached charts embed as live branded cards linking back to the site.
          Every recipient send lands in the Email Log.
        </div>
        {err && <div className="err">{err}</div>}
        <div className="xsearch"><button onClick={blank} style={{ marginLeft: 0 }}>＋ New newsletter</button></div>
        {list && list.length === 0 && <div className="syncnote">No newsletters yet.</div>}
        {list && list.length > 0 && (
          <div className="xcard">
            {list.map(n => (
              <div className="xrow" key={n.id}>
                <div className="xval">
                  <span>
                    <strong>{n.subject}</strong>{' '}
                    <em className={STATUS_TONE[n.status] ?? 'xmeta'} style={{ fontStyle: 'normal' }}>{n.status}</em>
                    <span className="xmeta">
                      {' '}· by {n.created_by} · {n.charts?.length ?? 0} charts
                      {n.status === 'scheduled' && ` · sends ${when(n.scheduled_at)}`}
                      {n.status === 'sent' && ` · sent ${when(n.sent_at)} · ${n.sent_count} delivered${n.failed_count ? `, ${n.failed_count} failed` : ''}`}
                    </span>
                  </span>
                  <span>
                    {['draft', 'scheduled'].includes(n.status) &&
                      <button className="xrevoke" style={{ color: 'var(--cold)', marginRight: 8 }}
                        onClick={() => openExisting(n.id)}>Edit</button>}
                    {n.status === 'scheduled' &&
                      <button className="xrevoke" onClick={() => cancel(n.id)}>Cancel</button>}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </>
    );
  }

  // ---------------- composer ----------------
  return (
    <>
      {err && <div className="err">{err}</div>}
      {notice && <div className="syncnote">{notice}</div>}
      <div className="nl-composer">
        <label>Subject
          <input value={editing.subject} maxLength={200}
            onChange={(e) => setEditing({ ...editing, subject: e.target.value })}
            placeholder="The Weekly Bearing: MVRV stretches into the hot zone" />
        </label>
        <label>Preheader <span className="xmeta">(inbox preview line, optional)</span>
          <input value={editing.preheader} maxLength={200}
            onChange={(e) => setEditing({ ...editing, preheader: e.target.value })}
            placeholder="Where the ledger stands this week." />
        </label>
        <label>Body <span className="xmeta">(## headings, **bold**, *italic*, [links](https://…), - bullets)</span>
          <textarea rows={12} value={editing.body_md}
            onChange={(e) => setEditing({ ...editing, body_md: e.target.value })}
            placeholder={'## Where we stand\n\nMVRV closed the week at **2.4**, the 87th percentile of all history…'} />
        </label>

        <div className="nl-charts">
          <div className="nl-charts-hd">Attach charts <span className="xmeta">({editing.charts.size}/8, embedded as branded cards)</span></div>
          <div className="nl-chart-grid">
            {lineMetrics.map(m => (
              <label key={m.slug} className={editing.charts.has(m.slug) ? 'on' : ''}>
                <input type="checkbox" checked={editing.charts.has(m.slug)} onChange={() => toggleChart(m.slug)} />
                {m.name}
              </label>
            ))}
          </div>
        </div>

        <div className="nl-actions">
          <button className="nl-save" onClick={save} disabled={busy || !editing.subject.trim()}>
            {busy ? '…' : editing.id ? 'Save changes' : 'Save draft'}
          </button>
          <span className="nl-group">
            <input type="email" value={testEmail} placeholder="you@tnorth.com"
              onChange={(e) => setTestEmail(e.target.value)} aria-label="Test recipient" />
            <button onClick={sendTest} disabled={busy || !editing.id || !testEmail.includes('@')}>Send test</button>
          </span>
          <span className="nl-group">
            <input type="datetime-local" value={sendAt} onChange={(e) => setSendAt(e.target.value)} aria-label="Send time" />
            <button onClick={() => schedule(false)} disabled={busy || !editing.id}>Schedule</button>
            <button className="nl-now" onClick={() => schedule(true)} disabled={busy || !editing.id}>Send now</button>
          </span>
          <button className="xdismiss" onClick={() => setEditing(null)}>Back</button>
        </div>
      </div>
    </>
  );
}
