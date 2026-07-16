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
  {
    slug: 'cost-basis-distribution', column: 'urpd', name: 'Cost Basis Distribution', category: 'valuation', ...num,
    kind: 'urpd',
    short: 'How much supply was acquired at each price level.',
    explain: 'The ledger\'s order book of conviction: every unspent coin stacked at the price it last moved. Dense clusters below spot are support (holders defending profitable positions); heavy supply overhead is resistance (trapped buyers waiting to exit at break-even). Where spot sits inside this terrain matters more than any single average.',
    method: 'The live UTXO set bucketed by creation-day USD close into 100 uniform price bins from $0 to the highest close on record, snapshotted at each UTC day end. Exact, not sampled: every coin is counted.',
  },
  {
    slug: 'true-market-mean', column: 'true_market_mean', columns: ['true_market_mean', 'price'], name: 'True Market Mean', category: 'valuation', ...usd,
    logDefault: true, overlayPrice: true,
    short: 'The cost basis of active investors, with miner coins and dormant history discounted.',
    explain: 'From the cointime framework: strip miner-earned capital out of realized cap (investor cap) and weight supply by how alive it actually is (liveliness), and what remains is the average price paid by investors who are actually in the market. Spot below the true market mean has marked deep-discount regimes; it is the centerline the AVIV ratio oscillates around.',
    method: 'Investor cap ÷ active supply, where investor cap = realized cap − thermocap and active supply = liveliness × circulating supply. Equivalently, price ÷ AVIV.',
  },
  {
    slug: 'aviv', column: 'aviv', name: 'AVIV Ratio', category: 'valuation', ...ratio,
    zones: [
      { from: 0, to: 0.6, label: 'Historically discounted', tone: 'cold' },
      { from: 2.5, to: 6, label: 'Historically stretched', tone: 'hot' },
    ],
    short: 'Active-value to investor-value: price stretched against the true market mean.',
    explain: 'AVIV compares what the active market is worth against the capital active investors actually committed, after removing miner-earned coins and long-dormant history that raw MVRV drags along. That focus makes it the sharper cycle oscillator: readings near historical lows have marked capitulation floors, and multi-year highs have marked distribution tops.',
    method: 'Active cap ÷ investor cap, where active cap = liveliness × market cap and investor cap = realized cap − thermocap.',
  },
  {
    slug: 'terminal-price', column: 'terminal_price', columns: ['terminal_price', 'price'], name: 'Terminal Price', category: 'valuation', ...usd,
    logDefault: true, overlayPrice: true,
    short: 'A cycle-top price model built from cumulative coin-day destruction.',
    explain: 'Terminal price scales transferred price (the time-weighted value at which coins have historically moved) by 21, an empirical multiple that has capped every prior cycle peak. It is a ceiling model: most useful when spot approaches it, historically the zone where old-coin distribution overwhelms fresh demand.',
    method: 'Transferred price × 21, where transferred price is cumulative USD coin-days destroyed ÷ cumulative coin-days created.',
  },
  {
    slug: 'delta-price', column: 'delta_price', columns: ['delta_price', 'price'], name: 'Delta Price', category: 'valuation', ...usd,
    logDefault: true, overlayPrice: true,
    short: 'A bottom model: realized cap minus its own all-time average, per coin.',
    explain: 'Delta price measures how far invested capital (realized cap) sits above the market\'s long-run average valuation. Because both inputs move slowly, it forms a deep floor that spot has only touched at generational bottoms; it is the lower band to terminal price\'s ceiling.',
    method: '(Realized cap − average cap) ÷ circulating supply, where average cap is the cumulative mean of daily market cap since inception.',
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
  {
    slug: 'sell-side-risk', column: 'sell_side_risk', name: 'Sell-Side Risk Ratio', category: 'profitloss', ...pct,
    short: 'Total realized profit and loss as a share of invested capital.',
    explain: 'How much P&L, in either direction, are spenders actually locking in relative to the size of the market? High readings mean heavy repositioning: coins changing hands far from their cost basis, typical of tops and capitulations alike. Very low readings mean equilibrium: coins moving near break-even, the quiet that has preceded major moves.',
    method: '(Realized profit + realized loss) ÷ realized cap, daily.',
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
  {
    slug: 'rhodl', column: 'rhodl', name: 'RHODL Ratio', category: 'behavior', ...num,
    logDefault: true,
    short: 'Capital in week-old coins versus capital in 1y–2y old coins.',
    explain: 'RHODL pits the hottest capital (coins moved within the last week) against the cohort that bought roughly a cycle ago and held. When fresh, expensive supply dwarfs seasoned supply, the market is running on new money: the classic top signature. When the ratio collapses, speculation has drained out and holders dominate the ledger.',
    method: 'Realized-cap share of supply younger than 1 week ÷ realized-cap share aged 1y–2y, from the daily UTXO snapshot.',
  },
  {
    slug: 'dormancy', column: 'dormancy', name: 'Average Dormancy', category: 'behavior', format: 'number', unit: 'days',
    short: 'Average age, in days, of each coin spent today.',
    explain: 'Dormancy is CDD per unit of volume: it strips out how much moved and isolates how old it was. Rising dormancy into a rally means aged coins are taking exit liquidity; low, flat dormancy means churn is dominated by young coins while conviction holds.',
    method: 'Coin days destroyed ÷ transfer volume in BTC, daily.',
  },
  {
    slug: 'supply-1y-plus', column: 'supply_1y_plus_pct', name: 'Supply Last Active 1y+', category: 'behavior', ...pct,
    short: 'Share of all coins that have not moved in at least one year.',
    explain: 'The headline dormancy statistic. This share climbs through bear markets as coins age into strong hands, peaking near cycle bottoms; it falls when rallies finally tempt old coins back into circulation. All-time highs alongside depressed prices describe maximum holder conviction.',
    method: 'Sum of all HODL-wave bands aged one year or older, from the daily UTXO snapshot.',
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
  {
    slug: 'sth-nupl', column: 'sth_nupl', name: 'STH-NUPL', category: 'cohorts', ...ratio,
    zones: [
      { from: -1, to: 0, label: 'Cohort underwater', tone: 'cold' },
      { from: 0.4, to: 1, label: 'Cohort euphoria', tone: 'hot' },
    ],
    short: 'Unrealized profit or loss of coins younger than 155 days.',
    explain: 'Short-term holders are the market\'s marginal sellers, and this is their aggregate paper P&L. Crossings through zero are the market\'s recovery and breakdown lines: above zero the recent buyer is whole and dips get bought; deeply negative readings mean recent buyers are trapped, the precondition for both capitulation and bottom formation.',
    method: '(Price − STH cost basis) ÷ price. Equivalent to 1 − 1/STH-MVRV.',
  },
  {
    slug: 'lth-nupl', column: 'lth_nupl', name: 'LTH-NUPL', category: 'cohorts', ...ratio,
    zones: [
      { from: -1, to: 0, label: 'Veterans underwater', tone: 'cold' },
      { from: 0.75, to: 1, label: 'Euphoria', tone: 'hot' },
    ],
    short: 'Unrealized profit or loss of coins held longer than 155 days.',
    explain: 'The long-term cohort\'s paper P&L moves slowly, which makes its extremes reliable: readings above 0.75 mean veterans sit on enormous unrealized gains, historically preceding distribution. Negative readings, where even the most patient capital is underwater, have marked the terminal phase of every bear market.',
    method: '(Price − LTH cost basis) ÷ price. Equivalent to 1 − 1/LTH-MVRV.',
  },
  {
    slug: 'sth-supply-in-profit', column: 'sth_profit_pct', name: 'STH Supply in Profit', category: 'cohorts', ...pct,
    zones: [
      { from: 0, to: 0.1, label: 'Cohort washed out', tone: 'cold' },
      { from: 0.95, to: 1, label: 'Every recent buyer whole', tone: 'hot' },
    ],
    short: 'The share of short-term holder coins sitting above their cost basis.',
    explain: 'Breadth of profitability among the market\'s most reactive cohort. Readings pinned near zero mean virtually every recent buyer is underwater, the exhaustion condition from which bottoms form; readings above ~95% mean every dip-buyer is being paid, the fuel for momentum and, at extremes, for local tops.',
    method: 'Share of supply younger than 155 days whose creation-day price is below the current close, from the daily UTXO snapshot.',
  },
  {
    slug: 'lth-supply-in-profit', column: 'lth_profit_pct', name: 'LTH Supply in Profit', category: 'cohorts', ...pct,
    short: 'The share of long-term holder coins sitting above their cost basis.',
    explain: 'Long-term holders rarely fall underwater at all; when a meaningful share of this cohort slips into loss, the market has undercut even patient capital, historically the signature of late-stage bear markets and the zone where supply stops responding to price entirely.',
    method: 'Share of supply aged 155 days or more whose creation-day price is below the current close, from the daily UTXO snapshot.',
  },

  // ------------------------------------------------------------ mining
  {
    slug: 'circulating-supply', column: 'circulating_supply', name: 'Circulating Supply', category: 'mining',
    format: 'number', unit: 'BTC',
    // The detail chart can extend this series past the tip on the consensus
    // issuance schedule (?project=1) and mark every halving; see /api/series.
    projection: true,
    short: 'All bitcoin issued to date, with the remaining issuance schedule.',
    explain: 'The supply curve is Bitcoin\'s monetary policy made visible: issuance halves every 210,000 blocks until the last satoshi around 2140, and no discretionary authority can change the path. With the projection on, the chart shows how little supply remains to be mined (well over 90% already circulates) and why each halving structurally tightens the flow of new coins from miners.',
    method: 'Cumulative block subsidies from the daily UTXO-set snapshot. The projection extends the consensus subsidy schedule from the current chain tip until issuance ends (block 6,930,000, around 2141), estimating future dates at 600 seconds per block; halvings are marked at each 210,000-block boundary (dashed markers are estimates).',
  },
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
    slug: 'hashprice', column: 'hashprice_usd_ph', name: 'Hashprice', category: 'mining',
    format: 'number', unit: 'USD/PH/day',
    // First option is the default view; the detail chart offers the rest as a
    // display-only toggle (the column, API, and alerts stay in the first unit).
    unitToggle: [
      { label: 'PH', unit: 'USD/PH/day', factor: 1 },
      { label: 'TH', unit: 'USD/TH/day', factor: 0.001 },
    ],
    logDefault: true,
    short: 'What one petahash of hash power earned per day, in dollars.',
    explain: 'Hashprice is the mining industry\'s revenue benchmark: the daily dollar yield on a unit of hash power. It ties the security budget to miner profitability; when hashprice falls toward the cost of the electricity behind it, inefficient miners shut off (the capitulations hash ribbons detect), and when it rises, new capital flows into securing the network. Halvings cut it structurally, so the long-run decline is expected; the signal is its level relative to miners\' operating costs.',
    method: 'Daily miner revenue (subsidy + fees at the day\'s close) ÷ difficulty-implied hashrate, quoted per PH/s per day. The chart offers a per-TH/s view; stored values are per PH/s.',
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
  {
    slug: 'hash-ribbons', columns: ['hashrate_30d', 'hashrate_60d'], column: 'hashrate_30d',
    name: 'Hash Ribbons', category: 'mining', format: 'number', unit: 'EH/s',
    logDefault: true,
    short: 'Fast and slow hashrate averages: miner capitulation and recovery.',
    explain: 'When the 30-day hashrate average drops below the 60-day, miners are switching machines off; that capitulation has historically clustered near price bottoms, and the recovery cross back above has been one of the strongest long-entry signals across cycles. The ribbon turns hashrate, a security statistic, into a miner-stress indicator.',
    method: '30-day and 60-day simple moving averages of the difficulty-implied hashrate.',
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
