// Finalizes one UTC day of metrics. Called by the sync worker at the exact
// moment the last block of `day` has been applied, so the utxos table is the
// precise end-of-day UTXO set.
import { pool, getState, setState } from './db.js';
import { config } from './config.js';

// Fine-grained age buckets (days). 155 is inserted so STH/LTH cohorts can be
// derived from the same single scan as HODL waves.
const EDGES = [1, 7, 30, 90, 155, 180, 365, 730, 1095, 1825, 2555, 3650];
const WAVE_LABELS = ['24h', '1d–1w', '1w–1m', '1m–3m', '3m–6m', '6m–1y',
  '1y–2y', '2y–3y', '3y–5y', '5y–7y', '7y–10y', '10y+'];
// bucket index -> wave label index (buckets 4 and 5 merge into '3m–6m')
const WAVE_OF = [0, 1, 2, 3, 4, 4, 5, 6, 7, 8, 9, 10, 11];

export async function snapshotAndRollupDay(day, log) {
  const last = await pool.query(`SELECT value FROM chain_state WHERE key='last_metrics_day_epoch'`);
  const lastEpoch = last.rows.length ? Number(last.rows[0].value) : 0;
  const dayEpoch = Date.parse(day + 'T00:00:00Z') / 86400e3;
  if (dayEpoch <= lastEpoch) return; // already finalized (idempotency guard)

  const priceR = await pool.query('SELECT close_usd FROM prices WHERE day=$1', [day]);
  const price = priceR.rows.length ? Number(priceR.rows[0].close_usd) : 0;
  const dayEnd = new Date((dayEpoch + 1) * 86400e3).toISOString();

  // ---- Set-level snapshot: one scan of the live UTXO set -------------------
  const caseExpr = EDGES.map((e, i) =>
    `WHEN age_d < ${e} THEN ${i}`).join(' ') + ` ELSE ${EDGES.length}`;
  const snap = await pool.query(`
    WITH u AS (
      SELECT value_sat, created_price,
             EXTRACT(EPOCH FROM ($1::timestamptz - created_time)) / 86400.0 AS age_d
      FROM utxos WHERE spent_height IS NULL
    )
    SELECT (CASE ${caseExpr} END)::int AS b,
           SUM(value_sat)::numeric / 1e8 AS v_btc,
           SUM(value_sat::numeric / 1e8 * created_price) AS rc_usd,
           COALESCE(SUM(value_sat) FILTER (WHERE created_price < $2), 0)::numeric / 1e8 AS v_profit
    FROM u GROUP BY 1`, [dayEnd, price]);

  let setSupply = 0, setRc = 0, profitBtc = 0;
  let sthV = 0, sthRc = 0, lthV = 0, lthRc = 0, sthProfit = 0, lthProfit = 0;
  const waves = Object.fromEntries(WAVE_LABELS.map(l => [l, 0]));
  const rcWaves = Object.fromEntries(WAVE_LABELS.map(l => [l, 0]));
  for (const r of snap.rows) {
    const b = Number(r.b), v = Number(r.v_btc), rc = Number(r.rc_usd);
    setSupply += v; setRc += rc; profitBtc += Number(r.v_profit);
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

  // ---- Flow rollup from per-block aggregates --------------------------------
  const f = (await pool.query(`
    SELECT COALESCE(SUM(sopr_num),0) sn, COALESCE(SUM(sopr_den),0) sd,
           COALESCE(SUM(asopr_num),0) an, COALESCE(SUM(asopr_den),0) ad,
           COALESCE(SUM(sth_sopr_num),0) stn, COALESCE(SUM(sth_sopr_den),0) std,
           COALESCE(SUM(lth_sopr_num),0) ltn, COALESCE(SUM(lth_sopr_den),0) ltd,
           COALESCE(SUM(realized_profit),0) rp, COALESCE(SUM(realized_loss),0) rl,
           COALESCE(SUM(cdd),0) cdd, COALESCE(SUM(vdd_usd),0) vdd,
           COALESCE(SUM(transfer_vol_sat),0)::numeric / 1e8 vol
    FROM block_agg WHERE day=$1`, [day])).rows[0];

  const blk = (await pool.query(`
    SELECT COALESCE(SUM(tx_count),0) txs,
           COALESCE(SUM(subsidy_sat + fees_sat),0)::numeric / 1e8 minted,
           COALESCE(SUM(fees_sat),0)::numeric / 1e8 fees,
           COALESCE(SUM(fees_sat),0)::numeric fees_sat,
           CASE WHEN COUNT(*) = COUNT(weight) THEN SUM(weight)::numeric END wt,
           MAX(difficulty) diff
    FROM blocks WHERE day=$1`, [day])).rows[0];

  // ---- Running state (chain_state is exactly end-of-day at this call site) --
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const realizedCap = await getState(client, 'realized_cap_usd');
    const supplyBtc = (await getState(client, 'circulating_supply_sat')) / 1e8;
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
        hashprice_usd_ph, fees_usd, avg_feerate)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
        $22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,
        $40,$41,$42,$43,$44,$45,$46,$47,$48,$49,$50,$51,$52,$53,$54)
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
       hashprice, feesUsd, avgFeerate]);

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
