# True North Atlas

Institutional-grade Bitcoin on-chain analytics, computed directly from your own
fully-validating Bitcoin Core node. No third-party data vendors between you and
the ledger. Free, for the community.

- **~50 metrics** across valuation (MVRV, MVRV-Z, Mayer, NUPL, realized/
  balanced price, AVIV & true market mean, terminal/delta price, and an exact
  cost-basis distribution of the entire supply), profit & loss
  (SOPR family, realized P&L, supply in profit, sell-side risk), holder
  behavior (CDD, dormancy, liveliness, VDD, reserve risk, HODL waves, RHODL),
  cohorts (STH/LTH supply, cost basis, MVRV, NUPL, supply in profit), mining (Puell, hashrate,
  hash ribbons, thermocap), and network (NVT, volume).
- **Exact history, not approximations** — the sync worker snapshots the full
  UTXO set at every UTC day boundary while replaying the chain, so set-level
  metrics (HODL waves, supply in profit, cohort cost bases) are the precise
  end-of-day state for every historical day.
- **Reorg-safe** — per-block deltas are stored and reversible; spent UTXOs are
  retained for 144 blocks and every running counter rolls back cleanly.
- Plain-English "what it tells you / how it's computed" panes on every metric.
- **A living mark** — the Epoch Rings logo in the header positions its coin at
  the chain's actual progress through the current halving epoch (hover it for
  "Epoch 5 · 47.3% complete · N blocks to the halving"). While the app boots,
  the coin orbits; once your node reports a height, the logo becomes an
  instrument.

## Architecture

```
Bitcoin Core (your node) ──RPC──▶ sync worker ──▶ Postgres ◀── read API ◀── static frontend
     (Start9, Core 25+)          (server/)                    (server/)       (web/)
```

| Piece        | Path      | Runs as                                  |
|--------------|-----------|------------------------------------------|
| Sync worker  | `server/` | `npm run worker` — Render background worker (or at home, near the node) |
| Read API     | `server/` | `npm start` — Render web service, health check `/api/health` |
| Frontend     | `web/`    | `npm run build` → static site (Vite + React) |
| Database     | —         | Postgres 14+ (16 recommended)             |

The node needs `server=1` and RPC credentials. **`txindex` is not required** —
blocks are fetched with `getblock <hash> 3`, which inlines prevout values
(Bitcoin Core 25+; verified against Core 29.x).

## Connecting a Start9 node

On StartOS, open **Services → Bitcoin Core**:

- **Properties** shows your RPC username and password.
- **Interfaces** shows the RPC Tor address (`xxxxxxxx.onion`, port 8332) and a
  LAN address.

Pick one of three connectivity patterns for the sync worker:

1. **Run the worker at home (recommended).** Run `npm run worker` on any
   machine on the same LAN as the Start9 (a spare box, laptop, or the cheapest
   mini-PC you can find), with `BITCOIN_RPC_URL` pointed at the node's LAN
   address and `DATABASE_URL` pointed at your Render Postgres **external**
   connection string. LAN RPC is dramatically faster for the initial replay,
   and the API + frontend still live on Render. This repo's worker is just a
   Node process — `node src/sync.js` — nothing Render-specific.

2. **Tor from anywhere — including Render.** Set
   `BITCOIN_RPC_URL=http://<your-onion>.onion:8332` and
   `TOR_SOCKS_PROXY=socks5h://<tor-daemon-host>:9050` (the `socks5h` scheme is
   required — it resolves .onion names through Tor). The Blueprint's
   `atlas-sync` worker **and** `atlas-api` service both build from
   `server/Dockerfile.worker`, which bundles a Tor daemon in the container and
   presets `TOR_SOCKS_PROXY` to it — on Render you only fill in the `.onion`
   URL and RPC credentials on each service. Expect the initial replay to be
   several times slower over Tor.

3. **VPN / tunnel.** Put the node's LAN RPC behind Tailscale, WireGuard, or an
   SSH tunnel from wherever the worker runs. Same speed as LAN, works from any
   host in the tailnet.

Whichever you choose: the RPC password only ever goes in the worker's
environment — the API and frontend never see the node.

## Deploying on Render (Blueprint)

1. **Push to GitHub:**

   ```bash
   cd truenorth-atlas
   git init
   git add .
   git commit -m "True North Atlas"
   git branch -M main
   git remote add origin git@github.com:<you>/truenorth-atlas.git
   git push -u origin main
   ```

2. **Create the Blueprint:** in the Render dashboard, **New → Blueprint**,
   select the repo. Render reads `render.yaml` and provisions:
   `atlas-db` (Postgres), `atlas-api` (web service), `atlas-sync`
   (worker), `atlas-web` (static site).

3. **Set the dashboard-only env vars** (marked `sync: false` in render.yaml):

   | Service        | Variable                | Value |
   |----------------|-------------------------|-------|
   | `atlas-sync` | `BITCOIN_RPC_URL`       | your node's RPC URL |
   | `atlas-sync` | `BITCOIN_RPC_USER`      | from Start9 Properties |
   | `atlas-sync` | `BITCOIN_RPC_PASSWORD`  | from Start9 Properties |
   | `atlas-sync` | `TOR_SOCKS_PROXY`       | only for pattern 2 above |
   | `atlas-sync` | `CRYPTOCOMPARE_API_KEY` | optional, free key raises limits |
   | `atlas-api`  | `BITCOIN_RPC_URL`/`_USER`/`_PASSWORD` | optional — same values as the worker; enables full tx detail in the explorer (see "Block explorer") |
   | `atlas-web`  | `VITE_API_URL`          | the `atlas-api` URL once live |

   (If you run the worker at home, suspend `atlas-sync` on Render and set the
   same variables locally, with `DATABASE_URL` = the database's **external**
   connection string from the Render dashboard.)

4. **Redeploy `atlas-web`** after setting `VITE_API_URL` (it's baked in at
   build time).

5. **Custom domain:** add e.g. `atlas.tnorth.com` to `atlas-web`, and keep
   `CORS_ORIGIN` on `atlas-api` in sync with the domains you serve from.

### Embedding in tnorth.com

The app is hash-routed and iframe-friendly. `?embed=1` strips the header and
footer so it drops into an existing page shell:

```html
<iframe src="https://atlas.tnorth.com/?embed=1" style="width:100%;height:100vh;border:0"></iframe>
```

## Growth features

**Shareable chart cards.** Every metric has a branded 1200×630 card at
`GET /og/<slug>.png` — chart, latest value, historical percentile, the Epoch
Rings mark — rendered server-side (no headless browser) and cached for an
hour. The Share button on each metric page copies `GET /share/<slug>`, a tiny
page that serves Open Graph / Twitter tags to crawlers and redirects humans
into the app — so every Atlas link posted on X unfurls as your chart with
your logo.

**Metric alerts (Resend).** "Email me when MVRV-Z closes above 5." Double
opt-in (confirmation email), one-click unsubscribe in every message, and
crossing detection on finalized daily closes — an alert fires once per
threshold cross, never daily spam while a condition holds. The checker runs
inside the API service every 15 minutes. Set `RESEND_API_KEY`,
`ALERTS_FROM_EMAIL` (verify the domain in Resend first), `PUBLIC_SITE_URL`,
and `PUBLIC_API_URL`; alerts are safely disabled when the key is unset.

**Email platform: audited, branded, newsletter-capable.** Every email the
platform sends goes through one function that writes to `email_log` —
recipient, subject, type, outcome, Resend message id, and the error text on
failures — so the audit trail is complete by construction (Admin panel →
Email Log, or `GET /api/admin/email-log`). All mail renders in the standard
Atlas format: the lockup over an aurora bar, dark card, single aurora CTA,
compliance footer, unsubscribe link. The **Newsletter** tab lets any named
admin draft in markdown-lite (headings, bold, links, bullets — HTML-escaped,
injection-proof), attach up to 8 charts (embedded as the branded OG cards,
linking back to the site), send themselves a test, and schedule delivery to
the double-opt-in subscriber list (footer signup on the site, shown once
`NEWSLETTER_SIGNUP_ENABLED=true`). Sent
newsletters are immutable; per-recipient sends are individually audited;
partial provider failures are counted and recorded.

**Chart watermarks.** Every chart on the site carries a "TRUE NORTH ATLAS ·
atlas.tnorth.com" watermark, and the OG cards are branded by design — every
screenshot that leaves the site carries the flag.

**Live price + institutional price data (Massive).** With `MASSIVE_API_KEY`
set, the header shows a live consolidated BTC price (pulsing dot, 30s server
cache) via Massive's last-trade feed, and daily closes from 2015 forward come
from Massive's licensed aggregates — CryptoCompare remains only as the
2010–2015 deep-history backfill the cost-basis engine requires. Everything
degrades gracefully if the key is absent. Metrics themselves always use
finalized daily closes; spot is display-only. The catalog also gains
**Price & On-Chain Pricing Models** — spot vs realized price, balanced price,
and STH cost basis on one chart — and the USD pricing-model metrics now plot
BTC price on the same axis by default.

**Halving-cycle overlays.** Every line metric has a Cycles view: each epoch
re-based to days-since-halving (`GET /api/cycles/<slug>`) and drawn as its own
line, current cycle heaviest, in aurora. "Where is this cycle versus the last
three" — answered on one chart.

## Block explorer

The site includes a full block explorer (**Explorer** in the header, or
`#/explorer`): search any block height, block hash, transaction ID, or address.
Free for everyone, rate-limited per IP (`PUBLIC_RATE_LIMIT_PER_MIN`, default
60/min).

**Data model.** Address balances and UTXO listings come from the app's own
UTXO set — exact from genesis, because the sync worker records the address on
every output. And because every output is also keyed to the USD close of its
creation day, address pages show something no mainstream explorer has: the
address's **on-chain cost basis and unrealized P&L**, per UTXO and in total —
the same basis the realized-cap engine uses. Block summaries come from the local index. Full transaction
detail and block tx listings are RPC-enriched when the API service can reach
your node; notably, **transaction lookup works without `txindex`** — the app
learns the containing block from its own UTXO table and fetches by blockhash.
To enable this, give the API service the same `BITCOIN_RPC_URL/USER/PASSWORD`
as the worker — on Render this works even for a Tor-only node, because
`atlas-api` runs the same Docker image as the worker (`server/
Dockerfile.worker`, Node + bundled Tor daemon) with `TOR_SOCKS_PROXY` preset
to the in-container proxy; just fill in the `.onion` URL and credentials.
Without RPC the explorer degrades gracefully to DB-backed responses flagged
`"rpc": false`.

### Private API (`/v1`) — for your applications

The same explorer surface is mounted at `/v1/*` for programmatic access,
gated by API keys. Keyed traffic is not rate-limited.

```
GET /v1/search?q=<anything>          dispatches to block / tx / address
GET /v1/block/<height-or-hash>
GET /v1/tx/<txid>
GET /v1/address/<address>            balance, USD value, UTXO list
GET /v1/blocks/recent
```

Authenticate with the `X-API-Key` header:

```bash
curl -H "X-API-Key: tn_live_..." https://atlas-api.onrender.com/v1/address/bc1q...
```

### Admin model: root + named admins

Bootstrap works like this: the **root credential is the `ADMIN_TOKEN`
environment variable** on the API service (auto-generated by the Blueprint).
Whoever controls the deployment controls root — the correct root of trust,
since the first admin can't be established from inside the app.

Root is the only credential that can **create and revoke named admins**
(Admin panel → Admins tab, or `POST /api/admin/admins`). Each admin gets a
personal `tn_admin_…` token: individually revocable, usage-tracked, able to
manage API keys but *not* other admins. Every API key records which admin
created it. Revoking an admin kills their token immediately; API keys they
created keep working (applications shouldn't break because a person left —
review and rotate those keys deliberately).

Recommended practice: use root once to mint yourself a personal admin token,
store root in a password manager, and do day-to-day key management as a named
admin.

### Key administration

**Admin panel (recommended):** navigate to `#/admin` on the site (type it into
the URL — it is deliberately not linked anywhere in the UI), unlock with your
`ADMIN_TOKEN` (or a `tn_admin_…` token), and you get five tabs — **API Keys**
(create, list with usage stats and creator attribution, revoke), **Admins**
(root only: mint and revoke per-person admin tokens), **Newsletter** (compose,
test-send, schedule), **Email Log** (the complete audit trail of every email
the platform has attempted to send), and **API Reference** (authentication,
every endpoint, and a live-verified example response for each, so integrators
can see exactly what they'll get back). The token is held in browser memory
only, never stored.

**Or via curl:** admin endpoints live under `/api/admin` and are protected by `ADMIN_TOKEN`
(auto-generated by the Render Blueprint; copy it from the `atlas-api`
environment tab). If `ADMIN_TOKEN` is unset the admin surface is disabled.

```bash
TOKEN='<your ADMIN_TOKEN>'
API='https://atlas-api.onrender.com'

# Create a key (the plaintext is returned once — store it immediately)
curl -X POST $API/api/admin/keys \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"sata-dashboard"}'

# List keys (usage stats, no secrets)
curl -H "Authorization: Bearer $TOKEN" $API/api/admin/keys

# Revoke key id 3 (takes effect immediately)
curl -X DELETE -H "Authorization: Bearer $TOKEN" $API/api/admin/keys/3
```

Only the SHA-256 of each key is stored server-side. Keys look like
`tn_live_<43 chars>`; treat them like passwords in your consuming apps.

## Initial sync expectations & sizing

- The replay processes every block since genesis and pauses at each UTC day
  boundary to snapshot the UTXO set. Over LAN with an SSD-backed node, expect
  **several days to ~2 weeks**; over Tor, longer. Progress logs every ~5,000
  blocks, and every finalized day appears on the site immediately — the chart
  history visibly grows while it runs.
- The live UTXO set is ~190M rows. Budget **100–150 GB** of Postgres disk
  (rows + indexes + headroom); `render.yaml` provisions 150 GB. RAM helps the
  daily snapshot scans — 4 GB is a workable floor, more is better.
- Steady state after sync: one block every ~10 minutes and one day-boundary
  snapshot per day. A `starter`-class worker handles it easily; the `standard`
  plan in render.yaml is for the initial replay and can be downsized after.

## Running locally

```bash
# API + worker
cd server && npm ci
DATABASE_URL=postgres://localhost:5432/atlas npm run migrate
DATABASE_URL=... BITCOIN_RPC_URL=... BITCOIN_RPC_USER=... BITCOIN_RPC_PASSWORD=... npm run worker
DATABASE_URL=... npm start          # http://localhost:8080

# Frontend (dev server proxies /api to :8080)
cd web && npm ci && npm run dev     # http://localhost:5173
```

## Testing

108 tests (90 server, 18 web). The server has unit suites (subsidy schedule,
catalog↔schema integrity, RPC transport) that run without a database, plus
Postgres-backed integration
suites that replay a synthetic chain against mock providers and verify the
economics by hand: the core pipeline (SOPR, realized P&L, CDD, realized-cap
rotation, HODL waves, reorg rollback, pruning, the full API surface), the
explorer (address balances, block/tx lookup with and without txindex, search
dispatch, the complete API-key lifecycle, admin auth, public rate limiting),
price sync and reorg detection against a mock node, the Massive live-price
integration, the email platform (audit log, alerts, newsletters), and the
signup kill switches. The web app has unit suites for the formatters
(including coercion of the API's string-serialized numerics), the
halving-epoch math, and the API reference. A documentation contract test
compares the admin panel's example responses against live API output
key-for-key, so the docs cannot drift from the code.

```bash
# scratch Postgres for the integration suites (NEVER point tests at real data —
# they TRUNCATE their tables). Either:
docker compose up -d db                # from the repo root; Postgres 16 on :5433
# or, without Docker:
scripts/scratch-db.sh start            # Homebrew postgresql@16 on :5433

# server
cd server
npm run test:unit          # no database needed
DATABASE_URL=postgres://atlas:atlas@localhost:5433/atlas_test PGSSLMODE=disable npm test
npm run test:coverage      # same env; line/branch/function coverage report

# web (no database, no DOM needed)
cd web && npm test
```

Current coverage: ~94% lines across the server (uncovered: the worker's
infinite poll loop and the live-Tor code path).

## Repository guide

| Path | What it is |
|------|------------|
| `server/` | Express read API + chain-sync worker (Node 20+, Postgres) |
| `server/Dockerfile.worker` | Docker image shared by the worker and the API on Render, with a bundled Tor daemon for `.onion` RPC |
| `web/` | Vite 8 + React 18 frontend (hash-routed, iframe-embeddable) |
| `render.yaml` | Render Blueprint: database, API, worker, static site |
| `docker-compose.yml` | scratch Postgres for local integration tests |
| `scripts/scratch-db.sh` | the same scratch Postgres via Homebrew, no Docker |
| `DEPLOYMENT.md` | step-by-step deployment manual (Start9 → Render, ~45 min) |
| `SECURITY.md` | security policy and vulnerability reporting |
| `AGENTS.md` / `CLAUDE.md` | architecture map, invariants, and conventions for AI coding agents |

## Metric methodology, in one paragraph

Every unspent output is keyed to the USD close of the day it was created —
that's its cost basis. Realized cap is the sum of those bases; spending a coin
"rotates" its basis to the new day's close. SOPR is spend-value over
basis-value per day (adjusted variant ignores coins younger than 1 hour;
STH/LTH split at 155 days). Coin Days Destroyed weights spends by coin age;
liveliness is cumulative CDD over cumulative coin-days created. Set-level
metrics (HODL waves, supply in profit, cohort cost bases) come from a full
UTXO-set scan at each UTC day end. Pre-market days (Jan 2009 – Jul 2010) carry
a zero cost basis, which is the economically correct treatment for coins that
predate any market price. Each metric's page documents its exact formula.

---

*True North Atlas is for informational and educational purposes only.
Nothing here is investment advice or an offer of any security or investment
product.*
