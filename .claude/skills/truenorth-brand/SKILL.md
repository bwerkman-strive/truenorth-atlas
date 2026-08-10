---
name: truenorth-brand
description: Canonical True North brand system for Atlas (color tokens, type, surfaces, component recipes, contrast floors) — the reference for any Atlas visual work now that Atlas is hosted on tnorth.com. Load BEFORE editing theme.css tokens, choosing colors, sizing type, styling buttons/links/eyebrows/focus rings, picking chart series colors, or building any user-facing surface. Also read it before answering "what is the brand color / font / spacing" questions. Supersedes the strive-brand skill.
---

# True North brand system (Atlas)

Derived from the **True North tool & dashboard style guide** (rev 2026-08-08),
the system behind `tnorth.com/tools` and `/digital-credit/dashboard`. Atlas
adopted it when it moved onto tnorth.com, replacing the Strive brand system
(see `.claude/skills/strive-brand`, now superseded).

The full guide is a tnorth.com repo document; the operator's copy is at
`~/Desktop/tnorth-style-guide/TOOL-STYLE-GUIDE.md`. **Most of it does not
apply to Atlas** — it is written for an Astro + Tailwind codebase with its own
page anatomy, SEO gates, and digital-credit compliance rules. What applies is
the visual system, reproduced below with Atlas's decisions folded in.

Atlas keeps its own product identity: the name, the wordmark, and the
**Epoch Rings mark**, which stays data-driven (`web/src/epoch.js`).

---

## 1. Tokens (`web/src/theme.css`)

The six brand tokens are the ONLY raw hex in the app. Everything else is a
semantic alias composited from them — the non-Tailwind equivalent of the
guide's "named tokens, never arbitrary-value hex" rule.

| Token | Hex | Role |
|---|---|---|
| `--deep-black` | `#1a1a1a` | page background |
| `--solstice` | `#323140` | card/surface fills, used at 20–70% |
| `--equinox` | `#514f60` | borders, dividers, muted UI, at 15–50% |
| `--light-sky` | `#c4ceda` | secondary/body text, at 50–80% |
| `--orange-pill` | `#f7941d` | the single accent |
| `--starbright` | `#ffffff` | primary text, headings, emphasized values |

Surfaces: `--ink-quiet` (solstice/20, informational cards) · `--ink-panel`
(/30, prominent cards + charts) · `--ink-raise` (/50, table heads, active
segmented controls) · `--ink-hover` (/70, interactive card hover) ·
`--ink-line` (equinox/30 hairline) · `--ink-line-soft` (/15, table rows) ·
`--ink-deep` (`#141414`, recessed JSON/code wells).

**Elevation is opacity steps and hairlines, never shadows.** The only
sanctioned shadows are the card-hover glow, the share popover, and the status
dot glow.

## 2. Contrast floors — compute, never eyeball

| Tier | Value | Worst case (page / card / raised) |
|---|---|---|
| `--text` | starbright | 17.40 / 16.04 / 15.03 |
| `--text-dim` | light-sky/80 | 7.41 / 6.83 / 6.40 |
| `--text-faint` | light-sky/70 | 5.97 / 5.50 / 5.15 |
| `--text-quiet` | light-sky/50 | decorative only |

**Atlas's floor is /70, not the guide's /60.** The guide's §2.2 matrix computes
light-sky/60 against the page ground only (4.73:1); over the solstice/30 card
composite (`#212125`) it falls to 4.36:1 and fails AA — and Atlas renders most
of its fine print inside cards. `--text-quiet` must never carry the sole
rendering of a value, label, or disclosure.

Other fixed facts: `--deep-black` on `--orange-pill` is 7.63:1 (the CTA
pairing). **White on orange is 2.28:1 and is forbidden at any size.** Solid
equinox on the page ground is 2.19:1 — decorative borders only.

## 3. Type

- **Inter** for everything, including display headings — there is no serif in
  this system. Headings are `font-weight: 600` + `letter-spacing: -0.025em`.
- **JetBrains Mono** for data: figures, hashes, tickers, countdowns.
- Both are self-hosted **variable** woff2 in `web/public/fonts` (88 KB total).
  The guide's font budget is 256 KB — **do not add faces or weights.** Inter
  ships normal-only, so never rely on italics (synthetic oblique is not a brand
  treatment).
- Tracking: `--tracking-label` `0.1em` (eyebrows, KPI labels, section H2s),
  `--tracking-meta` `0.05em` (table headers only). Keep that split.
- Eyebrows are 10px, uppercase, semibold, **orange-pill**.
- Any vertically-scannable number carries `font-variant-numeric: tabular-nums`
  (the guide mandates Tailwind's `tabular-nums`; this is its plain-CSS form).
  Numeric table columns are right-aligned.

## 4. Component recipes

- **Prominent card:** `--ink-panel` + `--ink-line` + `--radius` (12px).
- **Quiet card:** `--ink-quiet` + equinox/20 border — disclaimers, prose panes.
- **Card hover:** border to orange/30, background to `--ink-hover`, plus the
  faint orange glow. Guard with `prefers-reduced-motion`.
- **Primary CTA:** orange-pill fill, `--deep-black` label, semibold,
  `--radius-lg` (8px), `active: scale(0.98)`. This inverts the Strive rule that
  orange is never a button fill — under True North it IS the CTA.
- **Secondary/outline:** orange/10 fill, orange/30 border, orange label.
- **Quiet chip:** equinox/20 fill, `--text-faint`, `--radius-md` (6px);
  hovers to equinox/40 + starbright.
- **Inputs:** `--ink-panel` fill, equinox/20 border, `--radius-lg`, focus
  border to orange/30; placeholders at light-sky/30.
- **Focus-visible (sitewide, non-negotiable):** `2px solid --orange-pill`,
  offset `2px`. `outline: none` without a replacement is not permitted.
- **Radius scale:** 12px cards/charts · 8px buttons/inputs · 6px chips ·
  999px pills and dots. There is no 16px step.
- **z-index:** 10 in-card raised · 50 fixed page chrome (the header) · 60
  portaled overlays (the share popover).
- **Status dots:** live = `--aurora` with a soft glow; degraded/stale =
  `--amber`. Red is reserved for errors and negative values, never staleness.

## 5. Data colors

Never chrome. Categorical order (guide §2.4): `#F7941D` orange · `#60A5FA`
blue · `#4ADE80` green · `#C084FC` purple · `#22D3EE` cyan · `#FB7185` rose.
Semantics: positive `--aurora` (emerald-400), negative `--hot` (red-400),
caution `--amber` (amber-400), neutral/benchmark `#9CA3AF`.

Sequential ramps (URPD price bands, halving epochs) are **not** in the guide,
which defines categorical sets only. Atlas builds them from the same Tailwind
400 tier the guide draws its named shades from, so luminance stays in one band
— see `WAVE_COLORS` and `EPOCH_COLORS` in `web/src/pages/MetricDetail.jsx`.
Chart tooltips use solid solstice fill + equinox border + light-sky text.

## 6. Atlas divergences from the guide (deliberate, documented)

1. **Text floor is /70, not /60** — §2 above; the guide's figure is computed
   against the page ground only.
2. **Entity links stay blue-400**, not the accent. Txids, addresses, and block
   heights are dense and repeated; orange is kept scarce for price, CTAs, and
   editorial emphasis. blue-400 is a guide palette color and clears AA on both
   grounds. Editorial/prose links do use orange.
3. **The Epoch Rings mark uses solid equinox** for its inner rings rather than
   the `--ink-line` hairline, which at equinox/30 would nearly erase them.
   Logos are exempt from the WCAG contrast minimum; this is about the drawing
   staying legible.
4. **Plain CSS, not Tailwind.** Atlas has no CSS framework by design, so the
   guide's utility-class recipes are expressed as tokens and classes in
   `theme.css`. Same output, same vocabulary.
5. **Charts remain recharts.** The guide closes Recharts to new work in favour
   of ECharts (§6.4). Migrating Atlas's charts is a large, separate piece of
   work that has not been signed off — see the note in `CLAUDE.md`.
6. **Email is recoloured but not re-architected.** The guide governs web pages,
   not email; Atlas carries the palette into `email.js` so a rebranded site
   does not mail in the old colors, and nothing else.

## 7. Out of scope for Atlas

The guide's page anatomy (Astro `Base.astro`, breadcrumbs, `SuggestUpdate`),
SEO/JSON-LD rules, build gates and token layer, Lighthouse CI wiring, and the
digital-credit compliance vocabulary (§10: instrument facts, rate claims,
flagged terms) all belong to the tnorth.com repo. Atlas has its own invariants
in `AGENTS.md`. The one §10 item worth re-checking if Atlas copy grows: the
flagged-terms list ("Bitcoin-backed", "coupon", "guaranteed", "risk-free")
applies to tool surfaces on tnorth.com. Atlas is currently clean of all of them.
