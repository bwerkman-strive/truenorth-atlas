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
- **Load the `truenorth-brand` skill before any visual work** (tokens, colors,
  type, buttons, chart series). Atlas follows the True North tool & dashboard
  style guide as of 2026-08-10, because it is hosted on tnorth.com. The
  `strive-brand` skill is SUPERSEDED historical reference — applying it would
  revert the design system. Compute contrast for any new color pair; Atlas's
  text floor is light-sky/70, one step above the guide's, because the guide's
  figure is computed against the page ground rather than the card surfaces
  Atlas actually uses.
- **Open, unsigned-off:** the style guide closes Recharts to new work in favour
  of ECharts (§6.4). Atlas is entirely recharts and was NOT migrated during the
  rebrand: it is a large rewrite touching every chart, it conflicts with the
  CSS-owned `.chartwrap` sizing convention, and nobody has signed off on it.
  Don't start it as a side effect of unrelated work.
- When writing or editing user-facing copy (web prose, `catalog.js`
  descriptions, `apiReference.js`), never use em-dashes — rephrase with
  commas, colons, semicolons, or parentheses (the "—" missing-value
  placeholder glyph is the one exception).
- Never introduce localStorage/sessionStorage in `web/` (embedded/iframe use).
- Secrets (`ADMIN_TOKEN`, `tn_admin_…`, `tn_live_…`, API keys for Resend/
  Massive) must never be logged, committed, or echoed into test fixtures
  beyond the existing mock values.
