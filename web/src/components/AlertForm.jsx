// "Email me when this metric crosses X" — creates a double-opt-in alert.
import { useState } from 'react';
import { api } from '../api.js';

export default function AlertForm({ metric, currentValue }) {
  const defaultThreshold = () => {
    const hot = (metric.zones ?? []).find(z => z.tone === 'hot');
    if (hot) return String(hot.from);
    if (currentValue !== null && currentValue !== undefined) {
      const v = Number(currentValue);
      return String(Math.abs(v) >= 100 ? Math.round(v) : Number(v.toFixed(2)));
    }
    return '';
  };
  const [condition, setCondition] = useState('above');
  const [threshold, setThreshold] = useState(defaultThreshold);
  const [email, setEmail] = useState('');
  const [state, setState] = useState('idle'); // idle | busy | sent | error
  const [msg, setMsg] = useState('');

  const submit = async () => {
    if (state === 'busy') return;
    setState('busy'); setMsg('');
    try {
      await api.createAlert({ email: email.trim(), slug: metric.slug, condition, threshold: Number(threshold) });
      setState('sent');
    } catch (e) {
      setState('error'); setMsg(e.message);
    }
  };

  if (state === 'sent') {
    return (
      <p className="alert-sent">
        Check your inbox and confirm the alert. We'll email you when {metric.name} crosses
        {' '}{condition} {threshold} on finalized daily data. One click unsubscribes, ever.
      </p>
    );
  }

  return (
    <div className="alert-form">
      <p>Email me when this metric closes</p>
      <div className="alert-row">
        <select value={condition} onChange={(e) => setCondition(e.target.value)} aria-label="Condition">
          <option value="above">above</option>
          <option value="below">below</option>
        </select>
        <input type="text" inputMode="decimal" value={threshold}
          onChange={(e) => setThreshold(e.target.value)} aria-label="Threshold" placeholder="threshold" />
      </div>
      <div className="alert-row">
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="you@example.com" aria-label="Email address" />
        <button onClick={submit}
          disabled={state === 'busy' || !email.includes('@') || threshold === '' || Number.isNaN(Number(threshold))}>
          {state === 'busy' ? '…' : 'Set alert'}
        </button>
      </div>
      {state === 'error' && <div className="alert-err">{msg}</div>}
      <p className="alert-fine">Double opt-in via email · fires once per crossing on finalized daily closes · unsubscribe any time.</p>
    </div>
  );
}
