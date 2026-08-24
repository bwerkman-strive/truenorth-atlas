// Central configuration. Every tunable lives in an environment variable so the
// same image runs locally, on Render, or anywhere else without code changes.
const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
const int = (k, d) => parseInt(env(k, String(d)), 10);
const bool = (k, d) => ['1', 'true', 'yes', 'on'].includes(String(env(k, d ? 'true' : 'false')).toLowerCase());

export const config = {
  // --- Postgres ---
  databaseUrl: env('DATABASE_URL', 'postgres://localhost:5432/atlas'),
  pgSsl: env('PGSSLMODE', 'require') !== 'disable', // Render Postgres needs SSL

  // --- Bitcoin Core JSON-RPC (your node) ---
  rpcUrl: env('BITCOIN_RPC_URL', 'http://127.0.0.1:8332'),
  rpcUser: env('BITCOIN_RPC_USER', ''),
  rpcPass: env('BITCOIN_RPC_PASSWORD', ''),
  rpcTimeoutMs: int('BITCOIN_RPC_TIMEOUT_MS', 120000),
  // Optional SOCKS5 proxy for reaching the node. Two providers, both bundled
  // in Dockerfile.worker and started by worker-entrypoint.sh when their env
  // is set:
  //   Tor       — TOR_SOCKS_PROXY=socks5h://127.0.0.1:9050 (.onion nodes)
  //   Tailscale — RPC_SOCKS_PROXY=socks5h://127.0.0.1:1055 (tailnet nodes,
  //               requires TAILSCALE_AUTHKEY; see README pattern 3)
  // The 'h' scheme resolves names through the proxy — required for .onion
  // and for tailnet MagicDNS names. RPC_SOCKS_PROXY is the generic knob and
  // wins when both are set; TOR_SOCKS_PROXY also tells the entrypoint to
  // start the Tor daemon, so clear it when switching to Tailscale.
  rpcSocksProxy: env('RPC_SOCKS_PROXY', env('TOR_SOCKS_PROXY', '')),
  rpcMaxRetries: int('RPC_MAX_RETRIES', 4),

  // --- Price history provider ---
  // 'cryptocompare' (full history to 2010, free key recommended) or 'coinbase' (2015+)
  priceProvider: env('PRICE_PROVIDER', 'cryptocompare'),
  cryptocompareApiKey: env('CRYPTOCOMPARE_API_KEY', ''),
  cryptocompareBaseUrl: env('CRYPTOCOMPARE_BASE_URL', 'https://min-api.cryptocompare.com'),
  coinbaseBaseUrl: env('COINBASE_BASE_URL', 'https://api.exchange.coinbase.com'),
  // Massive (formerly Polygon.io): institutional consolidated feed. When a key
  // is present it becomes the canonical daily-close source from
  // massiveCryptoStart forward AND powers the live /api/spot price; the
  // CryptoCompare path remains solely as deep-history backfill (2010–start).
  massiveApiKey: env('MASSIVE_API_KEY', ''),
  massiveBaseUrl: env('MASSIVE_BASE_URL', 'https://api.massive.com'),
  massiveCryptoStart: env('MASSIVE_CRYPTO_START', '2015-01-01'),
  spotCacheMs: int('SPOT_CACHE_MS', 30000),

  // --- Sync worker tuning ---
  syncBatchBlocks: int('SYNC_BATCH_BLOCKS', 25),      // blocks per DB transaction
  rpcConcurrency: int('RPC_CONCURRENCY', 4),          // parallel getblock calls
  pruneDepth: int('PRUNE_DEPTH', 144),                // keep spent UTXOs this many blocks for reorg safety
  reorgScanDepth: int('REORG_SCAN_DEPTH', 12),
  pollIntervalMs: int('POLL_INTERVAL_MS', 30000),     // tip poll cadence once synced
  // Exit (for a platform restart with a fresh Tor daemon) after this long
  // without a successful sync-loop pass. 0 disables the watchdog.
  syncStallExitMs: int('SYNC_STALL_EXIT_MS', 30 * 60000),
  // A sync stage slower than this logs at info instead of debug, so a stall
  // announces itself while it is still developing.
  syncSlowPhaseMs: int('SYNC_SLOW_PHASE_MS', 60000),
  sthDays: int('STH_THRESHOLD_DAYS', 155),            // short/long-term holder boundary
  asoprMinAgeSec: int('ASOPR_MIN_AGE_SECONDS', 3600), // adjusted SOPR: ignore < 1h relays

  // --- API server ---
  port: int('PORT', 8080),
  corsOrigin: env('CORS_ORIGIN', '*'),                // set to https://tnorth.com in prod
  apiCacheSeconds: int('API_CACHE_SECONDS', 300),
  statusCacheSeconds: int('STATUS_CACHE_SECONDS', 30), // /api/status only: header sync counter wants freshness

  // --- Shareable chart cards / alerts / links ---
  publicSiteUrl: env('PUBLIC_SITE_URL', 'https://atlas.tnorth.com'), // the frontend
  publicApiUrl: env('PUBLIC_API_URL', ''),                            // this API's own origin (for links in emails/OG)
  resendApiKey: env('RESEND_API_KEY', ''),
  resendBaseUrl: env('RESEND_BASE_URL', 'https://api.resend.com'),    // overridable for tests
  alertsFromEmail: env('ALERTS_FROM_EMAIL', 'Atlas Alerts <alerts@tnorth.com>'),
  alertsCheckIntervalMs: int('ALERTS_CHECK_INTERVAL_MS', 15 * 60 * 1000),
  // Signup kill switches — OFF by default. These gate NEW signups only:
  // unsubscribe links, pending confirmations, and alerts already confirmed
  // keep working regardless, so flipping these never strands anyone.
  alertSignupEnabled: bool('ALERT_SIGNUP_ENABLED', false),
  newsletterSignupEnabled: bool('NEWSLETTER_SIGNUP_ENABLED', false),
  publicRateLimit: int('PUBLIC_RATE_LIMIT_PER_MIN', 60), // free explorer, per IP/min; 0 disables
};
