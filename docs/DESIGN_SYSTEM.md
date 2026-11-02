# Arai — Design System: "ambient space"

Approved by the owner on 2026-11-01. Reference canvas:
https://claude.ai/artifact/DBvtsi2PmcgZ2cB6pS4Bp7 (Direction, Logo, interactive
paint demo, Library desktop, Phone empty).

## Idea

அறை (arai) means room or space in Tamil. An empty Arai is a quiet, near-black
space with film grain and a faint hand-lettered அ. Every project carries a
colour from its cover art; as projects arrive, those colours seep into the
background like paint spreading over a black canvas and slowly drift. Removing
a project lets its colour fade out. The interface itself stays black and
off-white: **colour only ever comes from the user's music.**

## Rules that keep it from looking generated

- No glowing dots, neon box-shadows, gradient avatars, gradient "covers",
  conic rings or emoji.
- No rows of identical cards. Content sits on the background; thin rules and
  type create structure. Glass is reserved for the player bar and overlays.
- No spaced-out uppercase eyebrows. Sentence case; small human asides use the
  Fraunces italic "voice".
- Real content over decoration: track lists show cover thumbnails, not
  coloured markers.
- Texture is analogue but quiet: a fine grain lives only inside the coloured
  light (overlay blend, invisible on pure black); covers and surfaces are
  clean. Slight -3° tilt on the hand-lettered logo.

## Logo

- Primary: **அறை**, hand-lettered, tilted -3°. No icon, no Latin name beside it.
- Square mark: **அ** alone (favicon, app icon, avatars for the product).
- Latin caption "arai, a space for music" only where Tamil may not be read
  (emails, link previews), separated by a thin rule.
- Source: outlined from the Kavivanar typeface (SIL OFL 1.1) by
  `scripts/build-logo.mjs` (HarfBuzz shaping, so the vowel sign ை sits
  correctly) into `apps/web/src/components/logoPaths.ts` and
  `apps/web/public/favicon.svg`. The logo never depends on a web font.
  A custom redraw by a Tamil letterer can replace the paths later.
- Accessible name: "Arai".

## Colour (`apps/web/src/styles/tokens.css`)

| Token | Value | Use |
|---|---|---|
| `--void` | `#08080A` | the space |
| `--text` | `#F2EFEA` | primary text, primary button fill |
| `--text-2` | `#D2CED6` | secondary text, voice |
| `--muted` | `#B9B5BE` | supporting text (≈10:1 on void) |
| `--faint` | `#8E8A93` | disabled (≈5.9:1) |
| `--line` / `--line-strong` | white 10% / 22% | rules, borders |
| `--glass` | `rgb(16 15 19 / .72)` + blur | player, overlays only |
| `--danger` / `--ok` | `#FF8A7A` / `#8FD9AE` | state text, always with words |

Dark by design (no light theme). Project glows: `ambientPalette()` in
`@arai/shared` — saturation ≤ 62 %, lightness 42–49 %, near-identical hues
merged, at most 5 glows; rendered with screen blending (tests in
`packages/shared/test/ambient.test.ts`).

## Type (self-hosted via @fontsource, CSP `font-src 'self'`)

| Role | Face |
|---|---|
| Display (titles, project names) | Bricolage Grotesque Variable, 600, tight tracking |
| Interface & reading | Inter Variable |
| Voice (asides, empty states) | Fraunces Variable italic 300 |
| Timecodes, versions, keys | JetBrains Mono Variable, tabular |

## Motion

- Glows: seep in over 4.5 s, drift over 52–88 s, fade out over 3.5 s.
- Empty-state அ: opacity "breathes" over 16 s.
- Only transform/opacity animate (compositor); each glow's SVG filter is
  rasterised once.
- `prefers-reduced-motion`: everything still.
- Future: glows respond gently to playback level (Phase 2 player).

## Interaction and motion (session 7)

- Pages enter (view transitions + short rise); project covers fly between
  library and project page (shared `view-transition-name`).
- Overlays (`components/Modal.tsx`, native `<dialog>`) pop in and sink out;
  on phones they slide up as sheets. Popover menus scale in from their button.
- Lists cascade in; reorders glide (FLIP, `lib/flip.ts`).
- Track rows: whole row plays; drag handle reorders (keyboard: arrows on the
  handle); version badge opens versions + insights; ⋯ menu for actions.
- Project header: meta line → title → owner → Play / Add tracks / Edit details,
  inside a centred 820 px column (inspired by, not copied from, other
  workspaces).

## Layout

- Desktop ≥ 1024 px: transparent sidebar (logotype, nav, user) over the space;
  content column ≤ 1040 px; player bar (glass) at the bottom once built.
- Mobile: logotype header, content, solid bottom tab bar with a top rule;
  rows wrap so actions drop below text. No horizontal scroll at 320 px.
- Hit targets ≥ 44 px.

## Components (in `apps/web/src`)

`components/Logo.tsx` (Wordmark, Mark, HomeLink) · `components/Ambient.tsx`
(AmbientProvider, `useAmbient().setSources(hexes)`) · `components/Field.tsx` ·
`components/Unavailable.tsx` (provider-gated features: muted, italic "not
available yet", dashed disabled button) · buttons `.btn` / `.btn-primary`
(off-white pill) / `.btn-ghost` / `.btn-danger` · `.section` + `.row` lists ·
`.tag` · `.page-header` (display title + voice aside) · `.empty`.

Dev-only preview of the background with sample colours (not in the production
build): `npx vite` in `apps/web`, then `/dev/ambient-preview.html?c=e63946,2a9d8f`.

## Accessibility baseline (WCAG 2.2 AA)

Semantic landmarks, skip link, visible 2 px off-white focus ring, contrast
checked against `--void`, labelled controls, errors via `aria-describedby`,
dragging alternatives (when drag-and-drop arrives), reduced motion and
increased contrast respected, decorative layers `aria-hidden`.
