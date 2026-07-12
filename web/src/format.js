// Pure value formatters — no browser or Vite dependencies, so the exact code
// the UI renders with is unit-testable under node:test.
const usdFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const usdFmt2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const numFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export function fmt(value, format, unit) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  switch (format) {
    case 'usd': return value < 1000 ? usdFmt2.format(value) : usdFmt.format(value);
    case 'usd_compact': return '$' + compact(value);
    case 'percent': return (value * 100).toFixed(1) + '%';
    case 'ratio': return Math.abs(value) >= 100 ? numFmt.format(value) : Number(value).toFixed(2);
    case 'number': return compact(value) + (unit ? ' ' + unit : '');
    default: return String(value);
  }
}

export function compact(v) {
  const a = Math.abs(v);
  if (a >= 1e12) return (v / 1e12).toFixed(2) + 'T';
  if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return a >= 10 ? v.toFixed(0) : v.toFixed(2);
}
