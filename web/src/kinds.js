// Catalog kinds that render their own chart form instead of a scalar time
// series. Mirrors PANEL_KINDS in server/src/catalog.js (a web test checks the
// two lists agree) so the overview, the newsletter composer and the metric
// page can branch on one predicate.
export const PANEL_KINDS = ['stacked', 'urpd', 'bottoms', 'rallies', 'runs', 'underwater', 'scorecard', 'heatmap', 'clock',
  'pnl', 'handoff', 'miners', 'dipbuyers', 'returns', 'samehour', 'dayssince'];
export const isPanelKind = (kind) => PANEL_KINDS.includes(kind);

// What the overview card says in place of a latest value.
export const CARD_LABEL = {
  stacked: 'View bands →',
  urpd: 'View distribution →',
  bottoms: 'Compare cycle lows →',
  rallies: 'View bear rallies →',
  runs: 'Compare recoveries →',
  underwater: 'See the drawdown →',
  scorecard: 'Open the scorecard →',
  heatmap: 'Explore the terrain →',
  clock: 'Read the clock →',
  pnl: 'See profit and loss →',
  handoff: 'Watch the handoff →',
  miners: 'See the episodes →',
  dipbuyers: 'See who bought →',
  returns: 'Open the grid →',
  samehour: 'Compare the hour →',
  dayssince: 'Read the counters →',
};
