// Future issuance schedule, derived purely from consensus subsidy math
// (blockSubsidySat, the same floor-truncating function the sync worker uses).
// Everything is anchored at the live chain tip (height, timestamp, cumulative
// supply); every point and halving date past the tip is an estimate at the
// 600 s/block difficulty target. Pure functions, no I/O — unit-tested.
import { blockSubsidySat } from './rpc.js';

const HALVING_INTERVAL = 210_000;
const BLOCK_SECONDS = 600;

const dayOfSec = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);

// Sum of block subsidies for heights in (fromHeight, toHeight], per-epoch
// arithmetic so projecting decades ahead stays O(halvings), not O(blocks).
export function issuanceBetweenSat(fromHeight, toHeight) {
  let sum = 0;
  let h = fromHeight + 1;
  while (h <= toHeight) {
    const epochEnd = Math.min(toHeight, (Math.floor(h / HALVING_INTERVAL) + 1) * HALVING_INTERVAL - 1);
    sum += blockSubsidySat(h) * (epochEnd - h + 1);
    h = epochEnd + 1;
  }
  return sum;
}

// Projected supply curve from the tip, sampled every `stepDays` with an exact
// sample at each halving boundary (the curve kinks there), plus a `tailDays`
// runway past the final boundary. By default the horizon runs through the
// halving where the subsidy reaches zero, i.e. until the last new supply has
// hit the market (block 6,930,000, around 2141); pass `halvingsAhead` for a
// shorter fixed horizon. Returns BTC-denominated points and halving markers.
export function projectSupply({
  tipHeight, tipTimeSec, tipSupplySat,
  halvingsAhead = null, tailDays = 365, stepDays = 30,
}) {
  const nextN = Math.floor(tipHeight / HALVING_INTERVAL) + 1;
  let lastN;
  if (halvingsAhead) {
    lastN = nextN + halvingsAhead - 1;
  } else {
    lastN = nextN;
    while (blockSubsidySat(lastN * HALVING_INTERVAL) > 0) lastN++;
  }
  const endHeight = lastN * HALVING_INTERVAL + Math.round(tailDays * 86400 / BLOCK_SECONDS);
  const stepBlocks = Math.round(stepDays * 86400 / BLOCK_SECONDS);

  const heights = new Set([tipHeight, endHeight]);
  for (let h = tipHeight + stepBlocks; h < endHeight; h += stepBlocks) heights.add(h);
  for (let n = nextN; n <= lastN; n++) heights.add(n * HALVING_INTERVAL);

  const points = [...heights].sort((a, b) => a - b).map(h => ({
    day: dayOfSec(tipTimeSec + (h - tipHeight) * BLOCK_SECONDS),
    supply: (tipSupplySat + issuanceBetweenSat(tipHeight, h)) / 1e8,
  }));

  const halvings = [];
  for (let n = nextN; n <= lastN; n++) {
    halvings.push({
      height: n * HALVING_INTERVAL,
      epoch: n + 1, // the epoch that begins at this halving
      day: dayOfSec(tipTimeSec + (n * HALVING_INTERVAL - tipHeight) * BLOCK_SECONDS),
      estimated: true,
    });
  }
  return { points, halvings };
}
