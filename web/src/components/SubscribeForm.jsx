import { useState } from 'react';

const BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

export default function SubscribeForm() {
  const [email, setEmail] = useState('');
  const [state, setState] = useState('idle');
  const [msg, setMsg] = useState('');

  const submit = async () => {
    if (state === 'busy' || !email.includes('@')) return;
    setState('busy');
    try {
      const r = await fetch(BASE + '/api/subscribe', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `API ${r.status}`);
      setState('sent'); setMsg(j.message);
    } catch (e) { setState('error'); setMsg(e.message); }
  };

  if (state === 'sent') return <p className="sub-ok">{msg} No spam, unsubscribe anytime.</p>;
  return (
    <div className="sub-form">
      <input type="email" value={email} placeholder="you@example.com" aria-label="Email address"
        onChange={(e) => { setEmail(e.target.value); if (state === 'error') setState('idle'); }}
        onKeyDown={(e) => e.key === 'Enter' && submit()} />
      <button onClick={submit} disabled={state === 'busy' || !email.includes('@')}>
        {state === 'busy' ? '…' : 'Subscribe'}
      </button>
      {state === 'error' && <div className="sub-err">{msg}</div>}
    </div>
  );
}
