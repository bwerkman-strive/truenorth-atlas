---
name: strive-brand
description: Canonical Strive web brand system (color, type, layout, interactive treatments) as the reference for any Atlas visual work. Load BEFORE editing theme.css tokens, choosing colors, sizing type, styling buttons/links/eyebrows/focus rings, or building any user-facing surface, so Atlas stays aligned to the flagship strive.com build. Also read it before answering "what is the brand color / font / spacing" questions.
---

# Strive web brand system (Atlas alignment reference)

Pulled from the flagship strive.com style reference (`treasury.strive.com`
print, revised **2026-07-20**, verified against `main @ ff76be9`). This is the
canonical brand: match it for any Strive-branded surface. True North Atlas
aligns to this system but keeps its own product identity (the name and the
Epoch Rings mark), and diverges in a few deliberate places called out under
[Atlas divergences](#atlas-divergences).

Tokens are canonical. Values flagged **bespoke** are the flagship's own one-off
treatments; they are noted so you know what *not* to copy into a token.

---

## 1. Colors

`--orange` `#f7931a` is the **single reserved accent**. It marks only: italic
editorial emphasis in display headings, the orange section-eyebrow tier on
dense pages, price (in Atlas), and the focus ring. Never UI chrome, buttons, or
body text. Buttons are bone-filled or outlined, never orange. Keep it scarce;
that scarcity is the point.

### Accent ramp
| Token | Value | Role |
|---|---|---|
| `--orange` / `--btc` | `#f7931a` | The reserved accent. Bitcoin orange in Atlas. |
| `--orange-soft` | `#c97714` | Deeper orange in the ramp. Reserved. (Flagship ramp; not in Atlas today.) |
| `--orange-dim` | `#8a4f0e` | Darkest orange. Fine-print flags. |

### Ink (dark surfaces)
| Token | Value | Role |
|---|---|---|
| `--ink` | `#0b0c0e` | Primary background (the "vault"). |
| `--ink-deep` | `#050608` | Deepest surface: footers, blackout, scroll mask. |

### Bone (light surfaces + emphasis text)
| Token | Value | Role |
|---|---|---|
| `--bone` | `#f2ede3` | Primary light. Emphasis text on dark + light surface bg. |
| `--bone-2` | `#e8e2d4` | Secondary bone, slightly deeper. |

### Slate (secondary text + hairlines)
| Token | Value | Role |
|---|---|---|
| `--slate` | `#a39d8f` | **Default secondary text. 7.25:1 on `--ink`.** Retuned 2026-06 from `#918b7d` (was 5.77:1) for all-ages readability; sits a clear step below `--bone` and `--orange`. |
| `--slate-tertiary` | `#807a6a` | Quiet de-emphasis, 4.58:1. Flagship keeps it *only* for the Trifecta comparison tags and the dimmed T-Bill row. |
| `--slate-soft` | `rgba(110,106,96,.4)` | **The one real border token** (`1px solid`): section rules, card borders, table lines. Deliberately left at the original tone. |

### Surfaces are polarity classes, not separate tokens
Backgrounds are three utilities built from the core tokens:
- `.is-bone` -> bg `--bone` / text `--ink`
- `.is-vault` -> bg `--ink` / text `--bone`
- `.is-deep` -> bg `--ink-deep` / text `--bone`

Data colors (green/blue/red) are chart and status colors only, never chrome.

---

## 2. Typography

Two families, both self-hosted latin-subset `.woff2`, both OFL:
- `--font-display`: `'Instrument Serif', 'Instrument Serif Fallback', 'Times New Roman', Georgia, serif` — display headings, weight 400 + 400 italic only. Italic words inside a heading take `--orange`.
- `--font-ui`: `'IBM Plex Sans', 'IBM Plex Sans Fallback', system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif` — everything else. Weights 400 / 500 / 700.
- `--font-mono`: **compatibility alias only**, resolves to `--font-ui` (no monospace fallback). Slated for deprecation. Do not introduce new consumers.

`font-display: swap` is safe because the fallbacks are metric-matched
(size-adjust + ascent/descent overrides), so the swap is zero-CLS. Base
reading size is **16px / 1.5**. Body is Plex Sans 400; labels/eyebrows step to
500; bold (700) is the native `<strong>` weight. Tabular numerals on figures.

### Type scale (flagship tokens)
| Token | Size | Role |
|---|---|---|
| `--type-body` | 16px | Base reading size. |
| `--type-body-lg` | 18px | Large body / lead-in. |
| `--type-subtitle` | 20px | Subtitles, standfirsts. |
| `--type-mono` | 14px | Label / pill text (tracked uppercase sans). |
| `--type-eyebrow` | 13px | Page eyebrow. (Raised from 11px, 2026-06.) |
| `--type-micro` | 12.5px | Editorial micro-label: section eyebrows, captions, card meta. (Was 10.5px.) |
| `--type-mono-sm` | 12px | Small labels, stub notes. |
| `--type-meta` | 12px | Smallest meta text. (Was 10px.) |

**Display / hero (desktop -> mobile ≤768px):** `--type-display-lg` 144->80,
`--type-display` 96->64, `--type-title` 56->40, `--type-title-sm` 32->24.

> **2026-06 CEO legibility pass:** the three smallest label tiers were raised
> +2px (eyebrow 11->13, micro 10.5->12.5, meta 10->12) for easier reading
> across all ages. Legal / forward-looking **disclaimers are deliberately
> exempt** and keep their own literal small sizes; they remain the smallest
> text on the page, by intent. **Atlas has not adopted this pass** (see
> divergences) — Atlas label sizes are inline literals, not these tokens.

### Tracking
| Token | Value | Use |
|---|---|---|
| `--tracking-label` | `0.2em` | Labels + section eyebrows (widest tier). |
| `--tracking-eyebrow` | `0.18em` | Page eyebrows. |
| `--tracking-meta` | `0.12em` | Meta / fine print. |

### Self-hosting
Latin-subset woff2 generated from the Google Fonts CSS (OFL), served from
`/fonts`, generated by `scripts/generate-fonts.mjs`. Off the CDN for privacy +
CSP + reliability, and to metric-match the fallbacks.

> **Flagged delivery detail (2026-07):** the three Plex weight files on disk are
> byte-identical copies of one variable file (wght axis 100-700). The current
> declarations instantiate 400/500/700 from the axis but download the same
> ~45KB three times. One `@font-face` with `font-weight: 100 700` pointing at a
> single file would serve the same result once. **Atlas ships the three-file
> form** (`ibm-plex-sans-400/500/700-normal.woff2`); consolidating is an open
> optimization, not yet done, and needs regenerating the woff2 from the
> variable source.

---

## 3. Layout

| Token | Value | Role |
|---|---|---|
| `--container-max` | `1280px` | Canonical content max-width. |
| `--container-px` | `clamp(20px, 4vw, 64px)` | Horizontal gutter; mobile (≤768px) pins to 20px. |
| `--container-narrow` | `880px` | Inner editorial column. |
| `--container-wide` | `1440px` | Wide layouts near the viewport edge. |
| `--space-section` | `clamp(72px, 8vw, 120px)` | Section-to-section rhythm (default). |
| `--space-section-tight` | `clamp(48px, 6vw, 80px)` | Tighter variant. |
| `--space-header-clearance` | `114px` | Top clearance under the fixed nav (`--nav-height`). Flagship-specific; raised from 110px in the 2026-06 lockup rebalance. |

Reading column of 75ch (`.layout-prose-column`) sits inside the container for
body prose.

### Spacing, radius, elevation are deliberately lean
Most of these are **absent as tokens** — match the literals, and match the
flatness:
- **Micro-spacing** (padding/gaps): component-level literals (pill `14px 22px`, lockup gap `5px`), no `--space-1/2/3` scale.
- **Corner radius:** no `--radius` token in the flagship. De-facto: pills `999px`, cards `12px` (most common), small chips/insets `2px`, misc `4px`. (Atlas *does* tokenize this as `--radius: 12px`.)
- **Elevation:** no shadow token. The system is **flat** — depth comes from polarity surfaces + hairlines, not shadows. The few shadows are bespoke.

> **Match the flatness.** Hairlines over shadows; square-ish cards (12px) with
> pill CTAs (999px); spacing tuned per-component rather than from a scale. That
> restraint is part of the look.

---

## 4. Signature treatments

### Buttons & pills — the CTA system
The canonical CTA is the **pill** (`.pill`). **Bone-filled primary, outlined
secondary, never orange** (that is the accent rule). It flips for light
surfaces via a separate `.is-bone` variant.

- **Shared:** IBM Plex Sans, `14px`, tracking `--type-mono`, `0.06em`, uppercase, weight 500, padding `14px 22px`, radius `999px`, 1px border.
- **On dark:** primary bg `#f2ede3` / text `--ink`; hover bg `rgba(242,237,227,0.85)`. Secondary transparent, text/border `--bone` / `rgba(242,237,227,0.4)`; hover border+text `--bone`.
- **On light (`.is-bone`):** primary bg `#0b0c0e` / text `--bone`; hover bg `rgba(11,12,14,0.85)`. Secondary text `--ink` / border `rgba(11,12,14,0.3)`; hover border+text `--ink`.

> **Bespoke (do not tokenize):** the pill defines only `:hover` — no `:active`
> or `:disabled`. The sole disabled-button styling in the flagship is the
> bespoke ledger nav button (`color rgba(242,237,227,0.2); cursor: default`).
> Secondary borders use literal low-alpha bone/ink, **not** `--slate-soft`.
> The gateway "door" CTA (`.hdoor__cta`) is bespoke: Instrument Serif italic,
> `clamp(2.2rem, 5.4vw, 4rem)`, bone -> orange on hover — an editorial text-CTA
> in the italic-orange register, not the pill rule.

### In-content / editorial links
**No global link token.** The base `a` is `color: inherit` /
`text-decoration: none` — plain body links are undistinguished by default. The
editorial convention (a convention, not a shared class): `color #f7931a` +
`border-bottom: 1px solid rgba(247,147,26,0.3)`; hover -> text & underline go
`--bone`. External links additionally carry a slate `↗` (see external cue).

> Atlas uses a simpler global default: `a { color: --orange }`, hover ->
> `--bone` + underline. See divergences.

### Focus ring — `:focus-visible`
Global default: `outline: 2px solid var(--focus-ring); outline-offset: 3px`.
The token is **polarity-aware** and flips by surface so the ring clears WCAG
1.4.11 (≥3:1) on both:
- On dark (and `.is-vault`/`.is-deep`): `--orange` — 8.52:1 on `--ink`.
- On light (`.is-bone`): `--ink` — 16.77:1 on `--bone`.

The flip matters: pure orange on bone would be 1.97:1 (below 3:1), which is
exactly why the token flips rather than hard-coding the accent. Variants: the
skip-link uses 2px orange at `offset 2px`; media page expand/chip/jump controls
use bespoke `1px` orange rings on their dark `.is-vault` section.

> Atlas currently hard-codes `:focus-visible { outline: 2px solid --orange }`.
> Fine on Atlas's all-dark surfaces; if a light (`.is-bone`) surface is ever
> added, adopt the polarity-aware flip.

### Editorial markers — eyebrow tiers & external cue
- **Page eyebrow (slate):** the quiet label above an H1. IBM Plex Sans `13px`, tracking `0.18em`, uppercase, `#a39d8f` (`--slate`), weight 500.
- **Section eyebrow (orange):** one tier down, orange **by design** for section wayfinding on dense pages. `12.5px`, tracking `0.2em`, uppercase, `#f7931a`, weight 500.
- **External-link cue (slate `↗`):** every off-site link carries a muted `↗` (U+2197), `0.78em`, `#a39d8f`, persistent (not hover-revealed) so leaving the site is predictable. The orange accent stays reserved; this cue disappears into the type until noticed.

---

## Atlas divergences

Deliberate differences between Atlas and the flagship reference. Preserve these
unless explicitly realigning:

1. **Identity is Atlas's own.** The name "True North Atlas" and the Epoch Rings
   mark (`web/src/components/EpochRings.jsx`, data-driven, unit-tested) replace
   the Strive wordmark lockup. The guide's §1 wordmark, the nav lockup
   rebalance (wordmark 39->42px), and the lockup hover lift do **not** apply.
2. **Header height** is Atlas's own (58px), not the flagship `--nav-height`
   114px / `--space-header-clearance`.
3. **Token names.** Atlas maps slate onto `--text-dim` (= `--slate`) and
   `--text-faint` (= `--slate-tertiary`), and uses `--ink-line` for the
   `--slate-soft` hairline. Atlas has `--btc` as the `--orange` alias (not
   `--btc-orange`).
4. **`--maxw: 1240px`**, not the flagship `--container-max` 1280px. Changing it
   reflows every page; not a minimal change.
5. **`--radius: 12px` is tokenized** in Atlas (the flagship leaves radius
   untokenized).
6. **Type sizes are inline literals**, not the flagship `--type-*` tokens.
   Atlas has **not** adopted the 2026-06 +2px legibility pass.
7. **Simpler global link + focus rules** (see those sections).
8. **No em-dashes in Atlas user-facing copy** (web prose, `catalog.js`,
   `apiReference.js`): use commas, colons, semicolons, or parentheses. The "—"
   missing-value placeholder glyph is the one exception. This is an Atlas house
   rule layered on top of the brand system.

## Source of truth
Flagship: the `Strive-Website` repo — tokens from `tokens.css` / `fonts.css` /
`globals.css`; buttons from `chapters.css`; wordmark from
`atoms/StriveWordmark.tsx` + `Nav.tsx`. Atlas: `web/src/theme.css` (tokens +
full responsive layer), `web/src/fonts.css` (self-hosted faces). Brand contact:
Dan Oksnevad (dan.oksnevad@strive.com).
