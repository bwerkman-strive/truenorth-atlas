// The metric catalog is the single source of truth for what the platform
// serves: slug -> column(s), category, plain-English explanation, methodology,
// interpretation zones (rendered as chart bands), and display formatting.
//
// Writing style: first sentence answers "what is this?", second answers
// "why should an allocator care?". No jargon without definition.

export const CATEGORIES = [
  { id: 'valuation', name: 'Valuation', blurb: 'Where price sits relative to on-chain cost basis.' },
  { id: 'profitloss', name: 'Profit & Loss', blurb: 'Unrealized and realized investor P&L, straight from the UTXO set.' },
  { id: 'behavior', name: 'Spending & Lifespan', blurb: 'What old and young coins are doing: conviction, distribution, dormancy.' },
  { id: 'cohorts', name: 'Holder Cohorts', blurb: 'Short-term vs long-term holders: supply, cost basis, and stress.' },
  { id: 'mining', name: 'Mining & Security', blurb: 'Miner economics and the security budget behind the ledger.' },
  { id: 'network', name: 'Network Activity', blurb: 'Throughput and economic volume settling on-chain.' },
];

const usd = { format: 'usd' };
const usdC = { format: 'usd_compact' };
const ratio = { format: 'ratio' };
const pct = { format: 'percent' };
const num = { format: 'number' };

export const METRICS = [
  // ------------------------------------------------------------ valuation
  {
    slug: 'price', column: 'price', name: 'BTC Price', category: 'valuation', ...usd,
    logDefault: true,
    short: 'Daily USD closing price of Bitcoin.',
    explain: 'The market price everyone quotes, included here as the baseline every on-chain valuation model is measured against.',
    method: 'Daily close, UTC. All on-chain USD valuations in this platform key each coin to the close of the day it last moved.',
  },
  {
    slug: 'realized-price', column: 'realized_price', columns: ['realized_price', 'price'], name: 'Realized Price', category: 'valuation', ...usd,
    logDefault: true, overlayPrice: true,
    short: 'The average price at which every coin in existence last moved.',
    explain: 'Think of it as the market\'s aggregate cost basis. When spot trades below realized price, the average holder is underwater, historically the signature of bear-market capitulation floors. When spot is far above it, the average holder sits on large unrealized gains.',
    method: 'Realized capitalization ÷ circulating supply. Each unspent output is valued at the USD close of the day it was created; coins that predate a market price carry a cost basis of zero.',
  },
  {
    slug: 'mvrv', column: 'mvrv', name: 'MVRV Ratio', category: 'valuation', ...ratio,
    zones: [
      { from: 0, to: 1, label: 'Below aggregate cost basis', tone: 'cold' },
      { from: 3, to: 10, label: 'Historically elevated', tone: 'hot' },
    ],
    short: 'Market cap divided by realized cap: price vs. aggregate cost basis.',
    explain: 'MVRV measures how far the market has stretched above or below what holders actually paid. Readings under 1 mean the average coin is held at a loss (historically accumulation zones); readings above ~3 have marked every major cycle top. It is the workhorse of on-chain valuation.',
    method: 'Market capitalization ÷ realized capitalization, daily.',
  },
  {
    slug: 'mvrv-z', column: 'mvrv_z', name: 'MVRV Z-Score', category: 'valuation', ...ratio,
    zones: [
      { from: -2, to: 0.1, label: 'Deep value zone', tone: 'cold' },
      { from: 5, to: 12, label: 'Cycle-top zone', tone: 'hot' },
    ],
    short: 'MVRV standardized by the volatility of market cap itself.',
    explain: 'The Z-Score asks: how unusual is today\'s gap between market value and realized value, relative to Bitcoin\'s entire history? Values above ~5 have flagged every cycle peak within weeks; values near or below 0 have marked generational bottoms. Because it is standardized, it is comparable across cycles in a way raw MVRV is not.',
    method: '(Market cap − realized cap) ÷ standard deviation of all historical daily market cap values.',
  },
  {
    slug: 'mayer-multiple', column: 'mayer', name: 'Mayer Multiple', category: 'valuation', ...ratio,
    zones: [
      { from: 0, to: 0.8, label: 'Historically depressed', tone: 'cold' },
      { from: 2.4, to: 5, label: 'Historically stretched', tone: 'hot' },
    ],
    short: 'Price relative to its own 200-day moving average.',
    explain: 'A simple trend gauge: above 1 the market trades over its long-term trend, below 1 under it. Extremes (above ~2.4, below ~0.8) have historically been unsustainable in both directions. Useful as a sanity check alongside cost-basis models.',
    method: 'Daily close ÷ 200-day simple moving average of daily closes.',
  },
  {
    slug: 'thermocap-multiple', column: 'thermocap_multiple', name: 'Thermocap Multiple', category: 'valuation', ...ratio,
    short: 'Market cap as a multiple of all revenue ever paid to miners.',
    explain: 'Thermocap is the cumulative security spend: every dollar of block rewards and fees ever earned by miners. The multiple shows how richly the market is valued against the total capital that has secured it. High multiples have accompanied speculative peaks; low multiples, points of maximum pessimism.',
    method: 'Market cap ÷ cumulative miner revenue in USD (each day\'s issuance and fees valued at that day\'s close).',
  },
  {
    slug: 'balanced-price', column: 'balanced_price', columns: ['balanced_price', 'price'], name: 'Balanced Price', category: 'valuation', ...usd,
    logDefault: true, overlayPrice: true,
    short: 'Realized price minus transferred price: a "fair value" floor model.',
    explain: 'Balanced price subtracts the value time-weighted out of coins (transferred price) from what holders paid (realized price), leaving a conservative estimate of accumulated, un-spent cost basis. Spot touching balanced price has historically coincided with deep bear-market floors.',
    method: 'Realized price − transferred price, where transferred price is cumulative USD-denominated coin-days destroyed ÷ cumulative coin-days created.',
  },
  {
    slug: 'realized-cap', column: 'realized_cap', name: 'Realized Cap', category: 'valuation', ...usdC,
    logDefault: true,
    short: 'The sum of every coin valued at the price it last moved.',
    explain: 'Realized cap is the closest thing Bitcoin has to "capital invested". Unlike market cap, it only rises when coins actually change hands at higher prices, making its growth rate a clean read on real capital inflow, and its drawdowns a read on capital destruction.',
    method: 'Σ (UTXO value × USD close of its creation day) across the entire live UTXO set, maintained incrementally at every block.',
  },
  {
    slug: 'market-cap', column: 'market_cap', name: 'Market Cap', category: 'valuation', ...usdC,
    logDefault: true,
    short: 'Circulating supply times spot price.',
    explain: 'The headline valuation. On its own it says little; its value here is as the numerator against realized cap, thermocap, and on-chain volume in the ratios that follow.',
    method: 'Circulating supply (sum of all coinbase issuance actually claimed) × daily close.',
  },

  // ------------------------------------------------------------ profit & loss
  {
    slug: 'nupl', column: 'nupl', name: 'Net Unrealized Profit/Loss', category: 'profitloss', ...ratio,
    zones: [
      { from: -1, to: 0, label: 'Capitulation', tone: 'cold' },
      { from: 0.5, to: 0.75, label: 'Belief / Greed', tone: 'warm' },
      { from: 0.75, to: 1, label: 'Euphoria', tone: 'hot' },
    ],
    short: 'The share of market cap that is unrealized profit.',
    explain: 'NUPL compresses the psychology of the entire holder base into one number: how much paper gain (or pain) is in the system. Sustained readings above 0.75 have marked euphoric tops; negative readings (the whole market underwater) have marked capitulation bottoms in every cycle.',
    method: '(Market cap − realized cap) ÷ market cap.',
  },
  {
    slug: 'supply-in-profit', column: 'supply_profit_pct', name: 'Supply in Profit', category: 'profitloss', ...pct,
    zones: [
      { from: 0.95, to: 1, label: 'Near-universal profit', tone: 'hot' },
      { from: 0, to: 0.5, label: 'Majority underwater', tone: 'cold' },
    ],
    short: 'Percent of all coins whose cost basis is below the current price.',
    explain: 'A breadth measure of profitability. Above ~95%, nearly every holder is in profit and the incentive to distribute is maximal. Below ~50%, most of the network is underwater, historically where forced sellers exhaust and long-term buyers step in.',
    method: 'Share of unspent supply whose creation-day price is below the current close, measured against the full UTXO set each day.',
  },
  {
    slug: 'sopr', column: 'sopr', name: 'SOPR', category: 'profitloss', ...ratio,
    zones: [{ from: 1, to: 1, label: 'Break-even', tone: 'line' }],
    short: 'Spent Output Profit Ratio: the average profit multiple on coins spent today.',
    explain: 'SOPR compares what spent coins sold for against what they cost. Above 1, the day\'s sellers realized profit; below 1, they realized losses. In bull trends, pullbacks to SOPR = 1 show holders defending their cost basis; in bear trends, SOPR = 1 acts as resistance as trapped holders exit at break-even.',
    method: 'Σ (spent value × spend-day price) ÷ Σ (spent value × creation-day price), all outputs spent that day. Outputs with no market-era cost basis are excluded.',
  },
  {
    slug: 'asopr', column: 'asopr', name: 'Adjusted SOPR', category: 'profitloss', ...ratio,
    zones: [{ from: 1, to: 1, label: 'Break-even', tone: 'line' }],
    short: 'SOPR with sub-1-hour relays filtered out.',
    explain: 'Exchange shuffling and change outputs that move within the hour carry no economic signal. Adjusted SOPR removes them, giving a cleaner read on deliberate investor spending. This is the variant most practitioners watch.',
    method: 'Identical to SOPR, excluding outputs younger than one hour at spend time.',
  },
  {
    slug: 'sth-sopr', column: 'sth_sopr', name: 'Short-Term Holder SOPR', category: 'profitloss', ...ratio,
    zones: [{ from: 1, to: 1, label: 'Break-even', tone: 'line' }],
    short: 'Profit ratio of coins younger than 155 days when spent.',
    explain: 'Short-term holders are the market\'s marginal sellers, and their willingness to sell at a loss (or refusal to) sets local tops and bottoms. STH-SOPR holding above 1 signals dip-buyers defending cost basis; capitulating below 1 marks local flush-outs.',
    method: 'SOPR restricted to spent outputs aged under 155 days.',
  },
  {
    slug: 'lth-sopr', column: 'lth_sopr', name: 'Long-Term Holder SOPR', category: 'profitloss', ...ratio,
    zones: [{ from: 1, to: 1, label: 'Break-even', tone: 'line' }],
    short: 'Profit ratio of coins older than 155 days when spent.',
    explain: 'When long-term holders spend, the profit multiple they realize describes the cycle: high LTH-SOPR means smart money is distributing into strength; LTH-SOPR below 1 (veterans selling at a loss) is rare and has marked the darkest points of bear markets.',
    method: 'SOPR restricted to spent outputs aged 155 days or more.',
  },
  {
    slug: 'realized-pnl', columns: ['realized_profit', 'realized_loss', 'net_realized_pnl'],
    column: 'net_realized_pnl', name: 'Realized Profit & Loss', category: 'profitloss', ...usdC,
    short: 'USD profit and loss actually locked in by spenders each day.',
    explain: 'Where SOPR gives a ratio, this gives magnitude: how many dollars of gain or pain were realized on-chain today. Spikes in realized loss identify capitulation events; sustained heavy realized profit identifies distribution into demand.',
    method: 'For every spent output: value × (spend-day price − creation-day price), summed by sign across each day.',
  },

  // ------------------------------------------------------------ behavior / lifespan
  {
    slug: 'cdd', column: 'cdd', name: 'Coin Days Destroyed', category: 'behavior', ...num,
    short: 'Coin-days spent today: value × how long it sat idle.',
    explain: 'A transfer of 100 BTC that sat for 1,000 days destroys 100,000 coin-days. CDD therefore amplifies the movement of old, high-conviction coins and mutes exchange churn. Sustained CDD spikes mean long-dormant holders are repositioning, which ordinary volume cannot show.',
    method: 'Σ (spent BTC × days since creation) per day, from every spend on-chain.',
  },
  {
    slug: 'liveliness', column: 'liveliness', name: 'Liveliness', category: 'behavior', ...ratio,
    short: 'Cumulative coin-days destroyed as a share of all coin-days ever created.',
    explain: 'Liveliness rises when old coins move and drifts down when the network HODLs. Trend changes matter more than the level: a rising slope during rallies is veteran distribution; a falling slope is accumulation and dormancy building.',
    method: 'Cumulative CDD ÷ cumulative coin-days created (supply integrated over time).',
  },
  {
    slug: 'vdd-multiple', column: 'vdd_multiple', name: 'VDD Multiple', category: 'behavior', ...ratio,
    zones: [
      { from: 0, to: 0.5, label: 'Dormancy / accumulation', tone: 'cold' },
      { from: 2.5, to: 6, label: 'Heavy old-coin distribution', tone: 'hot' },
    ],
    short: 'USD-weighted coin-day destruction, current month vs. trailing year.',
    explain: 'Value Days Destroyed prices each destroyed coin-day in dollars, then compares the last 30 days against the yearly norm. Multiples above ~2.5 show old money exiting at scale (cycle tops); readings pinned below ~0.5 show conviction holding through drawdowns (bottoms).',
    method: '30-day average of (CDD × price) ÷ 365-day average of the same.',
  },
  {
    slug: 'reserve-risk', column: 'reserve_risk', name: 'Reserve Risk', category: 'behavior', ...ratio,
    logDefault: true,
    short: 'Price relative to the accumulated conviction of long-term holders.',
    explain: 'Reserve Risk frames the trade every allocator faces: what are you paying (price) versus how confident are incumbents (the "HODL bank" of foregone selling)? Low readings mean high conviction at low prices, historically the best risk/reward zones. High readings mean confidence is being paid up for.',
    method: 'Price ÷ HODL bank, where the HODL bank accumulates daily price × (1 − liveliness). Published implementations vary slightly; ours is documented in full in the methodology page.',
  },
  {
    slug: 'hodl-waves', column: 'hodl_waves', name: 'HODL Waves', category: 'behavior', format: 'stacked_pct', kind: 'stacked',
    short: 'Supply broken out by how long each coin has sat unmoved.',
    explain: 'The age structure of the ledger. Young bands swell when new money floods in near tops; old bands swell as bear markets age coins into strong hands. Reading the waves tells you which cycle phase the ledger itself says we are in.',
    method: 'Live UTXO set bucketed by age (24h through 10y+) as a share of supply, snapshotted at each UTC day end.',
  },
  {
    slug: 'rc-hodl-waves', column: 'rc_hodl_waves', name: 'Realized Cap HODL Waves', category: 'behavior', format: 'stacked_pct', kind: 'stacked',
    short: 'HODL waves weighted by invested capital instead of coin count.',
    explain: 'Weighting each age band by its USD cost basis shows where the capital, not just the coins, sits. A surge in young, expensive supply means new capital bearing high cost basis dominates: the classic late-cycle fingerprint.',
    method: 'Same age buckets, each UTXO weighted by value × creation-day price, as a share of realized cap.',
  },

  // ------------------------------------------------------------ cohorts
  {
    slug: 'sth-lth-supply', columns: ['sth_supply', 'lth_supply'], column: 'lth_supply',
    name: 'STH / LTH Supply', category: 'cohorts', ...num, kind: 'dual',
    short: 'Coins held by short-term (<155d) vs long-term (≥155d) holders.',
    explain: 'The two-cohort model is the cleanest lens on cycle rotation: LTH supply grows through bear markets (accumulation, coins aging) and is drawn down into bull markets (distribution). STH supply mirrors it, swelling exactly when new demand arrives.',
    method: 'Live UTXO set split at 155 days of age, snapshotted daily. 155 days is the statistical point where spend probability collapses.',
  },
  {
    slug: 'sth-cost-basis', column: 'sth_cost_basis', columns: ['sth_cost_basis', 'price'], name: 'STH Cost Basis', category: 'cohorts', ...usd,
    logDefault: true, overlayPrice: true,
    short: 'Average acquisition price of coins younger than 155 days.',
    explain: 'The short-term holder cost basis is the most important support/resistance level on-chain. In uptrends, price bouncing off it shows recent buyers defending; losing it decisively has preceded every deeper correction, because it flips the marginal buyer underwater.',
    method: 'Σ (value × creation price) ÷ Σ value over UTXOs younger than 155 days.',
  },
  {
    slug: 'lth-cost-basis', column: 'lth_cost_basis', columns: ['lth_cost_basis', 'price'], name: 'LTH Cost Basis', category: 'cohorts', ...usd,
    logDefault: true, overlayPrice: true,
    short: 'Average acquisition price of coins 155 days and older.',
    explain: 'The long-term holder cost basis is the bedrock valuation of the committed base. Spot trading below it (veterans underwater) has occurred only in the terminal phase of bear markets and has historically defined generational accumulation ranges.',
    method: 'Σ (value × creation price) ÷ Σ value over UTXOs aged 155 days or more.',
  },
  {
    slug: 'sth-mvrv', column: 'sth_mvrv', name: 'STH-MVRV', category: 'cohorts', ...ratio,
    zones: [{ from: 1, to: 1, label: 'STH break-even', tone: 'line' }],
    short: 'Price relative to short-term holder cost basis.',
    explain: 'A normalized stress gauge for recent buyers. Above 1, the marginal cohort is in profit and dips get bought; below 1, recent buyers are trapped and rallies get sold. Extremes above ~1.4 have flagged local tops as STH profit-taking incentive peaks.',
    method: 'Price ÷ STH cost basis.',
  },
  {
    slug: 'lth-mvrv', column: 'lth_mvrv', name: 'LTH-MVRV', category: 'cohorts', ...ratio,
    zones: [
      { from: 0, to: 1, label: 'LTH underwater: historic bottoms', tone: 'cold' },
      { from: 3.5, to: 12, label: 'LTH distribution zone', tone: 'hot' },
    ],
    short: 'Price relative to long-term holder cost basis.',
    explain: 'The cycle in one line. LTH-MVRV below 1 has marked every macro bottom; readings above ~3.5 show veterans sitting on multiples that have historically triggered distribution into every cycle top.',
    method: 'Price ÷ LTH cost basis.',
  },

  // ------------------------------------------------------------ mining
  {
    slug: 'puell-multiple', column: 'puell', name: 'Puell Multiple', category: 'mining', ...ratio,
    zones: [
      { from: 0, to: 0.5, label: 'Miner income stress', tone: 'cold' },
      { from: 4, to: 12, label: 'Miner income euphoria', tone: 'hot' },
    ],
    short: 'Daily miner revenue vs. its one-year average.',
    explain: 'Miners are the network\'s structural sellers, and the Puell Multiple measures whether their income is abnormally rich or stressed. Sub-0.5 readings (income collapse) have coincided with every capitulation floor; readings above ~4 with speculative peaks.',
    method: 'Daily USD issuance + fees ÷ 365-day average of the same.',
  },
  {
    slug: 'hashrate', column: 'hashrate_ehs', name: 'Hashrate', category: 'mining', format: 'number', unit: 'EH/s',
    logDefault: true,
    short: 'Estimated network computation securing the chain, in exahashes per second.',
    explain: 'The physical security budget. Sustained hashrate growth reflects long-horizon capital commitment by miners; sharp contractions ("miner capitulation") have historically clustered around cycle bottoms as inefficient operators exit.',
    method: 'Difficulty-implied: difficulty × 2³² ÷ 600 seconds, taken from the day\'s final block.',
  },
  {
    slug: 'difficulty', column: 'difficulty', name: 'Mining Difficulty', category: 'mining', ...num,
    logDefault: true,
    short: 'The protocol-set target that keeps blocks arriving every ~10 minutes.',
    explain: 'Difficulty is the slow, stubborn record of committed mining capital; it only falls when miners physically unplug. Difficulty declines are rare and informative; sustained rises confirm infrastructure buildout.',
    method: 'Consensus difficulty of the last block each day.',
  },
  {
    slug: 'miner-revenue', column: 'miner_rev_usd', name: 'Miner Revenue', category: 'mining', ...usdC,
    logDefault: true,
    short: 'Total USD earned by miners per day (subsidy + fees).',
    explain: 'The daily security spend, and the gross revenue line of the mining industry. Its trend against price tells you whether security is being paid for by issuance dilution or by real fee demand.',
    method: 'Claimed block subsidy plus transaction fees, valued at the day\'s close.',
  },
  {
    slug: 'fees-pct-revenue', column: 'fees_pct_rev', name: 'Fees % of Revenue', category: 'mining', ...pct,
    short: 'The share of miner income paid by users rather than inflation.',
    explain: 'Bitcoin\'s long-term security model requires fees to replace the halving subsidy. This ratio is the single best progress bar on that transition: structurally rising fee share means organic block-space demand is maturing.',
    method: 'Daily fees ÷ (fees + claimed subsidy).',
  },
  {
    slug: 'thermocap', column: 'thermocap', name: 'Thermocap', category: 'mining', ...usdC,
    logDefault: true,
    short: 'Cumulative USD ever paid to miners since genesis.',
    explain: 'The aggregate capital that has purchased Bitcoin\'s security over its entire life: a foundation-level valuation anchor that only ever rises.',
    method: 'Running sum of daily miner revenue in USD.',
  },

  // ------------------------------------------------------------ network
  {
    slug: 'nvt', column: 'nvt', name: 'NVT Ratio', category: 'network', ...ratio,
    short: 'Market cap divided by daily on-chain USD volume: a P/E for the ledger.',
    explain: 'NVT asks whether valuation is supported by settlement activity. High NVT means price has outrun on-chain economic throughput; low NVT means the ledger is doing heavy work relative to its valuation. Best read as a trend rather than a level.',
    method: 'Market cap ÷ daily transfer volume in USD (raw spend volume, coinbase excluded).',
  },
  {
    slug: 'nvt-signal', column: 'nvt_signal', name: 'NVT Signal', category: 'network', ...ratio,
    short: 'NVT computed against smoothed 90-day volume: faster and cleaner.',
    explain: 'Willy Woo\'s refinement of NVT: smoothing the volume denominator turns a laggy valuation ratio into a responsive overbought/oversold oscillator that has flagged local extremes across cycles.',
    method: 'Market cap ÷ 90-day average of daily on-chain USD volume.',
  },
  {
    slug: 'transfer-volume', columns: ['transfer_vol_btc', 'transfer_vol_usd'], column: 'transfer_vol_usd',
    name: 'Transfer Volume', category: 'network', ...usdC,
    logDefault: true,
    short: 'Total value settling on-chain each day.',
    explain: 'The gross settlement throughput of the network. Its trend against price separates rallies carried by real on-chain flow from rallies running on leverage and off-chain churn.',
    method: 'Sum of all non-coinbase spent output values per day, in BTC and USD.',
  },
  {
    slug: 'tx-count', column: 'tx_count', name: 'Transaction Count', category: 'network', ...num,
    short: 'Confirmed transactions per day.',
    explain: 'The bluntest activity gauge, useful mainly for regime context and for spotting demand waves for block space (which show up in fees before anywhere else).',
    method: 'Count of transactions in all blocks per UTC day.',
  },
  {
    slug: 'cdd-90d', column: 'cdd_90d_sum', name: '90-Day CDD', category: 'behavior', ...num,
    short: 'Rolling 90-day sum of coin days destroyed.',
    explain: 'Smoothing CDD over a quarter filters daily noise and exposes regime shifts in old-coin movement: the cleanest single view of whether dormant supply is waking up.',
    method: 'Trailing 90-day sum of daily CDD.',
  },
  {
    slug: 'pricing-models', column: 'price',
    columns: ['price', 'realized_price', 'balanced_price', 'sth_cost_basis'],
    name: 'Price & On-Chain Pricing Models', category: 'valuation',
    format: 'usd', kind: 'multi', logDefault: true,
    zones: [],
    short: 'Spot price against the ledger\'s own valuation floors: realized price, balanced price, and short-term holder cost basis.',
    explain: 'The market price plotted against three prices derived from the chain itself. Realized price is the aggregate cost basis of all coins, historically the bear-market floor. Balanced price subtracts transferred value from realized value, marking deep-capitulation lows. STH cost basis is the average acquisition price of coins younger than 155 days; in uptrends it acts as dynamic support, and losing it has marked regime shifts. Where spot trades relative to these bands is the fastest single read on cycle position.',
    method: 'Spot close vs realized cap ÷ supply, realized − transferred price, and STH-cohort cost basis, daily.',
  },
];

export const bySlug = Object.fromEntries(METRICS.map(m => [m.slug, m]));
