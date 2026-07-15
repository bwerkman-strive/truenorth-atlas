// Pure value formatters — no browser or Vite dependencies, so the exact code
// the UI renders with is unit-testable under node:test.
const usdFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const usdFmt2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const numFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export function fmt(value, format, unit) {
  // The API serializes Postgres numerics as strings — coerce before math.
  if (value === null || value === undefined || value === '') return '—';
  const v = Number(value);
  if (Number.isNaN(v)) return '—';
  switch (format) {
    case 'usd': return v < 1000 ? usdFmt2.format(v) : usdFmt.format(v);
    case 'usd_compact': return '$' + compact(v);
    case 'percent': return (v * 100).toFixed(1) + '%';
    case 'ratio': return Math.abs(v) >= 100 ? numFmt.format(v) : Number(v).toFixed(2);
    case 'number': return compact(v) + (unit ? ' ' + unit : '');
    default: return String(v);
  }
}

export function compact(value) {
  const v = Number(value);
  const a = Math.abs(v);
  if (a >= 1e12) return (v / 1e12).toFixed(2) + 'T';
  if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return a >= 10 ? v.toFixed(0) : v.toFixed(2);
}
