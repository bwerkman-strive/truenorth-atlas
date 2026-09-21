import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pnlHeadline, handoffHeadline, minersHeadline, dipbuyersHeadline, returnsHeadline, samehourHeadline, dayssinceHeadline, HEADLINES,
} from '../src/panelHeadlines.js';
import { PANEL_KINDS } from '../src/kinds.js';
import { LABEL, LABEL_STRONG } from '../src/chartTheme.js';

test('every panel kind has a headline builder and labels meet the 12px floor with a halo', () => {
  for (const k of PANEL_KINDS.filter(k => k !== 'stacked' && k !== 'urpd')) assert.equal(typeof HEADLINES[k], 'function', k);
  assert.ok(LABEL.fontSize >= 12 && LABEL_STRONG.fontSize >= 12);
  assert.equal(LABEL.paintOrder, 'stroke');
  assert.equal(LABEL_STRONG.fontWeight, 600);
});

test('pnlHeadline names the bear\'s worst day and the record days', () => {
  const h = pnlHeadline({
    series: [{}], latest: { day: '2026-09-20', profit: 1.2e9, loss: 3.1e8 },
    bear: { epoch: 5, peak: '2025-10-06', largestLoss: { day: '2026-02-05', loss: 7.19e9 } },
    topLoss: [{ day: '2026-02-05', loss: 7.19e9 }, { day: '2023-03-30', loss: 6.21e9 }, { day: '2025-11-22', loss: 5.72e9 }],
  });
  assert.equal(h.value, '$7.19B');
  assert.equal(h.sub, 'largest loss day of this bear, 02/05/2026');
  assert.equal(h.takeaway,
    'The largest loss-realization day of the epoch 5 bear was $7.19B on 02/05/2026. '
    + 'Across all history the biggest were $7.19B (02/05/2026), $6.21B (03/30/2023) and $5.72B (11/22/2025). '
    + 'On 09/20/2026, spenders realized $1.20B of profit and $310.00M of loss.');
  assert.equal(pnlHeadline({ series: [] }), null);
});

test('handoffHeadline states the cohort split and the move since the low', () => {
  const h = handoffHeadline({
    current: { day: '2026-09-20', lth: 0.8217, lthBtc: 16504426, sthBtc: 3582094, sinceLow: { day: '2026-06-30', deltaBtc: 1200000, deltaShare: 0.03 } },
    marks: [
      { epoch: 3, provisional: false, peak: { lth: 0.66 }, low: { lth: 0.78 } },
      { epoch: 4, provisional: false, peak: { lth: 0.71 }, low: { lth: 0.80 } },
      { epoch: 5, provisional: true, peak: { lth: 0.75 }, low: { lth: 0.79 } },
    ],
  });
  assert.equal(h.value, '+1.20M BTC');
  assert.equal(h.takeaway,
    'Long-term holders hold 16.50M BTC, 82% of the two cohorts combined, up 1.20M BTC since the 06/30/2026 low. '
    + 'At the last 2 cycle peaks their share read 66% and 71%; at the lows, 78% and 80%.');
  assert.equal(handoffHeadline({ current: null }), null);
});

test('minersHeadline counts episodes and the 180-day record', () => {
  const h = minersHeadline({
    current: { day: '2026-09-20', inEpisode: false },
    stats: { count: 6, judged: 5, higher180: 4 },
    episodes: [{ start: '2022-06-01', end: '2022-07-20', days: 50, ongoing: false, after180: { change: 0.12 } }],
  });
  assert.equal(h.value, '6 episodes');
  assert.match(h.takeaway, /^6 miner capitulations on record .*; price was higher 180 days later after 4 of the 5 completed\. The most recent ran 50 days to 07\/20\/2022, and price was \+12% 180 days on\.$/);
  const open = minersHeadline({ current: { day: '2026-09-20', inEpisode: true }, stats: { count: 1, judged: 0, higher180: 0 },
    episodes: [{ start: '2026-08-01', end: '2026-09-20', days: 51, ongoing: true, after180: null }] });
  assert.match(open.takeaway, /One is under way: day 51 since 08\/01\/2026\./);
});

test('dipbuyersHeadline names the biggest gainer and loser since the low', () => {
  const h = dipbuyersHeadline({
    current: { since: '2026-06-30', through: '2026-09-20', days: 82, rows: [
      { band: '<0.01', delta: 0.0002 }, { band: '1–10', delta: 0.008 }, { band: '1k–10k', delta: -0.005 },
    ] },
    priors: [{ epoch: 4, rows: [{ band: '10–100', delta: 0.004 }, { band: '1k–10k', delta: -0.002 }] }],
  });
  assert.equal(h.value, '+0.80 points');
  assert.equal(h.takeaway,
    'Since the 06/30/2026 low (82 days), addresses holding 1–10 BTC gained +0.80 points of supply share and 1k–10k BTC lost 0.50 points. '
    + 'Over the same span after earlier lows, the biggest gainers were 10–100 BTC in epoch 4.');
});

test('returnsHeadline gives the month to date, its history, and the year to date', () => {
  const h = returnsHeadline({
    years: [{ year: 2026, total: -0.13, partial: true }],
    current: { year: 2026, month: 9, ret: -0.024, day: '2026-09-20', provisional: true },
    monthStats: { month: 9, years: 13, up: 4, down: 9, median: -0.052 },
  });
  assert.equal(h.value, '−2.4%');
  assert.equal(h.takeaway, 'September 2026 is −2.4% to date. September has closed higher in 4 of the last 13 years, median −5.2%. 2026 is −13.0% year to date.');
});

test('samehourHeadline reads history at the 180-day horizon and says so', () => {
  const h = samehourHeadline({
    today: { epoch: 5, day: '2026-09-20', elapsed: 886, progress: 0.6098 },
    horizons: [90, 180, 365],
    rows: [
      { epoch: 3, forward: [{ days: 90, change: 0.1 }, { days: 180, change: -0.22 }, { days: 365, change: 0.3 }] },
      { epoch: 4, forward: [{ days: 90, change: 0.05 }, { days: 180, change: 0.14 }, { days: 365, change: null }] },
    ],
  });
  assert.equal(h.value, 'day 886');
  assert.equal(h.takeaway, 'Today is day 886 of epoch 5, 61% through by blocks. From the same point, epoch 3 lost 22% and epoch 4 gained 14% over the next 180 days. History, not a forecast.');
});

test('dayssinceHeadline strings the counters together with the prior spans', () => {
  const h = dayssinceHeadline({
    asOf: '2026-09-20',
    items: [
      { key: 'ath', days: 349, date: '2025-10-06', prior: { label: 'epoch 4 bear, peak to low', days: 378 } },
      { key: 'low', days: 82, date: '2026-06-30', prior: { label: 'epoch 4 low to the next peak', days: 1050 } },
      { key: 'halving', days: 884, date: '2024-04-19', prior: { label: 'epoch 4 halving to peak', days: 568 } },
      { key: 'nextHalving', days: 569, date: '2028-04-11', value: 81946, prior: { label: 'epoch 4 lasted', days: 1461 } },
    ],
  });
  assert.equal(h.value, '349 days');
  assert.equal(h.takeaway,
    '349 days since the all-time high on 10/06/2025 (the epoch 4 bear, peak to low took 378). '
    + '82 days since the 06/30/2026 low (the epoch 4 low to the next peak took 1050). '
    + '884 days since the halving (the epoch 4 halving to peak took 568). '
    + 'About 569 days to the next halving, 81,946 blocks away.');
});
