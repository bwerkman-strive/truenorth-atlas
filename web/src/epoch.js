// Epoch math for the True North Atlas mark.
//
// The logo's orbiting coin is data-driven: its position on the outer ring is
// the chain's progress through the current halving epoch (210,000 blocks).
// Pure functions, no DOM — the same math the header renders is what the unit
// tests verify.

export const BLOCKS_PER_EPOCH = 210_000;

// height -> { epoch (1-based), progress [0,1), blocksIn, blocksLeft }
export function epochInfo(height) {
  if (height === null || height === undefined || height < 0 || !Number.isFinite(Number(height))) {
    return null;
  }
  const h = Math.floor(Number(height));
  const epoch = Math.floor(h / BLOCKS_PER_EPOCH) + 1;
  const blocksIn = h % BLOCKS_PER_EPOCH;
  return {
    epoch,
    blocksIn,
    blocksLeft: BLOCKS_PER_EPOCH - blocksIn,
    progress: blocksIn / BLOCKS_PER_EPOCH,
  };
}

// progress [0,1] -> coin coordinates on a ring. 0 = true north (top), clockwise.
export function coinXY(progress, cx = 120, cy = 120, r = 94) {
  const theta = (progress ?? 0) * 2 * Math.PI;
  return {
    x: cx + r * Math.sin(theta),
    y: cy - r * Math.cos(theta),
  };
}

// Human line for tooltips: "Epoch 5 · 47.3% complete · 110,657 blocks to the halving"
export function epochLabel(height) {
  const e = epochInfo(height);
  if (!e) return 'True North Atlas';
  return `Epoch ${e.epoch} · ${(e.progress * 100).toFixed(1)}% complete · ` +
    `${e.blocksLeft.toLocaleString('en-US')} blocks to the halving`;
}
