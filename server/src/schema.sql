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
-- Partial index over the live UTXO set: powers supply-in-profit, HODL waves, cohorts.
CREATE INDEX IF NOT EXISTS utxos_unspent_price_idx
  ON utxos (created_price) INCLUDE (value_sat, created_time) WHERE spent_height IS NULL;
CREATE INDEX IF NOT EXISTS utxos_unspent_time_idx
  ON utxos (created_time) INCLUDE (value_sat, created_price) WHERE spent_height IS NULL;
CREATE INDEX IF NOT EXISTS utxos_created_height_idx ON utxos (created_height);
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
  day_offset_seconds BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS block_agg_day_idx ON block_agg(day);

CREATE TABLE IF NOT EXISTS prices (
  day       DATE PRIMARY KEY,
  close_usd NUMERIC NOT NULL
);

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
  transfer_vol_usd   NUMERIC
);

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
