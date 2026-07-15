# CLAUDE.md — True North Atlas

@AGENTS.md

## Claude Code specifics

- **Definition of done for any change:** relevant tests added/updated, full
  suite green (`server`: needs a scratch Postgres via `DATABASE_URL`; `web`:
  no DB), and `cd web && npm run build` succeeds. Don't report done without
  running these.
- **Start with the invariants section of AGENTS.md** before modifying
  `sync.js`, `email.js`, `keys.js`, or `schema.sql` — several behaviors that
  look refactorable (retained spent UTXOs, day-boundary pauses, plaintext
  unsub tokens, the single email path) are deliberate and test-enforced.
- When adding a metric, follow the catalog procedure in AGENTS.md exactly;
  `test/unit.catalog.test.js` and the docs-contract test in
  `test/integration.explorer.test.js` will tell you what you missed.
- Mock external providers via their `*_BASE_URL` env overrides set **before**
  module import (config captures env at import time) — see any
  `test/integration.*.test.js` for the pattern.
- Prefer editing `theme.css` variables/classes over inline styles; the
  responsive layer at the bottom of that file owns breakpoint behavior.
- When writing or editing user-facing copy (web prose, `catalog.js`
  descriptions, `apiReference.js`), never use em-dashes — rephrase with
  commas, colons, semicolons, or parentheses (the "—" missing-value
  placeholder glyph is the one exception).
- Never introduce localStorage/sessionStorage in `web/` (embedded/iframe use).
- Secrets (`ADMIN_TOKEN`, `tn_admin_…`, `tn_live_…`, API keys for Resend/
  Massive) must never be logged, committed, or echoed into test fixtures
  beyond the existing mock values.
