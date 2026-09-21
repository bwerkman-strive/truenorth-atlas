// Known data-quality windows in the daily close series.
//
// Finalized closes are immutable (invariant 11), so a bad stretch in the
// historical backfill cannot be quietly rewritten; correcting it means a
// deliberate revision plus a chain resync from that date. Until that happens,
// computations that scan history for extremes can consult this register and
// say so in their method copy. Deleting an entry once the closes are fixed is
// the whole lifecycle. Never use this to alter or hide the stored prices.
export const BAD_CLOSE_WINDOWS = [
  {
    from: '2014-02-05',
    to: '2014-02-27',
    reason: 'CryptoCompare backfill reflects Mt. Gox prices during the exchange\'s collapse '
      + '(closes $111 to $430 against a ~$570 market)',
  },
];

export const isFlaggedClose = (day, windows = BAD_CLOSE_WINDOWS) =>
  windows.some(w => day >= w.from && day <= w.to);
