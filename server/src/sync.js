// True North Atlas :: sync worker
//
// Replays the chain from your Bitcoin Core node (getblock verbosity=3, which
// inlines prevout value+height on every input — no txindex required, Core 25+).
//
// Per block it records aggregate deltas (SOPR components, CDD, realized cap
// delta, volume) into block_agg, and maintains the live UTXO set with the USD
// close of each output's creation day as its cost basis.
//
// At every UTC day boundary the worker pauses, snapshots set-level metrics
// (supply in profit, HODL waves, STH/LTH cohorts) — at that instant the UTXO
// table IS the exact end-of-day state — then rolls up flow metrics for the day.
// This yields exact historical series during initial sync, not approximations.
import pino from 'pino';
import { pool, migrate, getState, setState } from './db.js';
import { rpc, fetchBlocks, blockSubsidySat } from './rpc.js';
import { syncPrices, priceForDay, bustPriceCache } from './prices.js';
import { snapshotAndRollupDay, resetRollupFrom } from './metricsDaily.js';
import { config } from './config.js';

const log = pino({ level: process.env.LOG_LEVEL || 'info' });
const SAT = 1e8;
export const dayOf = (epoch) => new Date(epoch * 1000).toISOString().slice(0, 10);

// In-memory height -> {t: epoch, d: day} for pricing spent prevouts without DB lookups.
export const heightMeta = [];

export async function loadHeightMeta() {
  const r = await pool.query(`SELECT height, EXTRACT(EPOCH FROM time)::bigint AS t, day::text AS d
                              FROM blocks ORDER BY height`);
  for (const row of r.rows) heightMeta[row.height] = { t: Number(row.t), d: row.d };
  log.info({ blocks: r.rows.length }, 'loaded block index into memory');
}

export async function tipHeight() {
  const r = await pool.query('SELECT MAX(height) AS h FROM blocks');
  return r.rows[0].h === null ? -1 : Number(r.rows[0].h);
}

// ---------------------------------------------------------------------------
// Reorg handling: verify our stored hash for recent heights against the node;
// if they diverge, roll everything above the fork point back.
export async function checkReorg() {
  const tip = await tipHeight();
  if (tip < 0) return tip;
  for (let h = tip; h > Math.max(-1, tip - config.reorgScanDepth); h--) {
    const ours = await pool.query('SELECT hash FROM blocks WHERE height=$1', [h]);
    const theirs = await rpc.getBlockHash(h).catch(() => null);
    if (theirs && ours.rows[0]?.hash === theirs) return tip; // consistent
    if (theirs && ours.rows[0]?.hash !== theirs) {
      log.warn({ height: h }, 'reorg detected, rolling back');
      await rollbackAbove(h - 1);
      return h - 1;
    }
  }
  return tip;
}

export async function rollbackAbove(height) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sums = await client.query(
      `SELECT COALESCE(SUM(realized_cap_delta),0) AS rc, COALESCE(SUM(cdd),0) AS cdd,
              COALESCE(SUM(vdd_usd),0) AS vdd, COALESCE(SUM(miner_rev_usd),0) AS mrev
       FROM block_agg WHERE height > $1`, [height]);
    const mint = await client.query(
      `SELECT COALESCE(SUM(subsidy_sat),0) AS m FROM blocks WHERE height > $1`, [height]);
    await client.query('DELETE FROM utxos WHERE created_height > $1', [height]);
    await client.query('UPDATE utxos SET spent_height = NULL WHERE spent_height > $1', [height]);
    await client.query('DELETE FROM blocks WHERE height > $1', [height]); // cascades block_agg
    await setState(client, 'realized_cap_usd', await getState(client, 'realized_cap_usd') - Number(sums.rows[0].rc));
    await setState(client, 'cum_cdd', await getState(client, 'cum_cdd') - Number(sums.rows[0].cdd));
    await setState(client, 'cum_vdd_usd', await getState(client, 'cum_vdd_usd') - Number(sums.rows[0].vdd));
    await setState(client, 'cum_miner_rev_usd', await getState(client, 'cum_miner_rev_usd') - Number(sums.rows[0].mrev));
    await setState(client, 'circulating_supply_sat', await getState(client, 'circulating_supply_sat') - Number(mint.rows[0].m));
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  heightMeta.length = height + 1;
  // If the rollback crossed a finalized day, rewind metrics too.
  const lastDay = heightMeta[height]?.d;
  if (lastDay) await resetRollupFrom(lastDay);
}

// ---------------------------------------------------------------------------
// Process one contiguous run of blocks (all same status re: batching) in a txn.
export async function processBlocks(blocks) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const b of blocks) {
      const day = dayOf(b.time);
      const spot = await priceForDay(day);
      const subsidy = blockSubsidySat(b.height);

      // Accumulators for block_agg
      const agg = {
        rcDelta: 0, soprN: 0, soprD: 0, asoprN: 0, asoprD: 0,
        sthN: 0, sthD: 0, lthN: 0, lthD: 0, profit: 0, loss: 0,
        cdd: 0, vdd: 0, volSat: 0,
      };

      // Creation + spend batches for set operations
      const cTxid = [], cVout = [], cVal = [], cCb = [], cAddr = [];
      const sTxid = [], sVout = [];
      let mintedSat = 0, feesSat = 0;

      for (const tx of b.tx) {
        const isCoinbase = tx.vin.length > 0 && tx.vin[0].coinbase !== undefined;
        let inSat = 0, outSat = 0;

        if (!isCoinbase) {
          for (const vin of tx.vin) {
            const p = vin.prevout;
            if (!p) continue;
            const vSat = Math.round(p.value * SAT);
            inSat += vSat;
            const meta = heightMeta[p.height];
            const cTime = meta ? meta.t : b.time;
            const cDay = meta ? meta.d : day;
            const cPrice = await priceForDay(cDay);
            const vBtc = vSat / SAT;
            const ageSec = Math.max(0, b.time - cTime);
            const ageDays = ageSec / 86400;

            agg.volSat += vSat;
            agg.cdd += vBtc * ageDays;
            agg.vdd += vBtc * ageDays * spot;
            agg.rcDelta -= vBtc * cPrice;

            if (cPrice > 0) {
              agg.soprN += vBtc * spot; agg.soprD += vBtc * cPrice;
              if (ageSec >= config.asoprMinAgeSec) { agg.asoprN += vBtc * spot; agg.asoprD += vBtc * cPrice; }
              if (ageDays < config.sthDays) { agg.sthN += vBtc * spot; agg.sthD += vBtc * cPrice; }
              else { agg.lthN += vBtc * spot; agg.lthD += vBtc * cPrice; }
              const pnl = vBtc * (spot - cPrice);
              if (pnl >= 0) agg.profit += pnl; else agg.loss += -pnl;
            }
            sTxid.push(Buffer.from(vin.txid, 'hex'));
            sVout.push(vin.vout);
          }
        }

        for (const vout of tx.vout) {
          if (vout.scriptPubKey?.type === 'nulldata') continue; // provably unspendable
          if (b.height === 0) continue; // genesis output is not spendable / not in the UTXO set
          const vSat = Math.round(vout.value * SAT);
          outSat += vSat;
          cTxid.push(Buffer.from(tx.txid, 'hex'));
          cVout.push(vout.n);
          cVal.push(vSat);
          cCb.push(isCoinbase);
          cAddr.push(vout.scriptPubKey?.address ?? null);
          agg.rcDelta += (vSat / SAT) * spot;
        }

        if (isCoinbase) mintedSat += outSat;
        else feesSat += Math.max(0, inSat - outSat);
      }

      // Insert creations (ON CONFLICT covers the two historic BIP30 duplicate coinbases)
      if (cTxid.length) {
        await client.query(
          `INSERT INTO utxos (txid, vout, value_sat, created_height, created_time, created_price, coinbase, address)
           SELECT t, v, val, $6, to_timestamp($7), $8, cb, addr
           FROM unnest($1::bytea[], $2::int[], $3::bigint[], $4::boolean[], $5::text[]) AS x(t, v, val, cb, addr)
           ON CONFLICT (txid, vout) DO NOTHING`,
          [cTxid, cVout, cVal, cCb, cAddr, b.height, b.time, spot]);
      }
      // Mark spends
      if (sTxid.length) {
        await client.query(
          `UPDATE utxos u SET spent_height = $3
           FROM unnest($1::bytea[], $2::int[]) AS s(t, v)
           WHERE u.txid = s.t AND u.vout = s.v AND u.spent_height IS NULL`,
          [sTxid, sVout, b.height]);
      }

      await client.query(
        `INSERT INTO blocks (height, hash, time, day, tx_count, subsidy_sat, fees_sat, difficulty)
         VALUES ($1,$2,to_timestamp($3),$4,$5,$6,$7,$8)`,
        [b.height, b.hash, b.time, day, b.tx.length, mintedSat - feesSat, feesSat, b.difficulty ?? 0]);

      const minerRevUsd = (mintedSat / SAT) * spot;
      await client.query(
        `INSERT INTO block_agg (height, day, realized_cap_delta, sopr_num, sopr_den, asopr_num, asopr_den,
            sth_sopr_num, sth_sopr_den, lth_sopr_num, lth_sopr_den, realized_profit, realized_loss,
            cdd, vdd_usd, transfer_vol_sat, miner_rev_usd)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [b.height, day, agg.rcDelta, agg.soprN, agg.soprD, agg.asoprN, agg.asoprD,
         agg.sthN, agg.sthD, agg.lthN, agg.lthD, agg.profit, agg.loss,
         agg.cdd, agg.vdd, agg.volSat, minerRevUsd]);

      // Running tip-level counters
      await setState(client, 'realized_cap_usd', await getState(client, 'realized_cap_usd') + agg.rcDelta);
      await setState(client, 'cum_cdd', await getState(client, 'cum_cdd') + agg.cdd);
      await setState(client, 'cum_vdd_usd', await getState(client, 'cum_vdd_usd') + agg.vdd);
      // Issuance = claimed subsidy only; fees in the coinbase are recycled coins.
      await setState(client, 'circulating_supply_sat', await getState(client, 'circulating_supply_sat') + (mintedSat - feesSat));
      await setState(client, 'cum_miner_rev_usd', await getState(client, 'cum_miner_rev_usd') + minerRevUsd);

      heightMeta[b.height] = { t: b.time, d: day };
    }

    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

export async function pruneSpent(tip) {
  await pool.query('DELETE FROM utxos WHERE spent_height IS NOT NULL AND spent_height < $1',
    [tip - config.pruneDepth]);
}

// ---------------------------------------------------------------------------
export async function main() {
  await migrate();
  log.info('schema ready');
  if (process.env.SKIP_PRICE_SYNC !== '1') {
    await syncPrices(log);
    log.info('price history ready');
  }
  await loadHeightMeta();

  let lastPriceSync = Date.now();
  let lastPrune = 0;

  for (;;) {
    try {
      // Refresh prices every 6h so new UTC days have candles.
      if (Date.now() - lastPriceSync > 6 * 3600e3) {
        await syncPrices(log); bustPriceCache(); lastPriceSync = Date.now();
      }

      let ourTip = await checkReorg();
      const info = await rpc.getBlockchainInfo();
      const nodeTip = info.blocks;

      if (ourTip >= nodeTip) {
        // Optional cron-style mode: finish once caught up instead of polling.
        if (process.env.SYNC_EXIT_AT_TIP === '1') return;
        await new Promise(r => setTimeout(r, config.pollIntervalMs));
        continue;
      }

      // Fetch next batch, then split it at UTC day boundaries so we can
      // snapshot the UTXO set exactly at each end-of-day state.
      const from = ourTip + 1;
      const to = Math.min(nodeTip, from + config.syncBatchBlocks - 1);
      const heights = Array.from({ length: to - from + 1 }, (_, i) => from + i);
      const blocks = await fetchBlocks(heights);

      let run = [];
      // Seed from the day of our stored tip so a boundary that falls exactly
      // between two batches is still detected and snapshotted.
      let runDay = ourTip >= 0 ? heightMeta[ourTip]?.d ?? null : null;
      const flush = async () => {
        if (!run.length) return;
        await processBlocks(run);
        run = [];
      };

      for (const b of blocks) {
        const d = dayOf(b.time);
        if (runDay !== null && d !== runDay) {
          await flush();
          // The UTXO set now reflects the exact end of `runDay`: finalize it.
          await snapshotAndRollupDay(runDay, log);
        }
        runDay = d;
        run.push(b);
      }
      await flush();

      if (to === nodeTip) {
        // We are at tip; if the node's tip day differs from the last block's
        // day nothing to do — days finalize when their first next-day block arrives.
        log.info({ tip: to }, 'synced to tip');
      } else if (to % 5000 < config.syncBatchBlocks) {
        log.info({ height: to, nodeTip }, 'initial sync progress');
      }

      if (to - lastPrune > 1000) { await pruneSpent(to); lastPrune = to; }
    } catch (err) {
      log.error({ err: err.message }, 'sync loop error, retrying in 15s');
      await new Promise(r => setTimeout(r, 15000));
    }
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { log.fatal(e); process.exit(1); });
}
