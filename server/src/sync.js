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
import { syncPrices, priceForDay, bustPriceCache, assertNoPriceGaps } from './prices.js';
import { snapshotAndRollupDay, resetRollupFrom, ageBandOf, feerateBucketOf } from './metricsDaily.js';
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
// Single-writer guarantee. Platform deploys overlap (the outgoing instance
// keeps running while the new one boots), and two workers racing the same
// database can pollute day-boundary snapshots and misprice spends through a
// stale in-memory block index. A session-scoped advisory lock serializes
// them: the new instance waits here until the previous one exits. The lock
// lives on a dedicated connection held for the life of the process, and
// Postgres releases it automatically if that session dies.
export const SYNC_LOCK_KEY = 0x41544c53; // 'ATLS'
let lockClient = null;

export async function acquireSyncLock() {
  lockClient = await pool.connect();
  lockClient.on('error', (e) => {
    // The lock rides this session: if the connection is gone the lock is
    // free and another worker could start writing. Exit so the platform
    // restarts us and we re-acquire cleanly.
    log.fatal({ err: e.message }, 'sync write-lock connection lost; exiting');
    process.exit(1);
  });
  const attempt = await lockClient.query(
    'SELECT pg_try_advisory_lock($1) AS ok', [SYNC_LOCK_KEY]);
  if (!attempt.rows[0].ok) {
    log.warn('another sync worker holds the write lock; waiting for it to exit');
    await lockClient.query('SELECT pg_advisory_lock($1)', [SYNC_LOCK_KEY]);
  }
  log.info('single-writer lock acquired');
}

// Test hook: production never releases (process exit does).
export async function releaseSyncLock() {
  if (!lockClient) return;
  await lockClient.query('SELECT pg_advisory_unlock($1)', [SYNC_LOCK_KEY]);
  lockClient.removeAllListeners('error');
  lockClient.release();
  lockClient = null;
}

// ---------------------------------------------------------------------------
// Reorg handling: verify our stored hash for recent heights against the node;
// if they diverge, roll everything above the fork point back.
// onProgress fires per successful node probe: a scan that is merely slow keeps
// the stall watchdog fed, while one whose probes all fail does not.
export async function checkReorg(onProgress) {
  const tip = await tipHeight();
  if (tip < 0) return tip;
  let probeFailures = 0;
  for (let h = tip; h > Math.max(-1, tip - config.reorgScanDepth); h--) {
    const ours = await pool.query('SELECT hash FROM blocks WHERE height=$1', [h]);
    // A failed probe is indistinguishable from "no answer yet", so we keep
    // scanning — but it must not be silent. Each failure can burn the full RPC
    // retry budget, so a dead node turns this loop into reorgScanDepth * that
    // budget of dead air; these warnings are the only trace of it.
    const theirs = await rpc.getBlockHash(h).catch((e) => {
      probeFailures++;
      log.warn({ height: h, probeFailures, err: e.message },
        'reorg probe failed; node unreachable at this height');
      return null;
    });
    if (theirs) onProgress?.();
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
    await client.query('UPDATE utxos SET spent_height = NULL, spent_txid = NULL WHERE spent_height > $1', [height]);
    await client.query('DELETE FROM blocks WHERE height > $1', [height]); // cascades block_agg
    // Active-address staging: a pair first seen only in rolled-back blocks
    // must vanish; one first seen at or below the fork stays (still active).
    await client.query('DELETE FROM day_active_addresses WHERE first_height > $1', [height]);
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
//
// Every write is batched to once per RUN rather than once per block. The old
// per-block form cost ~22 round trips per block (four writes, plus a
// read-modify-write pair for each of the five running counters), which makes
// the worker latency-bound rather than throughput-bound: measured against a
// remote database at 149 ms RTT that alone projected to ~22 days for a full
// replay. Batched, a run costs 8 round trips regardless of how many blocks
// it holds.
//
// Three orderings are load-bearing and deliberately preserved:
//   1. Creations are inserted before spends are marked, so a UTXO created and
//      spent inside the same run still resolves.
//   2. Within the creation array, block order is preserved, so ON CONFLICT DO
//      NOTHING keeps the first occurrence — the BIP30 duplicate-coinbase
//      behavior of the per-block form.
//   3. The counters are written before COMMIT, because snapshotAndRollupDay()
//      runs immediately after the flush and reads chain_state as exact
//      end-of-day state (see metricsDaily.js).
export async function processBlocks(blocks) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Read the running counters once, accumulate in JS, write once at the end.
    // chain_state.value is unconstrained NUMERIC, so a float64 survives the
    // round trip exactly; accumulating in memory in the same order therefore
    // yields bit-identical results to the old per-block read-modify-write.
    const COUNTERS = ['realized_cap_usd', 'cum_cdd', 'cum_vdd_usd',
                      'circulating_supply_sat', 'cum_miner_rev_usd'];
    const state = Object.fromEntries(COUNTERS.map(k => [k, 0])); // missing key => 0, as getState()
    const stateRows = await client.query(
      'SELECT key, value FROM chain_state WHERE key = ANY($1::text[])', [COUNTERS]);
    for (const r of stateRows.rows) state[r.key] = Number(r.value);

    // Run-wide accumulators. created_height/created_time/created_price and
    // spent_height were per-block scalar parameters in the old statements;
    // batched across a run they become per-row columns.
    const cTxid = [], cVout = [], cVal = [], cCb = [], cAddr = [],
          cHeight = [], cTime = [], cPrice = [];
    const sTxid = [], sVout = [], sSpender = [], sHeight = [];
    const bHeight = [], bHash = [], bTime = [], bDay = [], bTxCount = [],
          bSubsidy = [], bFees = [], bDiff = [], bSize = [], bWeight = [];
    const aHeight = [], aDay = [], aRc = [], aSoprN = [], aSoprD = [], aAsoprN = [],
          aAsoprD = [], aSthN = [], aSthD = [], aLthN = [], aLthD = [], aProfit = [],
          aLoss = [], aCdd = [], aVdd = [], aVol = [], aMrev = [],
          aOprFees = [], aOprCount = [], aOprBytes = [], aMinerOut = [],
          aSpentBands = [], aFeeHist = [];

    // Active addresses: first sighting of each (day, address) in this run.
    // Batched into day_active_addresses with ON CONFLICT DO NOTHING, so the
    // earliest height for a pair always wins across runs — which is what makes
    // the rollbackAbove() reversal (DELETE WHERE first_height > H) exact.
    const runAddrs = new Map(); // "day\0address" -> {day, addr, height}
    const seeAddr = (day, addr, height) => {
      if (!addr) return;
      const k = day + '\0' + addr;
      if (!runAddrs.has(k)) runAddrs.set(k, { day, addr, height });
    };

    for (const b of blocks) {
      const day = dayOf(b.time);
      const spot = await priceForDay(day);

      // Accumulators for block_agg
      const agg = {
        rcDelta: 0, soprN: 0, soprD: 0, asoprN: 0, asoprD: 0,
        sthN: 0, sthD: 0, lthN: 0, lthD: 0, profit: 0, loss: 0,
        cdd: 0, vdd: 0, volSat: 0,
        oprFees: 0, oprCount: 0, oprBytes: 0, minerOutSat: 0,
        spentBands: {}, feeHist: {},
      };

      let mintedSat = 0, feesSat = 0;

      for (const tx of b.tx) {
        const isCoinbase = tx.vin.length > 0 && tx.vin[0].coinbase !== undefined;
        let inSat = 0, outSat = 0;
        let hasOpReturn = false, txOprBytes = 0, txOprCount = 0;

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
            const band = ageBandOf(ageDays);
            agg.spentBands[band] = (agg.spentBands[band] ?? 0) + vBtc;
            if (p.generated) agg.minerOutSat += vSat; // spend of a coinbase output

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
            sSpender.push(Buffer.from(tx.txid, 'hex'));
            sHeight.push(b.height);
            seeAddr(day, p.scriptPubKey?.address, b.height); // sender
          }
        }

        for (const vout of tx.vout) {
          if (b.height === 0) continue; // genesis output is not spendable / not in the UTXO set
          const vSat = Math.round(vout.value * SAT);
          // OP_RETURN outputs are provably unspendable: no UTXO row, but their
          // value DOES count toward outputs (a nonzero-value OP_RETURN burns
          // coins, it does not tip the miner), and their payload is tallied.
          if (vout.scriptPubKey?.type === 'nulldata') {
            outSat += vSat;
            hasOpReturn = true;
            txOprCount += 1;
            txOprBytes += (vout.scriptPubKey?.hex?.length ?? 0) / 2;
            continue;
          }
          outSat += vSat;
          cTxid.push(Buffer.from(tx.txid, 'hex'));
          cVout.push(vout.n);
          cVal.push(vSat);
          cCb.push(isCoinbase);
          cAddr.push(vout.scriptPubKey?.address ?? null);
          cHeight.push(b.height);
          cTime.push(b.time);
          cPrice.push(spot);
          agg.rcDelta += (vSat / SAT) * spot;
          seeAddr(day, vout.scriptPubKey?.address, b.height); // receiver
        }

        if (isCoinbase) {
          mintedSat += outSat;
        } else {
          const fee = Math.max(0, inSat - outSat);
          feesSat += fee;
          if (hasOpReturn) {
            agg.oprFees += fee; // whole-tx fee attribution, the standard convention
            agg.oprCount += txOprCount;
            agg.oprBytes += txOprBytes;
          }
          const vsize = tx.vsize ?? (tx.weight ? tx.weight / 4 : null);
          if (vsize > 0) {
            const bucket = feerateBucketOf(fee / vsize);
            agg.feeHist[bucket] = (agg.feeHist[bucket] ?? 0) + 1;
          }
        }
      }

      bHeight.push(b.height); bHash.push(b.hash); bTime.push(b.time); bDay.push(day);
      bTxCount.push(b.tx.length); bSubsidy.push(mintedSat - feesSat); bFees.push(feesSat);
      bDiff.push(b.difficulty ?? 0); bSize.push(b.size ?? null); bWeight.push(b.weight ?? null);

      const minerRevUsd = (mintedSat / SAT) * spot;
      aHeight.push(b.height); aDay.push(day); aRc.push(agg.rcDelta);
      aSoprN.push(agg.soprN); aSoprD.push(agg.soprD);
      aAsoprN.push(agg.asoprN); aAsoprD.push(agg.asoprD);
      aSthN.push(agg.sthN); aSthD.push(agg.sthD);
      aLthN.push(agg.lthN); aLthD.push(agg.lthD);
      aProfit.push(agg.profit); aLoss.push(agg.loss);
      aCdd.push(agg.cdd); aVdd.push(agg.vdd); aVol.push(agg.volSat); aMrev.push(minerRevUsd);
      aOprFees.push(agg.oprFees); aOprCount.push(agg.oprCount); aOprBytes.push(agg.oprBytes);
      aMinerOut.push(agg.minerOutSat);
      aSpentBands.push(Object.keys(agg.spentBands).length ? JSON.stringify(agg.spentBands) : null);
      aFeeHist.push(Object.keys(agg.feeHist).length ? JSON.stringify(agg.feeHist) : null);

      // Running tip-level counters, accumulated in the same per-block order the
      // old code applied them in.
      state.realized_cap_usd += agg.rcDelta;
      state.cum_cdd += agg.cdd;
      state.cum_vdd_usd += agg.vdd;
      // Issuance = claimed subsidy only; fees in the coinbase are recycled coins.
      state.circulating_supply_sat += (mintedSat - feesSat);
      state.cum_miner_rev_usd += minerRevUsd;

      heightMeta[b.height] = { t: b.time, d: day };
    }

    // ---- batched writes: creations before spends (see ordering note above) --
    // ON CONFLICT covers the two historic BIP30 duplicate coinbases; array
    // order is block order, so the first occurrence wins as it did per-block.
    if (cTxid.length) {
      await client.query(
        `INSERT INTO utxos (txid, vout, value_sat, created_height, created_time, created_price, coinbase, address)
         SELECT t, v, val, h, to_timestamp(ts), pr, cb, addr
         FROM unnest($1::bytea[], $2::int[], $3::bigint[], $4::boolean[], $5::text[],
                     $6::int[], $7::bigint[], $8::numeric[]) AS x(t, v, val, cb, addr, h, ts, pr)
         ON CONFLICT (txid, vout) DO NOTHING`,
        [cTxid, cVout, cVal, cCb, cAddr, cHeight, cTime, cPrice]);
    }
    if (sTxid.length) {
      await client.query(
        `UPDATE utxos u SET spent_height = s.h, spent_txid = s.sp
         FROM unnest($1::bytea[], $2::int[], $3::bytea[], $4::int[]) AS s(t, v, sp, h)
         WHERE u.txid = s.t AND u.vout = s.v AND u.spent_height IS NULL`,
        [sTxid, sVout, sSpender, sHeight]);
    }
    if (bHeight.length) {
      await client.query(
        `INSERT INTO blocks (height, hash, time, day, tx_count, subsidy_sat, fees_sat, difficulty, size_bytes, weight)
         SELECT h, hs, to_timestamp(t), d::date, tc, sub, f, diff, sz, w
         FROM unnest($1::int[], $2::text[], $3::bigint[], $4::text[], $5::int[], $6::bigint[],
                     $7::bigint[], $8::numeric[], $9::int[], $10::int[])
              AS x(h, hs, t, d, tc, sub, f, diff, sz, w)`,
        [bHeight, bHash, bTime, bDay, bTxCount, bSubsidy, bFees, bDiff, bSize, bWeight]);

      await client.query(
        `INSERT INTO block_agg (height, day, realized_cap_delta, sopr_num, sopr_den, asopr_num, asopr_den,
            sth_sopr_num, sth_sopr_den, lth_sopr_num, lth_sopr_den, realized_profit, realized_loss,
            cdd, vdd_usd, transfer_vol_sat, miner_rev_usd,
            op_return_fees_sat, op_return_count, op_return_bytes, miner_outflow_sat,
            spent_age_bands, feerate_hist)
         SELECT h, d::date, rc, sn, sd, an, ad, stn, std, ltn, ltd, pf, ls, cd, vd, vol, mrev,
                oprf, oprc, oprb, mout, bands, hist
         FROM unnest($1::int[], $2::text[], $3::numeric[], $4::numeric[], $5::numeric[],
                     $6::numeric[], $7::numeric[], $8::numeric[], $9::numeric[], $10::numeric[],
                     $11::numeric[], $12::numeric[], $13::numeric[], $14::numeric[],
                     $15::numeric[], $16::bigint[], $17::numeric[],
                     $18::bigint[], $19::int[], $20::bigint[], $21::bigint[],
                     $22::jsonb[], $23::jsonb[])
              AS x(h, d, rc, sn, sd, an, ad, stn, std, ltn, ltd, pf, ls, cd, vd, vol, mrev,
                   oprf, oprc, oprb, mout, bands, hist)`,
        [aHeight, aDay, aRc, aSoprN, aSoprD, aAsoprN, aAsoprD, aSthN, aSthD,
         aLthN, aLthD, aProfit, aLoss, aCdd, aVdd, aVol, aMrev,
         aOprFees, aOprCount, aOprBytes, aMinerOut, aSpentBands, aFeeHist]);
    }

    // Active-address sightings for this run (senders + receivers). ON CONFLICT
    // keeps the earliest first_height per (day, address) across runs.
    if (runAddrs.size) {
      const dDay = [], dAddr = [], dHeight = [];
      for (const { day, addr, height } of runAddrs.values()) {
        dDay.push(day); dAddr.push(addr); dHeight.push(height);
      }
      await client.query(
        `INSERT INTO day_active_addresses (day, address, first_height)
         SELECT d::date, a, h FROM unnest($1::text[], $2::text[], $3::int[]) AS x(d, a, h)
         ON CONFLICT (day, address) DO NOTHING`,
        [dDay, dAddr, dHeight]);
    }

    // Counters last, but still inside the transaction: the day snapshot that
    // follows this flush reads them as exact end-of-day state.
    await client.query(
      `INSERT INTO chain_state(key, value)
       SELECT k, v FROM unnest($1::text[], $2::numeric[]) AS x(k, v)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [COUNTERS, COUNTERS.map(k => state[k])]);

    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

export async function pruneSpent(tip) {
  await pool.query('DELETE FROM utxos WHERE spent_height IS NOT NULL AND spent_height < $1',
    [tip - config.pruneDepth]);
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Stall watchdog. A Tor circuit that dies mid-replay leaves the transport
// erroring (or hanging) while the loop's retry-forever design keeps the
// process alive, so from outside the worker looks healthy but synced height
// freezes. Rather than trying to heal a wedged Tor daemon in-process, exit:
// the platform restarts background workers, and a fresh container bootstraps
// fresh circuits. touch() marks progress; onStall fires once idle exceeds
// thresholdMs. thresholdMs <= 0 disables (returns inert handles).
export function createStallWatchdog({ thresholdMs, checkEveryMs = 60_000, onStall }) {
  if (!(thresholdMs > 0)) return { touch: () => {}, stop: () => {} };
  let last = Date.now();
  const timer = setInterval(() => {
    const idleMs = Date.now() - last;
    if (idleMs > thresholdMs) onStall(idleMs);
  }, checkEveryMs);
  timer.unref(); // never hold the process open on its own
  return { touch: () => { last = Date.now(); }, stop: () => clearInterval(timer) };
}

// ---------------------------------------------------------------------------
// Phase instrumentation. The loop between "loaded block index into memory" and
// a watchdog exit used to emit nothing at all, so a stall gave no clue which
// stage it died in — RPC, a DB transaction, or a day snapshot all look
// identical from outside. Every stage now runs inside phase(), which keeps a
// stack of what is currently in flight so the watchdog's fatal log can name it.
const phaseStack = [];

// "fetchBlocks" or, when nested, "batch > snapshotDay". null when idle.
export function inFlightPhase() {
  return phaseStack.length ? phaseStack.map(p => p.name).join(' > ') : null;
}

// How long the innermost in-flight stage has been running (null when idle).
export function inFlightPhaseMs() {
  return phaseStack.length ? Date.now() - phaseStack[phaseStack.length - 1].t0 : null;
}

// Healthy stages log at debug to keep replay quiet; anything past
// syncSlowPhaseMs escalates to info so a developing stall is visible before
// the watchdog fires. Failures always log — this is the path that used to
// swallow everything.
export async function phase(name, fields, fn) {
  const entry = { name, t0: Date.now() };
  phaseStack.push(entry);
  try {
    const out = await fn();
    const ms = Date.now() - entry.t0;
    log[ms >= config.syncSlowPhaseMs ? 'info' : 'debug']({ phase: name, ms, ...fields }, 'phase done');
    return out;
  } catch (err) {
    log.warn({ phase: name, ms: Date.now() - entry.t0, ...fields, err: err.message }, 'phase failed');
    throw err;
  } finally {
    phaseStack.pop();
  }
}

export async function main() {
  await acquireSyncLock(); // before any write, including migrate
  await migrate();
  log.info('schema ready');
  if (process.env.SKIP_PRICE_SYNC !== '1') {
    await syncPrices(log);
    await assertNoPriceGaps(); // a hole poisons cost bases; refuse to start over one
    log.info('price history ready');
  }
  await loadHeightMeta();

  let lastPriceSync = Date.now();
  let lastPrune = 0;

  // Armed after boot (lock wait and initial price backfill are legitimately
  // slow); from here on, a loop pass must succeed every syncStallExitMs.
  const watchdog = createStallWatchdog({
    thresholdMs: config.syncStallExitMs,
    onStall: (idleMs) => {
      // phase/phaseMs name the stage that actually wedged, which is the whole
      // reason this log exists — idleMs alone never identified the culprit.
      log.fatal({ idleMs, phase: inFlightPhase(), phaseMs: inFlightPhaseMs() },
        'no sync progress within the stall window; exiting for a clean restart');
      process.exit(1);
    },
  });

  for (;;) {
    try {
      // Refresh prices every 6h so new UTC days have candles.
      if (Date.now() - lastPriceSync > 6 * 3600e3) {
        await phase('syncPrices', {}, async () => {
          await syncPrices(log); await assertNoPriceGaps();
          bustPriceCache(); lastPriceSync = Date.now();
        });
      }

      let ourTip = await phase('checkReorg', {}, () => checkReorg(watchdog.touch));
      const info = await phase('getBlockchainInfo', {}, () => rpc.getBlockchainInfo());
      watchdog.touch(); // the node answered: transport is alive
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
      const blocks = await phase('fetchBlocks', { from, to },
        () => fetchBlocks(heights, watchdog.touch));

      let run = [];
      // Seed from the day of our stored tip so a boundary that falls exactly
      // between two batches is still detected and snapshotted.
      let runDay = ourTip >= 0 ? heightMeta[ourTip]?.d ?? null : null;
      const flush = async () => {
        if (!run.length) return;
        const span = { from: run[0].height, to: run[run.length - 1].height };
        await phase('processBlocks', span, () => processBlocks(run));
        run = [];
        watchdog.touch(); // blocks are committed: real, durable progress
      };

      for (const b of blocks) {
        const d = dayOf(b.time);
        if (runDay !== null && d !== runDay) {
          await flush();
          // The UTXO set now reflects the exact end of `runDay`: finalize it.
          await phase('snapshotDay', { day: runDay }, () => snapshotAndRollupDay(runDay, log));
          watchdog.touch(); // a full-UTXO-set snapshot is slow but is progress
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

      if (to - lastPrune > 1000) {
        await phase('pruneSpent', { to }, () => pruneSpent(to));
        lastPrune = to;
      }
      watchdog.touch(); // full batch (fetch, process, snapshots) landed
    } catch (err) {
      log.error({ err: err.message }, 'sync loop error, retrying in 15s');
      await new Promise(r => setTimeout(r, 15000));
    }
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { log.fatal(e); process.exit(1); });
}
