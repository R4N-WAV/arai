# Arai — Design System

Direction: a quiet, studio-like workspace. Music is the colour; the chrome is
calm. Inspired by mixing desks and tape labels, not SaaS dashboards: flat
surfaces, hairline dividers, one signal accent, monospaced timecodes, the
waveform as the hero element. No decorative gradients; motion only to
communicate state, and disabled under `prefers-reduced-motion`.

Tokens live in `apps/web/src/styles/tokens.css` as CSS custom properties.
Every component consumes tokens only — no raw hex values in components.

## Colour (dark default, light theme via `[data-theme=light]` and `prefers-color-scheme`)

| Token | Dark | Light | Use |
|---|---|---|---|
| `--bg` | `#111110` | `#F6F4EF` | page |
| `--surface` | `#1A1918` | `#FFFFFF` | panels, cards |
| `--surface-2` | `#24221F` | `#EDEAE3` | hover, inputs |
| `--line` | `#34312D` | `#D8D3C8` | hairlines (non-text) |
| `--text` | `#F2EFE8` | `#1A1918` | primary text (≥ 15:1) |
| `--text-muted` | `#A8A29A` | `#5E5850` | secondary text (≥ 7:1 dark / ≥ 6:1 light) |
| `--accent` | `#FF8A4C` | `#B84A12` | "signal" — play, focus, primary action (≥ 4.5:1 vs bg) |
| `--accent-ink` | `#1A0E06` | `#FFFFFF` | text on accent |
| `--danger` | `#FF6B6B` | `#B3261E` | destructive |
| `--ok` | `#5BD69A` | `#1F7A4D` | success |
| `--focus` | `#FFD166` | `#1D4ED8` | 3 px focus ring, never removed |

Contrast is verified by an automated test (Phase 1) against WCAG 2.2 AA.
Status is never conveyed by colour alone (icon + text).

## Typography

- UI: `"Inter var"` self-hosted (no third-party font CDN), fallback system-ui.
- Timecodes, versions, sizes: `ui-monospace, "JetBrains Mono", monospace` with tabular numerals.
- Scale (rem, 16 px base, respects user font size): 0.75 / 0.875 / 1 / 1.125 / 1.375 / 1.75 / 2.25.
- Line-height 1.5 body, 1.2 headings. Max line length 70ch.

## Spacing, radius, elevation

- 4 px grid: `--s-1:4px … --s-8:48px`.
- Radius: `--r-sm:4px` (inputs), `--r-md:8px` (cards), `--r-pill:999px` (chips, play button).
- Elevation by surface tone, not shadows; a single `--shadow-pop` for menus/modals.

## Layout

- **Desktop ≥ 1024 px**: left sidebar (library, folders, messages, discover),
  main content, optional right context panel (comments/versions/details),
  persistent bottom player bar (72 px).
- **Tablet 640–1023 px**: collapsible sidebar (overlay), context panel as sheet.
- **Mobile < 640 px**: bottom tab bar (Library, Discover, Upload, Messages,
  Profile), mini-player above tabs expanding to full-screen player sheet,
  context content as bottom sheets. Hit targets ≥ 44×44 px. No horizontal scroll at 320 px.

## Components (built in Phase 1–2, each with keyboard + screen-reader spec)

Button (primary/secondary/ghost/danger, loading state) · IconButton (requires
`aria-label`) · TextField / PasswordField (show/hide, strength hints, paste
allowed) · Select / Menu (roving tabindex, Esc closes) · Dialog (focus trap,
returns focus, `aria-modal`) · Sheet (mobile) · Toast (`role=status`,
pauses on hover/focus, never the only error channel) · Tooltip (on focus and
hover, dismissible) · Tabs · Card · List row with reorder menu (alternative
to drag-and-drop: "Move up/down/to…") · Avatar · Badge · Skeleton loader ·
EmptyState (explains + one action) · ErrorState (cause + recovery action) ·
Waveform (canvas + `role=slider` with `aria-valuetext` "1:32 of 3:45";
arrow keys seek 5 s, PageUp/Down 30 s) · Transport (play/pause, prev/next,
loop, speed, pitch, volume — all labelled) · Comment marker (focusable,
listed in an equivalent text list).

## Accessibility baseline (WCAG 2.2 AA)

Semantic landmarks, skip link, visible focus (2.4.11/2.4.13), target size
(2.5.8), dragging alternatives (2.5.7), accessible authentication without
cognitive tests (3.3.8 — paste & password managers allowed; Turnstile in
non-interactive mode where possible), consistent help location (3.2.6),
redundant entry avoided (3.3.7), errors linked with `aria-describedby`,
reflow at 400% zoom, `prefers-reduced-motion` and `prefers-contrast` respected.
Automated axe checks run in Playwright for every page.
