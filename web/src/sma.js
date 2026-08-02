// Pure rolling simple moving average; lives in its own module so it is
// unit-testable without a DOM (like format.js and epoch.js).
//
// `rows` are API series rows in ascending day order, one row per day; values
// arrive as strings (the API serializes Postgres numeric as strings) and are
// coerced here. The average is emitted only once a full window of consecutive
// daily values is available; a non-numeric gap restarts the window so a
// partial average is never drawn. Zeros are legitimate values (pre-market
// days) and count toward the average.
export function smaByDay(rows, key, windowDays) {
  const out = new Map();
  if (!Number.isInteger(windowDays) || windowDays <= 0) return out;
  let sum = 0;
  const buf = [];
  for (const r of rows) {
    // Number(null) is 0, so nullish/empty must be caught before coercion or a
    // missing value would silently enter the average as zero.
    const raw = r[key];
    const v = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
    if (!Number.isFinite(v)) { buf.length = 0; sum = 0; continue; }
    buf.push(v);
    sum += v;
    if (buf.length > windowDays) sum -= buf.shift();
    if (buf.length === windowDays) out.set(r.day, sum / windowDays);
  }
  return out;
}
