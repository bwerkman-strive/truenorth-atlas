# AGENTS.md — True North Atlas

Bitcoin on-chain analytics platform + block explorer + private API + email
platform. Node.js monorepo: `server/` (Express API + chain-sync worker,
Postgres) and `web/` (Vite 8 + React 18 + recharts SPA). Deployed on Render via
`render.yaml`: the API and the sync worker both run on Render's Docker runtime
sharing `server/Dockerfile.worker` (bundled Tor daemon, so either can reach
the node's .onion RPC); the worker can instead run on a LAN host near the
Bitcoin Core node (Start9, Core 25+, no txindex needed).

## Commands

```bash
# Server (Node >= 20)
cd server && npm ci
npm run test:unit                      # no database needed
docker compose up -d db                # scratch Postgres on :5433 (repo root)
#   no Docker? scripts/scratch-db.sh start|stop gives the same DB via
#   Homebrew postgresql@16 (auto-installs nothing; prints install hint)
DATABASE_URL=postgres://atlas:atlas@localhost:5433/atlas_test PGSSLMODE=disable npm test
npm run test:coverage                  # same env; line/branch report
npm run migrate                        # apply src/schema.sql (idempotent)
npm start                              # API on :8080
npm run worker                         # chain sync (needs BITCOIN_RPC_* env)

# Web
cd web && npm ci
npm test                               # node:test, no DOM needed
npm run dev                            # :5173, proxies /api -> :8080
npm run build                          # -> dist/  (ALWAYS run after UI changes)
```

`/verify` and `/add-metric <name>` slash commands exist in `.claude/commands/`
for Claude Code. Integration tests TRUNCATE their tables — always point `DATABASE_URL` at a
scratch database, never at real data. Integration files must run serially
(`--test-concurrency=1`, already set in the npm script) because they share the
database.

## Architecture map

```
server/src/
  config.js        every env var, with defaults — add new config HERE only
  schema.sql       single migration file; idempotent (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS)
  db.js            pool, migrate(), chain_state key/value helpers
  rpc.js           Bitcoin Core JSON-RPC (getblock verbosity=3; optional Tor via TOR_SOCKS_PROXY)
  sync.js          the worker: UTXO ingestion, reorg rollback, day-boundary snapshots
  metricsDaily.js  end-of-UTC-day UTXO-set snapshot -> metrics_daily row (~40 metrics)
  prices.js        daily closes (Massive canonical 2015->, CryptoCompare 2010–2015 backfill,
                   pre-market zero-fill) + getSpot() live price (Massive last-trade, cached)
  catalog.js       SINGLE SOURCE OF TRUTH for metrics (slug/column/zones/copy)
  api.js           read API, /api/status, /api/series, /api/cycles, /api/spot, mounts
  explorer.js      block/tx/address lookups (DB-first, RPC-enriched), search, rate limiter
  keys.js          root/admin auth (adminAuth middleware), API-key CRUD, requireApiKey for /v1
  og.js            1200x630 share cards (SVG->sharp PNG) + /share/:slug crawler pages
  email.js         sendEmail() — THE ONLY email path (audited) + renderEmail template + mdLite
  alerts.js        metric alerts: double opt-in, crossing detection, checker
  newsletters.js   subscriber list, composer/scheduler endpoints, processNewsletters, email-log
server/test/       unit.*.test.js (no DB) and integration.*.test.js (real Postgres + mock HTTP providers)
server/Dockerfile.worker     Render Docker image shared by atlas-sync AND atlas-api: node:22-slim + Tor daemon
server/worker-entrypoint.sh  waits for Tor bootstrap (skipped if TOR_SOCKS_PROXY unset), then execs its
                             args — default node src/sync.js; atlas-api passes node src/api.js
web/src/
  api.js           API client; format.js pure formatters; epoch.js pure halving math
  App.jsx          hash router (#/, #/m/:slug, #/explorer, #/b|tx|a/:x, #/admin), header, footer
  theme.css        entire design system incl. responsive layer — no CSS frameworks
  components/      EpochRings (the living logo), BearingDial, AlertForm, SubscribeForm, NewsletterTab
  pages/           Overview, MetricDetail (timeline/cycles views), Explorer, Admin
```

## Invariants — do not break these

1. **One email path.** All outbound email goes through `email.js sendEmail()`,
   which writes `email_log` before returning. Never call Resend directly; the
   audit trail is complete by construction and tested.
2. **Daily closes are canonical.** Every metric and every cost basis uses the
   `prices` table (finalized UTC daily closes). `getSpot()` is display-only.
   Pre-market days (2009-01-03 .. 2010-07-16) are zero — economically correct;
   don't "fix" them.
3. **Reorg safety.** Spent UTXOs are retained `PRUNE_DEPTH` (144) blocks;
   `block_agg` per-block deltas must stay exactly reversible — any new running
   counter in `chain_state` needs a matching reversal in `rollbackAbove()`.
4. **The catalog drives everything.** Adding a metric = a column in
   `metrics_daily` (schema.sql), the computation in `metricsDaily.js`, and one
   entry in `catalog.js`. API, overview card, bearing dial, sparkline, detail
   chart, OG card, and alerts all follow automatically.
   `unit.catalog.test.js` statically verifies every referenced column exists.
5. **Docs cannot drift.** `web/src/apiReference.js` example responses are
   compared key-for-key against live API output in
   `integration.explorer.test.js`. Change a serializer -> update the reference.
6. **Unsubscribe tokens are stable for life** (plaintext `unsub_token`
   columns). Old emails' links must keep working. Confirm tokens are hashed and
   single-use.
7. **Signup kill switches** (`ALERT_SIGNUP_ENABLED`, `NEWSLETTER_SIGNUP_ENABLED`,
   default OFF) gate NEW signups only — unsubscribes, pending confirmations,
   and confirmed alerts always work.
8. **Privilege tiers:** root (`ADMIN_TOKEN` env) manages admins; named admins
   (`tn_admin_…`) manage API keys/newsletters but not admins; API keys
   (`tn_live_…`) authenticate `/v1`. Only hashes of secrets are stored (except
   unsub tokens, see #6).
9. **SQL identifier safety.** Any dynamic column name in SQL must be validated
   against `IDENT_RE` / come from the catalog. Values always go through
   parameters.
10. **Halving constants** exist in `api.js` (HALVINGS dates) and `web/src/epoch.js`
    (210,000-block math) — keep them consistent if touched.
11. **Integrity gates fail loud, never degrade silently** (born of the
    2015-08-26 price-gap incident, which poisoned a full replay). Finalized
    daily closes are immutable (`upsertPrices` refuses revisions); the worker
    refuses to sync over a price gap, zero, or implausible jump
    (`assertNoPriceGaps`); day finalization reconciles the running counters
    against independent recomputation and throws on mismatch; corrupt block
    data (missing prevouts, outputs > inputs) rejects the block; provisional
    tip-day cost bases are re-stamped at the finalized close. A halt means
    the books do not balance — investigate, never bypass the gate to "get it
    moving again". `integration.integrity.test.js` enforces all of this.

## Conventions

- **Tests:** node's built-in `node:test`. External providers (Resend, Massive,
  CryptoCompare, Bitcoin RPC) are mocked with a local `http.createServer` and
  `*_BASE_URL` env overrides set BEFORE importing modules (config reads env at
  import). New features get integration tests in this pattern.
- **Frontend:** hash routing only (iframe-embeddable; `?embed=1` strips
  chrome). No localStorage/sessionStorage anywhere. Chart heights are CSS-owned
  (`.chartwrap` per breakpoint) — never a fixed recharts height prop. Every
  chart keeps the `.chart-watermark`. Colors/typography come from CSS variables
  in `theme.css`, aligned to the Strive brand system: ink surfaces (`--ink`),
  bone text (`--bone`), slate secondary (`--text-dim`/`--text-faint`), hairline
  borders (`--ink-line`), and Bitcoin orange (`--orange` = `--btc`) as the ONE
  reserved accent (price, the wordmark's em, section eyebrows, editorial links,
  focus ring — never buttons or chrome; CTAs are bone-filled pills). Green/
  blue/red (`--aurora`/`--cold`/`--hot`) are chart-data and status colors only.
  Type: Instrument Serif for display headings (weight 400 only), IBM Plex Sans
  for UI, IBM Plex Mono for data — all self-hosted woff2 in `web/public/fonts`
  via `web/src/fonts.css`.
- **No em-dashes in user-facing copy** (web page/component prose, catalog
  descriptions and zone copy, `apiReference.js` text): use commas, colons,
  semicolons, or parentheses instead. The lone "—" glyph as a missing-value
  placeholder and em-dashes in code comments are fine.
- **The footer** shows only the disclaimer, the newsletter signup (when the
  feature is enabled), and "Powered by Strive". There is deliberately no Admin
  link anywhere in the UI; the panel is reached by typing `#/admin`.
- **The Epoch Rings mark is data-driven** — coin position = chain progress
  through the halving epoch (`web/src/epoch.js`, fully unit-tested including
  orbit-radius exactness). Don't replace it with a static image.
- **Schema changes** must be idempotent additions to `schema.sql`
  (`ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`) — there is no
  migration framework; `migrate()` re-runs the whole file.
- After frontend changes: `npm run build` must pass. After any change:
  run the full test suite. CI (`.github/workflows/ci.yml`) runs both with a
  Postgres 16 service container.

## Gotchas

- `VITE_API_URL` is baked into the web bundle at build time — changing it
  requires rebuilding `web/`.
- OG cards rasterize SVG with `sharp` (no headless browser); card content
  caches in memory for 1h per slug.
- The public explorer/alerts/subscribe surfaces share a per-IP fixed-window
  rate limiter (`PUBLIC_RATE_LIMIT_PER_MIN`, keys on x-forwarded-for). Tests
  that hammer public endpoints should send a unique `x-forwarded-for`.
- Newsletter dispatch is sequential (~16/sec) to respect Resend limits; if the
  subscriber list grows past several thousand, move it to a resumable queue.
- The sync worker pauses at every UTC day boundary to snapshot the full UTXO
  set — that exactness is the product; don't "optimize" it away.
- `metrics_daily` today's row doesn't exist until the day finalizes — at the
  live tip, "latest" means yesterday UTC. This is by design.
- The API serializes Postgres `numeric` columns as **strings**. Frontend
  formatters (`web/src/format.js` `fmt()`/`compact()`) coerce to Number and
  render "—" for non-numeric input — a raw string reaching `.toFixed()` once
  crashed (blank-paged) the whole app. Keep coercion when touching formatters.
