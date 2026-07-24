// Finalizes one UTC day of metrics. Called by the sync worker at the exact
// moment the last block of `day` has been applied, so the utxos table is the
// precise end-of-day UTXO set.
import { pool, getState, setState } from './db.js';
import { config } from './config.js';

// Fine-grained age buckets (days). 155 is inserted so STH/LTH cohorts can be
// derived from the same single scan as HODL waves.
const EDGES = [1, 7, 30, 90, 155, 180, 365, 730, 1095, 1825, 2555, 3650];
export const WAVE_LABELS = ['24h', '1d–1w', '1w–1m', '1m–3m', '3m–6m', '6m–1y',
  '1y–2y', '2y–3y', '3y–5y', '5y–7y', '7y–10y', '10y+'];
// bucket index -> wave label index (buckets 4 and 5 merge into '3m–6m')
const WAVE_OF = [0, 1, 2, 3, 4, 4, 5, 6, 7, 8, 9, 10, 11];

// Age band for a spent output, using the SAME labels as HODL waves so the
// spend-side (spent_age_bands) and hold-side views line up 1:1 in the UI.
// sync.js calls this in the hot loop; keep it allocation-free.
export function ageBandOf(ageDays) {
  for (let i = 0; i < EDGES.length; i++) {
    if (ageDays < EDGES[i]) return WAVE_LABELS[WAVE_OF[i]];
  }
  return WAVE_LABELS[WAVE_OF[EDGES.length]];
}

// Fee-rate histogram buckets (sat/vB), shared by sync.js (per-block counts)
// and the daily rollup (median extraction). Bucket i holds rates in
// [FEERATE_EDGES[i-1], FEERATE_EDGES[i]); bucket 0 is < 1 sat/vB and the last
// bucket is open-ended. The median is therefore bucket-resolution, which the
// catalog copy states plainly.
export const FEERATE_EDGES = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40,
  50, 75, 100, 150, 200, 300, 500, 1000];
export function feerateBucketOf(rate) {
  let i = 0;
  while (i < FEERATE_EDGES.length && rate >= FEERATE_EDGES[i]) i++;
  return i;
}
export function feerateBucketValue(idx) {
  if (idx <= 0) return 0.5;
  if (idx >= FEERATE_EDGES.length) return FEERATE_EDGES[FEERATE_EDGES.length - 1] * 1.5;
  return (FEERATE_EDGES[idx - 1] + FEERATE_EDGES[idx]) / 2;
}

// Spend-age bands counted as "revived" old supply.
const REVIVED_BANDS = new Set(['1y–2y', '2y–3y', '3y–5y', '5y–7y', '7y–10y', '10y+']);

// Address-balance cohort thresholds (BTC) and their band labels.
const BAL_THRESHOLDS = [0.01, 0.1, 1, 10, 100, 1000, 10000];
const BAL_LABELS = ['<0.01', '0.01–0.1', '0.1–1', '1–10', '10–100', '100–1k', '1k–10k', '10k+'];

// At the live tip, a day's blocks are processed before that day's candle
// exists, so priceForDay falls back to the previous close and marks the day
// provisional (chain_state 'provisional:<day>'). Once the true close exists,
// this re-stamps the day's still-live creations and mirrors the correction
// into block_agg (realized_cap_delta, miner_rev_usd) and the running counters,
// so rollbackAbove() stays exactly reversible and the realized-cap books
// balance to the satoshi-level tolerance the reconciliation gate enforces.
// Residuals accepted by design: same-day spends' flow stats (SOPR components,
// vdd) keep the provisional spot for that one day — self-contained per-day
// fuzz, not accumulating state. During a healthy replay historical candles
// always exist, the flag never appears, and this is a single SELECT.
async function repriceProvisionalDay(day, price, log) {
  const flag = await pool.query(
    `SELECT 1 FROM chain_state WHERE key = $1`, ['provisional:' + day]);
  if (!flag.rows.length) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const hr = await client.query(
      'SELECT MIN(height) lo, MAX(height) hi FROM blocks WHERE day=$1', [day]);
    const { lo, hi } = hr.rows[0];
    if (lo !== null) {
      // Per-block creation-side corrections from the still-live rows.
      const per = await client.query(`
        SELECT created_height h, SUM(value_sat::numeric / 1e8 * ($1 - created_price)) a
        FROM utxos
        WHERE created_height BETWEEN $2 AND $3
          AND spent_height IS NULL AND created_price <> $1
        GROUP BY 1`, [price, lo, hi]);
      let rcAdj = 0;
      if (per.rows.length) {
        rcAdj = per.rows.reduce((s, r) => s + Number(r.a), 0);
        await client.query(`
          UPDATE block_agg b SET realized_cap_delta = realized_cap_delta + x.a
          FROM unnest($1::int[], $2::numeric[]) AS x(h, a)
          WHERE b.height = x.h`,
          [per.rows.map(r => r.h), per.rows.map(r => Number(r.a))]);
        await client.query(`
          UPDATE utxos SET created_price = $1
          WHERE created_height BETWEEN $2 AND $3
            AND spent_height IS NULL AND created_price <> $1`, [price, lo, hi]);
      }

      // Miner revenue re-valued at the true close (old total -> new total).
      const oldRev = Number((await client.query(
        `SELECT COALESCE(SUM(miner_rev_usd),0) v FROM block_agg WHERE day=$1`, [day])).rows[0].v);
      await client.query(`
        UPDATE block_agg a SET miner_rev_usd = (b.subsidy_sat + b.fees_sat)::numeric / 1e8 * $2
        FROM blocks b WHERE b.height = a.height AND a.day = $1`, [day, price]);
      const newRev = Number((await client.query(
        `SELECT COALESCE(SUM(miner_rev_usd),0) v FROM block_agg WHERE day=$1`, [day])).rows[0].v);

      await setState(client, 'realized_cap_usd',
        (await getState(client, 'realized_cap_usd')) + rcAdj);
      await setState(client, 'cum_miner_rev_usd',
        (await getState(client, 'cum_miner_rev_usd')) + (newRev - oldRev));
      log?.info({ day, price, rcAdj, minerRevAdj: newRev - oldRev },
        'repriced provisional day at its finalized close');
    }
    await client.query(`DELETE FROM chain_state WHERE key = $1`, ['provisional:' + day]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

export async function snapshotAndRollupDay(day, log) {
  const last = await pool.query(`SELECT value FROM chain_state WHERE key='last_metrics_day_epoch'`);
  const lastEpoch = last.rows.length ? Number(last.rows[0].value) : 0;
  const dayEpoch = Date.parse(day + 'T00:00:00Z') / 86400e3;
  if (dayEpoch <= lastEpoch) return; // already finalized (idempotency guard)

  const priceR = await pool.query('SELECT close_usd FROM prices WHERE day=$1', [day]);
  // Pre-market days exist as explicit 0 rows, so a missing row is always a
  // provider gap. Finalizing a day against price 0 (or any wrong price) writes
  // permanently bad metrics; fail loudly instead. See prices.assertNoPriceGaps.
  if (!priceR.rows.length) {
    throw new Error(`no daily close for ${day}: prices table has a gap; refusing to finalize`);
  }
  const price = Number(priceR.rows[0].close_usd);
  await repriceProvisionalDay(day, price, log); // before any set scan reads stamps
  const dayEnd = new Date((dayEpoch + 1) * 86400e3).toISOString();

  // ---- Set-level snapshot: one scan of the live UTXO set -------------------
  const caseExpr = EDGES.map((e, i) =>
    `WHEN age_d < ${e} THEN ${i}`).join(' ') + ` ELSE ${EDGES.length}`;
  const snap = await pool.query(`
    WITH u AS (
      SELECT value_sat, created_price, coinbase,
             EXTRACT(EPOCH FROM ($1::timestamptz - created_time)) / 86400.0 AS age_d
      FROM utxos WHERE spent_height IS NULL
    )
    SELECT (CASE ${caseExpr} END)::int AS b,
           SUM(value_sat)::numeric / 1e8 AS v_btc,
           SUM(value_sat::numeric / 1e8 * created_price) AS rc_usd,
           COALESCE(SUM(value_sat) FILTER (WHERE created_price < $2), 0)::numeric / 1e8 AS v_profit,
           COALESCE(SUM(value_sat::numeric / 1e8 * ($2 - created_price)) FILTER (WHERE created_price < $2), 0) AS u_profit,
           COALESCE(SUM(value_sat::numeric / 1e8 * (created_price - $2)) FILTER (WHERE created_price > $2), 0) AS u_loss,
           COALESCE(SUM(value_sat) FILTER (WHERE coinbase), 0)::numeric / 1e8 AS cb_btc
    FROM u GROUP BY 1`, [dayEnd, price]);

  let setSupply = 0, setRc = 0, profitBtc = 0;
  let unrealProfit = 0, unrealLoss = 0, minerUnmoved = 0;
  let sthV = 0, sthRc = 0, lthV = 0, lthRc = 0, sthProfit = 0, lthProfit = 0;
  const waves = Object.fromEntries(WAVE_LABELS.map(l => [l, 0]));
  const rcWaves = Object.fromEntries(WAVE_LABELS.map(l => [l, 0]));
  for (const r of snap.rows) {
    const b = Number(r.b), v = Number(r.v_btc), rc = Number(r.rc_usd);
    setSupply += v; setRc += rc; profitBtc += Number(r.v_profit);
    unrealProfit += Number(r.u_profit); unrealLoss += Number(r.u_loss);
    minerUnmoved += Number(r.cb_btc);
    if (EDGES[b] !== undefined && EDGES[b] <= config.sthDays) { sthV += v; sthRc += rc; sthProfit += Number(r.v_profit); }
    else { lthV += v; lthRc += rc; lthProfit += Number(r.v_profit); }
    waves[WAVE_LABELS[WAVE_OF[b]]] += v;
    rcWaves[WAVE_LABELS[WAVE_OF[b]]] += rc;
  }
  for (const k of WAVE_LABELS) {
    waves[k] = setSupply > 0 ? waves[k] / setSupply : 0;
    rcWaves[k] = setRc > 0 ? rcWaves[k] / setRc : 0;
  }

  // ---- Cost-basis distribution (URPD): supply bucketed by acquisition price --
  // 100 uniform buckets from $0 to the highest close seen so far (created_price
  // can never exceed it). A second scan of the live set; it runs once per day
  // inside the boundary pause, where exactness is the product.
  const URPD_BUCKETS = 100;
  const topR = await pool.query(
    `SELECT COALESCE(MAX(close_usd), 0)::float AS top FROM prices WHERE day <= $1`, [day]);
  const urpdTop = topR.rows[0].top;
  let urpd = null;
  if (urpdTop > 0) {
    const w = urpdTop / URPD_BUCKETS;
    const dist = await pool.query(`
      SELECT LEAST(FLOOR(created_price / $1)::int, ${URPD_BUCKETS - 1}) AS b,
             SUM(value_sat)::numeric / 1e8 AS v
      FROM utxos WHERE spent_height IS NULL
      GROUP BY 1 ORDER BY 1`, [w]);
    urpd = {
      width: w,
      top: urpdTop,
      buckets: dist.rows.map(r => ({
        p: Math.round(Number(r.b) * w * 100) / 100,
        v: Number(r.v),
      })),
    };
  }

  // ---- Address cohorts: one GROUP BY address pass over the live set ---------
  // The only per-address aggregation in the pipeline. It runs on a dedicated
  // session with a raised work_mem so the hash aggregate stays in memory at
  // late-chain address counts; everything else about the day pause is
  // unaffected. Addresses are not entities (one exchange address is not one
  // person) — the catalog copy carries that caveat.
  const cohortClient = await pool.connect();
  let bandRows;
  try {
    await cohortClient.query(`SET work_mem = '512MB'`);
    bandRows = (await cohortClient.query(`
      SELECT width_bucket(bal, $1::numeric[]) AS b, COUNT(*)::int n, SUM(bal) v
      FROM (SELECT SUM(value_sat)::numeric / 1e8 AS bal
            FROM utxos WHERE spent_height IS NULL AND address IS NOT NULL
            GROUP BY address) t
      GROUP BY 1`, [BAL_THRESHOLDS])).rows;
    await cohortClient.query('RESET work_mem');
  } finally { cohortClient.release(); }
  let addressedSupply = 0, wholecoinerCount = 0;
  const balBands = Object.fromEntries(BAL_LABELS.map(l => [l, 0]));
  for (const r of bandRows) {
    const b = Number(r.b), v = Number(r.v);
    addressedSupply += v;
    balBands[BAL_LABELS[b]] += v;
    if (b >= BAL_LABELS.indexOf('1–10')) wholecoinerCount += Number(r.n);
  }
  for (const k of BAL_LABELS) {
    balBands[k] = addressedSupply > 0 ? balBands[k] / addressedSupply : 0;
  }

  // ---- Flow rollup from per-block aggregates --------------------------------
  const f = (await pool.query(`
    SELECT COALESCE(SUM(sopr_num),0) sn, COALESCE(SUM(sopr_den),0) sd,
           COALESCE(SUM(asopr_num),0) an, COALESCE(SUM(asopr_den),0) ad,
           COALESCE(SUM(sth_sopr_num),0) stn, COALESCE(SUM(sth_sopr_den),0) std,
           COALESCE(SUM(lth_sopr_num),0) ltn, COALESCE(SUM(lth_sopr_den),0) ltd,
           COALESCE(SUM(realized_profit),0) rp, COALESCE(SUM(realized_loss),0) rl,
           COALESCE(SUM(cdd),0) cdd, COALESCE(SUM(vdd_usd),0) vdd,
           COALESCE(SUM(transfer_vol_sat),0)::numeric / 1e8 vol,
           COALESCE(SUM(op_return_fees_sat),0)::numeric / 1e8 oprf,
           COALESCE(SUM(miner_outflow_sat),0)::numeric / 1e8 mout
    FROM block_agg WHERE day=$1`, [day])).rows[0];

  // Spend-side age bands and the fee-rate histogram merge across the day's
  // blocks in SQL (sparse JSONB objects, summed per key).
  const bandAgg = (await pool.query(`
    SELECT key AS band, SUM(value::numeric) AS v
    FROM block_agg, jsonb_each_text(spent_age_bands)
    WHERE day = $1 AND spent_age_bands IS NOT NULL GROUP BY key`, [day])).rows;
  const histAgg = (await pool.query(`
    SELECT key::int AS b, SUM(value::numeric)::bigint AS n
    FROM block_agg, jsonb_each_text(feerate_hist)
    WHERE day = $1 AND feerate_hist IS NOT NULL GROUP BY key ORDER BY 1`, [day])).rows;

  let spentTotal = 0, revived1y = 0;
  for (const r of bandAgg) {
    spentTotal += Number(r.v);
    if (REVIVED_BANDS.has(r.band)) revived1y += Number(r.v);
  }
  const spentBands = spentTotal > 0
    ? Object.fromEntries(bandAgg.map(r => [r.band, Number(r.v) / spentTotal])) : null;

  let medianFeerate = null;
  const histTotal = histAgg.reduce((a, r) => a + Number(r.n), 0);
  if (histTotal > 0) {
    const target = Math.ceil(histTotal / 2);
    let cum = 0;
    for (const r of histAgg) {
      cum += Number(r.n);
      if (cum >= target) { medianFeerate = feerateBucketValue(Number(r.b)); break; }
    }
  }

  const active = (await pool.query(
    'SELECT COUNT(*)::int c FROM day_active_addresses WHERE day = $1', [day])).rows[0].c;

  const blk = (await pool.query(`
    SELECT COALESCE(SUM(tx_count),0) txs,
           COALESCE(SUM(subsidy_sat + fees_sat),0)::numeric / 1e8 minted,
           COALESCE(SUM(fees_sat),0)::numeric / 1e8 fees,
           COALESCE(SUM(fees_sat),0)::numeric fees_sat,
           COALESCE(SUM(subsidy_sat),0)::numeric / 1e8 subsidy,
           COUNT(*)::int nblocks,
           CASE WHEN COUNT(*) = COUNT(weight) THEN SUM(weight)::numeric END wt,
           MAX(difficulty) diff
    FROM blocks WHERE day=$1`, [day])).rows[0];

  // ---- Running state (chain_state is exactly end-of-day at this call site) --
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const realizedCap = await getState(client, 'realized_cap_usd');
    const supplySat = await getState(client, 'circulating_supply_sat');
    const supplyBtc = supplySat / 1e8;

    // ---- Reconciliation gate --------------------------------------------
    // The running counters and the tables they summarize are maintained by
    // independent code paths; if they ever disagree, something upstream wrote
    // corrupt state and finalizing would bake it into history. Halt instead:
    // a crash-looping worker the same day is recoverable (rollback window),
    // a poisoned month is a from-genesis replay.
    //   supply: exact integer identity against SUM(blocks.subsidy_sat).
    //   realized cap: live-set sum vs counter. Tolerance covers float
    //   accumulation (~1e-12 relative) and the two historic BIP30 duplicate
    //   coinbases, whose creations were double-counted at ~$0.06 closes (a
    //   few dollars, forever). $100 floor + 1e-8 relative is 1000x margin.
    const subsidySum = Number((await client.query(
      'SELECT COALESCE(SUM(subsidy_sat),0)::bigint s FROM blocks')).rows[0].s);
    if (subsidySum !== supplySat) {
      throw new Error(`reconciliation failed for ${day}: circulating_supply_sat ` +
        `${supplySat} != SUM(blocks.subsidy_sat) ${subsidySum} — refusing to finalize`);
    }
    const rcTol = Math.max(100, Math.abs(realizedCap) * 1e-8);
    if (Math.abs(realizedCap - setRc) > rcTol) {
      throw new Error(`reconciliation failed for ${day}: realized_cap_usd counter ` +
        `${realizedCap} vs live-set sum ${setRc} (tolerance ${rcTol}) — refusing to finalize`);
    }
    const cumCdd = await getState(client, 'cum_cdd');
    const cumVdd = await getState(client, 'cum_vdd_usd');
    const thermocap = await getState(client, 'cum_miner_rev_usd');

    let cumCoindays = await getState(client, 'cum_coindays_created');
    cumCoindays += supplyBtc; // supply-days accrued during this day
    const liveliness = cumCoindays > 0 ? cumCdd / cumCoindays : 0;

    let hodlBank = await getState(client, 'hodl_bank');
    hodlBank += price * (1 - liveliness);
    const reserveRisk = hodlBank > 0 ? price / hodlBank : null;

    const marketCap = supplyBtc * price;
    const realizedPrice = supplyBtc > 0 ? realizedCap / supplyBtc : null;
    const div = (a, b) => (b > 0 ? a / b : null);
    const sthCost = div(sthRc, sthV);
    const lthCost = div(lthRc, lthV);
    const minerRev = Number(blk.minted) * price;
    const transferredPrice = cumCoindays > 0 ? cumVdd / cumCoindays : null;
    const volUsd = Number(f.vol) * price;
    const diff = blk.diff !== null ? Number(blk.diff) : null;
    const hashrateEhs = diff !== null ? diff * 2 ** 32 / 600 / 1e18 : null;
    // Hashprice: what one PH/s earned today. Pre-market days give 0 (rev = 0).
    const hashprice = hashrateEhs > 0 ? minerRev / (hashrateEhs * 1e3) : null;
    const feesUsd = Number(blk.fees) * price;
    // sat/vB over the whole day; NULL unless every block has a recorded weight.
    const dayVsize = blk.wt !== null ? Number(blk.wt) / 4 : null;
    const avgFeerate = dayVsize > 0 ? Number(blk.fees_sat) / dayVsize : null;
    const opReturnFeesUsd = Number(f.oprf) * price;
    // Weighted median acquisition price of the live set, interpolated inside
    // its URPD bucket — so its resolution is the bucket width, stated in the
    // catalog method note.
    let medianCostBasis = null;
    if (urpd && setSupply > 0) {
      let cum = 0;
      for (const bkt of urpd.buckets) {
        if (cum + bkt.v >= setSupply / 2) {
          medianCostBasis = bkt.p + urpd.width * ((setSupply / 2 - cum) / bkt.v);
          break;
        }
        cum += bkt.v;
      }
    }
    // Utilization of consensus capacity (a full pre-SegWit 1 MB block weighs
    // exactly the 4M limit, so the ratio is comparable across eras).
    const blockFullness = blk.wt !== null && Number(blk.nblocks) > 0
      ? Number(blk.wt) / (Number(blk.nblocks) * 4e6) : null;
    // Annualized monetary inflation: claimed subsidy only (fees recycle coins).
    const issuanceRate = supplyBtc > 0 ? Number(blk.subsidy) * 365 / supplyBtc : null;

    // Cointime economics: investor cap strips the miner-earned share out of
    // realized cap; active cap discounts market cap by liveliness (the share
    // of all coin-days ever destroyed). AVIV is their ratio; true market mean
    // is the active-investor cost basis (= price / AVIV).
    const investorCap = realizedCap - thermocap;
    const activeCap = marketCap * liveliness;
    const aviv = investorCap > 0 && activeCap > 0 ? activeCap / investorCap : null;
    const trueMarketMean = aviv !== null ? price / aviv : null;

    const sthNupl = price > 0 && sthCost !== null ? (price - sthCost) / price : null;
    const lthNupl = price > 0 && lthCost !== null ? (price - lthCost) / price : null;
    const sellSideRisk = realizedCap > 0 ? (Number(f.rp) + Number(f.rl)) / realizedCap : null;
    const dormancy = Number(f.vol) > 0 ? Number(f.cdd) / Number(f.vol) : null;
    const terminalPrice = transferredPrice !== null ? transferredPrice * 21 : null;
    // RHODL: realized-cap share held < 1 week vs the 1y–2y band (both already
    // normalized shares of realized cap, so the supply factors cancel).
    const rhodlNum = rcWaves['24h'] + rcWaves['1d–1w'];
    const rhodl = rcWaves['1y–2y'] > 0 ? rhodlNum / rcWaves['1y–2y'] : null;
    const supply1yPlus = ['1y–2y', '2y–3y', '3y–5y', '5y–7y', '7y–10y', '10y+']
      .reduce((a, k) => a + waves[k], 0);

    await client.query(`
      INSERT INTO metrics_daily (day, price, circulating_supply, market_cap, realized_cap,
        realized_price, mvrv, nupl, supply_profit_pct,
        sopr, asopr, sth_sopr, lth_sopr, realized_profit, realized_loss, net_realized_pnl,
        cdd, liveliness, reserve_risk, hodl_waves, rc_hodl_waves,
        sth_supply, lth_supply, sth_cost_basis, lth_cost_basis, sth_mvrv, lth_mvrv,
        miner_rev_usd, fees_pct_rev, hashrate_ehs, difficulty, thermocap, thermocap_multiple,
        balanced_price, transferred_price, nvt, tx_count, transfer_vol_btc, transfer_vol_usd,
        aviv, true_market_mean, sth_nupl, lth_nupl, sell_side_risk, rhodl, dormancy,
        terminal_price, supply_1y_plus_pct, sth_profit_pct, lth_profit_pct, urpd,
        hashprice_usd_ph, fees_usd, avg_feerate, block_fullness_pct, issuance_rate,
        op_return_fees_usd, median_feerate, spent_age_bands, revived_supply_1y,
        miner_outflow_btc, active_addresses, unrealized_profit_usd, unrealized_loss_usd,
        miner_unmoved_supply, median_cost_basis, wholecoiner_count, balance_bands)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
        $22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,
        $40,$41,$42,$43,$44,$45,$46,$47,$48,$49,$50,$51,$52,$53,$54,$55,$56,
        $57,$58,$59,$60,$61,$62,$63,$64,$65,$66,$67,$68)
      ON CONFLICT (day) DO UPDATE SET price=EXCLUDED.price, market_cap=EXCLUDED.market_cap`,
      [day, price, supplyBtc, marketCap, realizedCap,
       realizedPrice, div(marketCap, realizedCap), marketCap > 0 ? (marketCap - realizedCap) / marketCap : null,
       setSupply > 0 ? profitBtc / setSupply : null,
       div(Number(f.sn), Number(f.sd)), div(Number(f.an), Number(f.ad)),
       div(Number(f.stn), Number(f.std)), div(Number(f.ltn), Number(f.ltd)),
       Number(f.rp), Number(f.rl), Number(f.rp) - Number(f.rl),
       Number(f.cdd), liveliness, reserveRisk, JSON.stringify(waves), JSON.stringify(rcWaves),
       sthV, lthV, sthCost, lthCost, div(price, sthCost), div(price, lthCost),
       minerRev, Number(blk.minted) > 0 ? Number(blk.fees) / Number(blk.minted) : null,
       hashrateEhs, diff, thermocap, div(marketCap, thermocap),
       realizedPrice !== null && transferredPrice !== null ? realizedPrice - transferredPrice : null,
       transferredPrice, div(marketCap, volUsd), Number(blk.txs), Number(f.vol), volUsd,
       aviv, trueMarketMean, sthNupl, lthNupl, sellSideRisk, rhodl, dormancy,
       terminalPrice, supply1yPlus, div(sthProfit, sthV), div(lthProfit, lthV),
       urpd ? JSON.stringify(urpd) : null,
       hashprice, feesUsd, avgFeerate, blockFullness, issuanceRate,
       opReturnFeesUsd, medianFeerate,
       spentBands ? JSON.stringify(spentBands) : null, revived1y,
       Number(f.mout), active, unrealProfit, unrealLoss,
       minerUnmoved, medianCostBasis, wholecoinerCount,
       JSON.stringify(balBands)]);

    // The day's active-address staging rows have served their purpose.
    await client.query('DELETE FROM day_active_addresses WHERE day <= $1', [day]);

    // Window-derived metrics need history: compute in one follow-up UPDATE.
    await client.query(`
      UPDATE metrics_daily m SET
        mvrv_z = CASE WHEN s.sd > 0 THEN (m.market_cap - m.realized_cap) / s.sd END,
        cdd_90d_sum = w.cdd90,
        vdd_multiple = CASE WHEN w.vdd365 > 0 THEN w.vdd30 / w.vdd365 END,
        mayer = CASE WHEN w.p200 > 0 THEN m.price / w.p200 END,
        puell = CASE WHEN w.rev365 > 0 THEN m.miner_rev_usd / w.rev365 END,
        nvt_signal = CASE WHEN w.vol90 > 0 THEN m.market_cap / w.vol90 END,
        delta_price = CASE WHEN m.circulating_supply > 0 THEN (m.realized_cap - w.avgcap) / m.circulating_supply END,
        hashrate_30d = w.hr30,
        hashrate_60d = w.hr60
      FROM
        (SELECT COALESCE(STDDEV_POP(market_cap),0) sd FROM metrics_daily WHERE day <= $1) s,
        (SELECT
           (SELECT SUM(cdd) FROM metrics_daily WHERE day > $1::date - 90 AND day <= $1) cdd90,
           (SELECT AVG(vdd) FROM (SELECT COALESCE(SUM(vdd_usd),0) vdd FROM block_agg
              WHERE day > $1::date - 30 AND day <= $1 GROUP BY day) t) vdd30,
           (SELECT AVG(vdd) FROM (SELECT COALESCE(SUM(vdd_usd),0) vdd FROM block_agg
              WHERE day > $1::date - 365 AND day <= $1 GROUP BY day) t) vdd365,
           (SELECT AVG(close_usd) FROM prices WHERE day > $1::date - 200 AND day <= $1) p200,
           (SELECT AVG(miner_rev_usd) FROM metrics_daily WHERE day > $1::date - 365 AND day <= $1) rev365,
           (SELECT AVG(transfer_vol_usd) FROM metrics_daily WHERE day > $1::date - 90 AND day <= $1) vol90,
           (SELECT AVG(market_cap) FROM metrics_daily WHERE day <= $1) avgcap,
           (SELECT AVG(hashrate_ehs) FROM metrics_daily WHERE day > $1::date - 30 AND day <= $1) hr30,
           (SELECT AVG(hashrate_ehs) FROM metrics_daily WHERE day > $1::date - 60 AND day <= $1) hr60
        ) w
      WHERE m.day = $1`, [day]);

    await setState(client, 'cum_coindays_created', cumCoindays);
    await setState(client, 'hodl_bank', hodlBank);
    await setState(client, 'last_metrics_day_epoch', dayEpoch);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }

  log?.info({ day, price }, 'day finalized');
}

// Rewind daily-rollup state after a reorg that crossed a finalized day.
export async function resetRollupFrom(lastGoodDay) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM metrics_daily WHERE day > $1', [lastGoodDay]);
    const r = await client.query(`
      SELECT COALESCE(SUM(circulating_supply),0) cds,
             COALESCE(SUM(price * (1 - COALESCE(liveliness,0))),0) bank,
             COALESCE(MAX(day - '1970-01-01'::date),0) last
      FROM metrics_daily`);
    await setState(client, 'cum_coindays_created', Number(r.rows[0].cds));
    await setState(client, 'hodl_bank', Number(r.rows[0].bank));
    await setState(client, 'last_metrics_day_epoch', Number(r.rows[0].last));
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}
