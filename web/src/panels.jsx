// Registry of panel kinds: the catalog kinds that render their own chart form
// (see kinds.js) mapped to a component, the API endpoint that feeds it, the
// headline/takeaway builder, and the page chrome it wants. MetricDetail
// branches on this table instead of on kind names.
//
//   Chart      component receiving { data, logScale, metricName }
//   endpoint   /api/<endpoint>
//   headline   (data) => { value, sub, takeaway, asOf } | null (null = empty)
//   scale      whether the Linear/Log toggle applies
//   layout     'tiles' renders in its own group (each tile carries a
//              watermark); default renders inside the single chart box
//   watermark  'corner' moves the exported watermark to the plot's lower
//              right (the on-screen one moves via CSS); default centred
import BottomsChart from './components/BottomsChart.jsx';
import RalliesChart from './components/RalliesChart.jsx';
import RunsChart from './components/RunsChart.jsx';
import UnderwaterChart from './components/UnderwaterChart.jsx';
import ScorecardChart from './components/ScorecardChart.jsx';
import HeatmapChart from './components/HeatmapChart.jsx';
import ClockChart from './components/ClockChart.jsx';
import PnlChart from './components/PnlChart.jsx';
import HandoffChart from './components/HandoffChart.jsx';
import MinersChart from './components/MinersChart.jsx';
import DipBuyersChart from './components/DipBuyersChart.jsx';
import ReturnsGrid from './components/ReturnsGrid.jsx';
import SameHourChart from './components/SameHourChart.jsx';
import DaysSinceChart from './components/DaysSinceChart.jsx';
import { HEADLINES } from './panelHeadlines.js';

export const PANELS = {
  bottoms: {
    Chart: BottomsChart, endpoint: 'bottoms', headline: HEADLINES.bottoms, scale: true, layout: 'tiles',
    loading: 'Aligning cycle lows…', empty: 'No completed bear market in the finalized history yet.',
  },
  rallies: {
    Chart: RalliesChart, endpoint: 'rallies', headline: HEADLINES.rallies, scale: true,
    loading: 'Measuring bear-market rallies…', empty: 'No completed bear market in the finalized history yet.',
  },
  runs: {
    Chart: RunsChart, endpoint: 'runs', headline: HEADLINES.runs, scale: true,
    loading: 'Aligning recoveries on their lows…', empty: 'No completed cycle low in the finalized history yet.',
  },
  underwater: {
    Chart: UnderwaterChart, endpoint: 'underwater', headline: HEADLINES.underwater, scale: false,
    loading: 'Measuring the drawdown…', empty: 'No finalized price history yet.',
  },
  scorecard: {
    Chart: ScorecardChart, endpoint: 'scorecard', headline: HEADLINES.scorecard, scale: false, watermark: 'corner',
    loading: 'Compiling the scorecard…', empty: 'No completed cycle in the finalized history yet.',
  },
  heatmap: {
    Chart: HeatmapChart, endpoint: 'heatmap', headline: HEADLINES.heatmap, scale: false,
    loading: 'Mapping sixteen years of cost basis…', empty: 'No finalized cost-basis distribution yet.',
  },
  clock: {
    Chart: ClockChart, endpoint: 'clock', headline: HEADLINES.clock, scale: false, watermark: 'corner',
    loading: 'Winding the clock…', empty: 'No epoch with MVRV history yet.',
  },
  pnl: {
    Chart: PnlChart, endpoint: 'pnl', headline: HEADLINES.pnl, scale: false,
    loading: 'Tallying realized profit and loss…', empty: 'No realized profit or loss yet.',
  },
  handoff: {
    Chart: HandoffChart, endpoint: 'handoff', headline: HEADLINES.handoff, scale: false,
    loading: 'Splitting the cohorts…', empty: 'No cohort supply yet.',
  },
  miners: {
    Chart: MinersChart, endpoint: 'miners', headline: HEADLINES.miners, scale: true,
    loading: 'Reading the hash ribbons…', empty: 'No hashrate history yet.',
  },
  dipbuyers: {
    Chart: DipBuyersChart, endpoint: 'dipbuyers', headline: HEADLINES.dipbuyers, scale: false, watermark: 'corner',
    loading: 'Comparing balance bands…', empty: 'No open cycle low to measure from yet.',
  },
  returns: {
    Chart: ReturnsGrid, endpoint: 'returns', headline: HEADLINES.returns, scale: false, watermark: 'corner',
    loading: 'Laying out the calendar…', empty: 'No monthly closes yet.',
  },
  samehour: {
    Chart: SameHourChart, endpoint: 'samehour', headline: HEADLINES.samehour, scale: false,
    loading: 'Finding the same hour in earlier epochs…', empty: 'No earlier epoch to compare with yet.',
  },
  dayssince: {
    Chart: DaysSinceChart, endpoint: 'dayssince', headline: HEADLINES.dayssince, scale: false, watermark: 'corner',
    loading: 'Counting the days…', empty: 'No price history yet.',
  },
};
