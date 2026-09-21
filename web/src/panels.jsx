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
import BottomsChart from './components/BottomsChart.jsx';
import RalliesChart from './components/RalliesChart.jsx';
import RunsChart from './components/RunsChart.jsx';
import UnderwaterChart from './components/UnderwaterChart.jsx';
import ScorecardChart from './components/ScorecardChart.jsx';
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
    Chart: ScorecardChart, endpoint: 'scorecard', headline: HEADLINES.scorecard, scale: false,
    loading: 'Compiling the scorecard…', empty: 'No completed cycle in the finalized history yet.',
  },
};
