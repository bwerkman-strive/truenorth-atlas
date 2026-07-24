-- True North Atlas :: schema
-- Design notes:
--  * utxos is the full UTXO lifecycle table. Spent rows keep spent_height so recent
--    blocks can be rolled back on reorg; rows spent deeper than PRUNE_DEPTH are deleted.
--  * block_agg stores per-block aggregate deltas (rollback-safe by height).
--  * metrics_daily is the wide, query-ready output table served by the API.

CREATE TABLE IF NOT EXISTS chain_state (
  key   TEXT PRIMARY KEY,
  value NUMERIC NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS blocks (
  height     INTEGER PRIMARY KEY,
  hash       TEXT NOT NULL,
  time       TIMESTAMPTZ NOT NULL,
  day        DATE NOT NULL,
  tx_count   INTEGER NOT NULL,
  subsidy_sat BIGINT NOT NULL,
  fees_sat   BIGINT NOT NULL,
  difficulty NUMERIC NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS blocks_day_idx ON blocks(day);

CREATE TABLE IF NOT EXISTS utxos (
  txid          BYTEA   NOT NULL,
  vout          INTEGER NOT NULL,
  value_sat     BIGINT  NOT NULL,
  created_height INTEGER NOT NULL,
  created_time  TIMESTAMPTZ NOT NULL,
  created_price NUMERIC NOT NULL,          -- USD close of creation day
  coinbase      BOOLEAN NOT NULL DEFAULT FALSE,
  address       TEXT,                       -- NULL for non-standard scripts
  spent_height  INTEGER,                    -- NULL = unspent
  PRIMARY KEY (txid, vout)
);
-- Explorer: current balance / UTXO listing per address.
-- (ALTER ... IF NOT EXISTS migrates databases created before the explorer existed.)
ALTER TABLE utxos ADD COLUMN IF NOT EXISTS address TEXT;
CREATE INDEX IF NOT EXISTS utxos_address_live
  ON utxos (address) WHERE spent_height IS NULL AND address IS NOT NULL;
-- Explorer: block size/weight on summaries (recorded going forward, lazily
-- backfilled from RPC on view for blocks synced before these columns), and
-- spend attribution so spent outputs link to their spending tx within the
-- PRUNE_DEPTH retention window. rollbackAbove() must clear spent_txid in the
-- same statement that clears spent_height.
ALTER TABLE blocks ADD COLUMN IF NOT EXISTS size_bytes INTEGER;
ALTER TABLE blocks ADD COLUMN IF NOT EXISTS weight INTEGER;
ALTER TABLE utxos ADD COLUMN IF NOT EXISTS spent_txid BYTEA;
-- Partial index over the live UTXO set: powers supply-in-profit, HODL waves, cohorts.
-- TEMPORARILY DISABLED while the 2026-07 full-chain replay runs. These three
-- indexes are read only by the once-per-day snapshot but evict the hot
-- utxos_pkey from shared_buffers, slowing ingestion ~6x, and because
-- migrate() re-runs this file on every api/worker start, leaving them here
-- resurrects them (with a table-locking plain CREATE INDEX) on every deploy.
-- When the replay reaches tip: build them by hand with CREATE INDEX
-- CONCURRENTLY (same definitions), then uncomment these statements.
-- CREATE INDEX IF NOT EXISTS utxos_unspent_price_idx
--   ON utxos (created_price) INCLUDE (value_sat, created_time) WHERE spent_height IS NULL;
-- CREATE INDEX IF NOT EXISTS utxos_unspent_time_idx
--   ON utxos (created_time) INCLUDE (value_sat, created_price) WHERE spent_height IS NULL;
-- CREATE INDEX IF NOT EXISTS utxos_created_height_idx ON utxos (created_height);
CREATE INDEX IF NOT EXISTS utxos_spent_height_idx   ON utxos (spent_height) WHERE spent_height IS NOT NULL;

-- Per-block spend/creation aggregates (all deltas, so a reorg rollback is
-- simply "delete rows above height H and un-spend / delete UTXOs").
CREATE TABLE IF NOT EXISTS block_agg (
  height            INTEGER PRIMARY KEY REFERENCES blocks(height) ON DELETE CASCADE,
  day               DATE NOT NULL,
  -- realized cap delta (USD): +value*price for creations, -value*created_price for spends
  realized_cap_delta NUMERIC NOT NULL DEFAULT 0,
  -- SOPR components (USD): spent value at spend price / at creation price
  sopr_num          NUMERIC NOT NULL DEFAULT 0,
  sopr_den          NUMERIC NOT NULL DEFAULT 0,
  asopr_num         NUMERIC NOT NULL DEFAULT 0,  -- excludes outputs younger than 1h
  asopr_den         NUMERIC NOT NULL DEFAULT 0,
  sth_sopr_num      NUMERIC NOT NULL DEFAULT 0,  -- age < 155d
  sth_sopr_den      NUMERIC NOT NULL DEFAULT 0,
  lth_sopr_num      NUMERIC NOT NULL DEFAULT 0,  -- age >= 155d
  lth_sopr_den      NUMERIC NOT NULL DEFAULT 0,
  realized_profit   NUMERIC NOT NULL DEFAULT 0,  -- USD
  realized_loss     NUMERIC NOT NULL DEFAULT 0,  -- USD (positive number)
  cdd               NUMERIC NOT NULL DEFAULT 0,  -- coin-days destroyed (BTC*days)
  vdd_usd           NUMERIC NOT NULL DEFAULT 0,  -- CDD * spend-day price
  transfer_vol_sat  BIGINT  NOT NULL DEFAULT 0,  -- non-coinbase spend volume
  miner_rev_usd     NUMERIC,                     -- coinbase reward (subsidy+fees) × close; reverses cum_miner_rev_usd on reorg
  day_offset_seconds BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS block_agg_day_idx ON block_agg(day);
ALTER TABLE block_agg ADD COLUMN IF NOT EXISTS miner_rev_usd NUMERIC;

CREATE TABLE IF NOT EXISTS prices (
  day       DATE PRIMARY KEY,
  close_usd NUMERIC NOT NULL
);

-- Backfill block_agg rows synced before miner_rev_usd existed (no-op once
-- filled; a row whose day has no finalized close yet stays NULL and is picked
-- up on a later run). Lives below prices, which it joins.
UPDATE block_agg a
SET miner_rev_usd = (b.subsidy_sat + b.fees_sat) / 1e8 * p.close_usd
FROM blocks b JOIN prices p ON p.day = b.day
WHERE b.height = a.height AND a.miner_rev_usd IS NULL;

CREATE TABLE IF NOT EXISTS metrics_daily (
  day                DATE PRIMARY KEY,
  price              NUMERIC,
  circulating_supply NUMERIC,      -- BTC
  market_cap         NUMERIC,      -- USD
  realized_cap       NUMERIC,      -- USD
  realized_price     NUMERIC,
  mvrv               NUMERIC,
  mvrv_z             NUMERIC,
  nupl               NUMERIC,
  supply_profit_pct  NUMERIC,      -- 0..1
  sopr               NUMERIC,
  asopr              NUMERIC,
  sth_sopr           NUMERIC,
  lth_sopr           NUMERIC,
  realized_profit    NUMERIC,
  realized_loss      NUMERIC,
  net_realized_pnl   NUMERIC,
  cdd                NUMERIC,
  cdd_90d_sum        NUMERIC,
  liveliness         NUMERIC,
  vdd_multiple       NUMERIC,
  reserve_risk       NUMERIC,
  hodl_waves         JSONB,        -- {bucket: pct_of_supply}
  rc_hodl_waves      JSONB,        -- realized-cap weighted
  sth_supply         NUMERIC,      -- BTC, age < 155d
  lth_supply         NUMERIC,
  sth_cost_basis     NUMERIC,      -- USD (STH realized price)
  lth_cost_basis     NUMERIC,
  sth_mvrv           NUMERIC,
  lth_mvrv           NUMERIC,
  puell              NUMERIC,
  mayer              NUMERIC,
  miner_rev_usd      NUMERIC,
  fees_pct_rev       NUMERIC,
  hashrate_ehs       NUMERIC,      -- EH/s (difficulty-implied)
  difficulty         NUMERIC,
  thermocap          NUMERIC,      -- cumulative miner revenue USD
  thermocap_multiple NUMERIC,
  balanced_price     NUMERIC,
  transferred_price  NUMERIC,
  nvt                NUMERIC,
  nvt_signal         NUMERIC,
  tx_count           INTEGER,
  transfer_vol_btc   NUMERIC,
  transfer_vol_usd   NUMERIC,
  aviv               NUMERIC,      -- active cap / investor cap (Cointime)
  true_market_mean   NUMERIC,      -- USD; investor cap / active supply
  sth_nupl           NUMERIC,
  lth_nupl           NUMERIC,
  sell_side_risk     NUMERIC,      -- (realized profit + loss) / realized cap
  rhodl              NUMERIC,      -- RCap-HODL <1w band / 1y-2y band
  dormancy           NUMERIC,      -- days; CDD / transfer volume
  terminal_price     NUMERIC,      -- USD; 21 x transferred price
  delta_price        NUMERIC,      -- USD; (realized cap - average cap) / supply
  hashrate_30d       NUMERIC,      -- EH/s, 30d SMA (hash ribbons)
  hashrate_60d       NUMERIC,      -- EH/s, 60d SMA (hash ribbons)
  hashprice_usd_ph   NUMERIC,      -- USD earned per PH/s per day (miner revenue / hashrate)
  fees_usd           NUMERIC,      -- total transaction fees per day, valued at the close
  avg_feerate        NUMERIC,      -- sat/vB; day fees / day vsize (NULL if any block lacks weight)
  supply_1y_plus_pct NUMERIC,      -- 0..1, share of supply dormant >= 1y
  sth_profit_pct     NUMERIC,      -- 0..1, share of STH supply in profit
  lth_profit_pct     NUMERIC,      -- 0..1, share of LTH supply in profit
  urpd               JSONB         -- cost-basis distribution {width, top, buckets:[{p,v}]}
);
-- Tier-1 metric additions (idempotent migration for databases created before them)
ALTER TABLE metrics_daily ADD COLUMN IF NOT EXISTS aviv NUMERIC;
ALTER TABLE metrics_daily ADD COLUMN IF NOT EXISTS true_market_mean NUMERIC;
ALTER TABLE metrics_daily ADD COLUMN IF NOT EXISTS sth_nupl NUMERIC;
ALTER TABLE metrics_daily ADD COLUMN IF NOT EXISTS lth_nupl NUMERIC;
ALTER TABLE metrics_daily ADD COLUMN IF NOT EXISTS sell_side_risk NUMERIC;
ALTER TABLE metrics_daily ADD COLUMN IF NOT EXISTS rhodl NUMERIC;
ALTER TABLE metrics_daily ADD COLUMN IF NOT EXISTS dormancy NUMERIC;
ALTER TABLE metrics_daily ADD COLUMN IF NOT EXISTS terminal_price NUMERIC;
ALTER TABLE metrics_daily ADD COLUMN IF NOT EXISTS delta_price NUMERIC;
ALTER TABLE metrics_daily ADD COLUMN IF NOT EXISTS hashrate_30d NUMERIC;
ALTER TABLE metrics_daily ADD COLUMN IF NOT EXISTS hashrate_60d NUMERIC;
ALTER TABLE metrics_daily ADD COLUMN IF NOT EXISTS supply_1y_plus_pct NUMERIC;
ALTER TABLE metrics_daily ADD COLUMN IF NOT EXISTS sth_profit_pct NUMERIC;
ALTER TABLE metrics_daily ADD COLUMN IF NOT EXISTS lth_profit_pct NUMERIC;
ALTER TABLE metrics_daily ADD COLUMN IF NOT EXISTS urpd JSONB;
ALTER TABLE metrics_daily ADD COLUMN IF NOT EXISTS hashprice_usd_ph NUMERIC;
ALTER TABLE metrics_daily ADD COLUMN IF NOT EXISTS fees_usd NUMERIC;
ALTER TABLE metrics_daily ADD COLUMN IF NOT EXISTS avg_feerate NUMERIC;

-- Backfill hashprice for days finalized before the column existed. Pure
-- derivation of two already-populated columns, so this is a no-op once filled
-- (pre-market days come out 0, which is the intended economics).
UPDATE metrics_daily
SET hashprice_usd_ph = miner_rev_usd / (hashrate_ehs * 1e3)
WHERE hashprice_usd_ph IS NULL AND miner_rev_usd IS NOT NULL AND hashrate_ehs > 0;

-- Backfill fee metrics for days finalized before the columns existed, straight
-- from blocks + prices (no chain refetch). Pre-market days come out 0 in USD,
-- the same zero-basis economics as everywhere else. avg_feerate stays NULL for
-- a day unless every one of its blocks has a recorded weight; the fees_usd
-- IS NULL gate makes this a no-op once filled.
UPDATE metrics_daily m
SET fees_usd    = b.fees_btc * p.close_usd,
    avg_feerate = CASE WHEN b.wt > 0 THEN b.fees_sat / (b.wt / 4.0) END
FROM (SELECT day,
             SUM(fees_sat)::numeric                                 AS fees_sat,
             SUM(fees_sat)::numeric / 1e8                           AS fees_btc,
             CASE WHEN COUNT(*) = COUNT(weight)
                  THEN SUM(weight)::numeric END                     AS wt
      FROM blocks GROUP BY day) b
JOIN prices p ON p.day = b.day
WHERE b.day = m.day AND m.fees_usd IS NULL;

-- Seed persistent counters
INSERT INTO chain_state(key, value) VALUES
  ('realized_cap_usd', 0),
  ('cum_cdd', 0),
  ('cum_coindays_created', 0),
  ('cum_miner_rev_usd', 0),
  ('cum_vdd_usd', 0),
  ('hodl_bank', 0)
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Private explorer API keys. Only the SHA-256 of a key is stored; the
-- plaintext is shown exactly once at creation.
CREATE TABLE IF NOT EXISTS api_keys (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  key_hash      BYTEA NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at    TIMESTAMPTZ,
  last_used_at  TIMESTAMPTZ,
  request_count BIGINT NOT NULL DEFAULT 0
);
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS created_by TEXT;

-- Named administrators. The ADMIN_TOKEN environment variable is the "root"
-- credential (established by whoever controls the deployment); root mints
-- per-person admin tokens here. Admin tokens manage API keys but cannot
-- create or revoke other admins — that power stays with root.
CREATE TABLE IF NOT EXISTS admins (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  token_hash    BYTEA NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    TEXT NOT NULL DEFAULT 'root',
  revoked_at    TIMESTAMPTZ,
  last_used_at  TIMESTAMPTZ
);

-- ---------------------------------------------------------------------------
-- Metric alerts: "email me when MVRV-Z crosses 5". Double-opt-in (confirm
-- token emailed via Resend), one-click unsubscribe, crossing-detection so an
-- alert fires once per threshold cross, not daily while the condition holds.
CREATE TABLE IF NOT EXISTS alerts (
  id             SERIAL PRIMARY KEY,
  email          TEXT NOT NULL,
  metric_slug    TEXT NOT NULL,
  condition      TEXT NOT NULL CHECK (condition IN ('above','below')),
  threshold      NUMERIC NOT NULL,
  confirm_hash   BYTEA NOT NULL UNIQUE,   -- sha256 of the emailed confirm token
  unsub_token    TEXT  NOT NULL UNIQUE,   -- stable; links in old emails must keep working
  confirmed_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  unsubscribed_at TIMESTAMPTZ,
  last_fired_day DATE                      -- last day this alert sent an email
);
CREATE INDEX IF NOT EXISTS alerts_active ON alerts (metric_slug)
  WHERE confirmed_at IS NOT NULL AND unsubscribed_at IS NULL;

-- ---------------------------------------------------------------------------
-- Full audit trail: EVERY email the platform sends is recorded here, success
-- or failure, with the provider's message id. Nothing sends outside this path.
CREATE TABLE IF NOT EXISTS email_log (
  id          BIGSERIAL PRIMARY KEY,
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  recipient   TEXT NOT NULL,
  subject     TEXT NOT NULL,
  kind        TEXT NOT NULL,   -- alert_confirm | alert_fire | subscribe_confirm | newsletter | newsletter_test
  ref_id      INTEGER,         -- alert id / newsletter id when applicable
  status      TEXT NOT NULL CHECK (status IN ('sent','failed')),
  provider_id TEXT,            -- Resend message id
  error       TEXT
);
CREATE INDEX IF NOT EXISTS email_log_recent ON email_log (sent_at DESC);

-- Newsletter subscribers (double opt-in, stable unsubscribe token).
CREATE TABLE IF NOT EXISTS subscribers (
  id              SERIAL PRIMARY KEY,
  email           TEXT NOT NULL,
  confirm_hash    BYTEA NOT NULL UNIQUE,
  unsub_token     TEXT  NOT NULL UNIQUE,
  confirmed_at    TIMESTAMPTZ,
  unsubscribed_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS subscribers_active_email
  ON subscribers (email) WHERE unsubscribed_at IS NULL;

-- Newsletters: drafted by admins, charts attached by slug, scheduled sends.
CREATE TABLE IF NOT EXISTS newsletters (
  id            SERIAL PRIMARY KEY,
  subject       TEXT NOT NULL,
  preheader     TEXT,
  body_md       TEXT NOT NULL DEFAULT '',
  charts        TEXT[] NOT NULL DEFAULT '{}',   -- metric slugs -> embedded OG cards
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','sending','sent')),
  scheduled_at  TIMESTAMPTZ,
  sent_at       TIMESTAMPTZ,
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_count    INTEGER NOT NULL DEFAULT 0,
  failed_count  INTEGER NOT NULL DEFAULT 0
);
