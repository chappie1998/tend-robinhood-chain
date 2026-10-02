# Brand — Tend

_Status: active_
_Palette: **Chromium** (defi · perps · derivatives — minimal · technical · sharp)_

Tend is a trading terminal for on-chain options. The interface should read as a
professional derivatives desk: precise, high-contrast, information-first. Dark
by default, because that is what a trading surface is used in.

## Palette — Chromium

Near-black with **one** functional green. The restraint is the identity.

### Dark (default)

| Token | Value | Role |
| --- | --- | --- |
| `--canvas` | `#0b0b0b` | page base |
| `--surface` | `#161616` | panels, chart background |
| `--surface-mist` | `#1e1e1e` | raised rows |
| `--ink` | `#f5f5f5` | body text |
| `--ink-muted` | `#8a8a8a` | labels, axes, secondary |
| `--accent` | `#62d67f` | primary action, active state, strike line |
| `--positive` | `#62d67f` | P&L up, 24h up |
| `--negative` | `#ff6b6b` | P&L down, 24h down |
| `--border` | `#242424` | hairline separators |

### Light (same seeds, contrast-corrected)

`--canvas #fafafa` · `--surface #ffffff` · `--surface-mist #f2f2f2` ·
`--ink #0b0b0b` · `--ink-muted #6b6b6b` · `--accent/--positive #0f7340` ·
`--negative #c62828` · `--border #e4e4e4`

The green darkens to `#0f7340` on light — `#62d67f` only reaches 1.7:1 on
white. Same hue, corrected for contrast.

### Contrast (WCAG AA — verified on the written values)

Dark: ink/canvas 18.1:1 · muted/canvas 5.7:1 · accent/canvas 10.7:1 ·
negative/surface 6.5:1 · canvas-on-accent 10.7:1 (button text).
Light: ink 18.9:1 · muted 5.1:1 · accent 5.7:1 · negative 5.6:1.

## Colour discipline

This is what keeps the UI from looking generated:

- **Exactly one accent.** Multiple competing accents with no hierarchy is the
  clearest tell of generated design.
- **Green and red are semantic, never decorative.** They appear on P&L and
  direction only, always beside an explicit `+`/`−` so the meaning survives
  colour-blindness.
- **No violet, and no gradients.** Violet/blue gradient is the single most
  over-represented palette in generated UI; on a trading product it reads as
  slop regardless of execution.
- **Hairline borders, not shadowed cards.** Elevation comes from background
  shade and 1px separators.
- **Radius varies by role** (4/8/12) rather than one value everywhere;
  full-width structural bars stay square.

## Typography

- UI and headings: system sans, compact tracking (`-0.01em` to `-0.025em`).
- **All prices and financial data: system mono with `tabular-nums`**, and
  right-aligned in tables. Non-negotiable — figures must align vertically to be
  scannable.

## Motion

Fast and functional. Data updates ~150ms, transitions ≤200ms, no bounce, no
decorative animation. A trading surface should feel instant, not animated.

## Voice

Clear, compact, and honest. Explain the downside beside the upside — the payoff
diagram exists for exactly this reason. Never call option premium passive or
risk-free yield. State what is unknown ("estimate at live spot") rather than
implying certainty.

## Applying it

Tokens live in `web/src/styles.css` as plain CSS custom properties (this is not
a shadcn project). `PriceChart.tsx` reads them at runtime via
`getComputedStyle`, so the TradingView chart re-themes from these tokens with
no component changes — the hex values in that file are fallbacks only.

Previous palette backed up at `brand.md.bak`; previous tokens at
`web/src/styles.css.bak`.
