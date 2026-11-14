# Session Log

## Session 1 — 2026-11-01
- Phase 0 complete: feature research (reference sites blocked by sandbox network, used search results), feature matrix, architecture + ADR-001…007, schema, threat model & crypto design, design system, cost/limits.
- Phase 1 started: npm workspaces; `packages/crypto` (libsodium) with 13 tests; `apps/api` Worker (Hono) with security headers, CSRF/origin guard, body limit, opaque errors; migration 0001; hash-chained audit log; 10 Workers-runtime tests (Miniflare D1).
- Bug found by tests and fixed: username CHECK used a GLOB that only validated the first character.
- Tooling notes: npm 10.9 arborist crashes on vitest's optional peers → `.npmrc legacy-peer-deps=true`. `@cloudflare/vitest-pool-workers` is deprecated → use `@cloudflare/vitest-plugin`.

## Session 2 — 2026-11-01
- Owner decisions: has a Cloudflare account; domain later; email verification and SMS 2FA deferred → grey out. Proposed GitHub Pages; chose workers.dev + GitHub Actions deploy instead (ADR-008, cookies would be third-party on Pages).
- Built auth API (register, prelogin, login, logout, session, sessions list/revoke, login history, email-less recovery-key reset), `@arai/shared` contract, provider feature flags + `/api/config` (ADR-009).
- Schema change (pre-deploy, edited 0001 in place): status defaults to active; email unique only when verified; `recovery_auth_hash`.
- Built `apps/web`: tokens/CSS, app shell (sidebar / mobile tab bar), sign in, register with recovery-key step, unlock-after-reload, recover, settings with greyed-out email/SMS features. Argon2id runs in a Web Worker.
- CSRF origin check now compares with the request's own origin (no APP_ORIGIN config).
- Tests: crypto 14, api 33, browser E2E 10 steps — all green. Deploy workflow added (inactive until secrets/variable set).
- Gotcha: `pkill -f <pattern>` in a Bash call kills the calling shell if the pattern appears in the command; run `wrangler dev` with run_in_background instead.

## Session 3 — 2026-11-01
- Deployed: owner set up Cloudflare (D1 id committed in wrangler.jsonc; token + account id as GitHub secrets). Live at https://arai.ranuj-s.workers.dev (deploy run 41337995261, secrets auto-created).
- Bug: clicking the logo did a full reload and required unlocking. Fixed: brand links use router `<Link>`; added tab-scoped unlock persistence (`lib/tabvault.ts`, SECURITY §3.5). E2E extended (logo click, reload, new tab) — 12 steps pass.
- Design: owner wants a stronger identity — ambient space with project colours flowing in like paint, animated. Mockups on the design canvas (see HANDOFF task 0); implementation waits for feedback. Discarded an earlier uncommitted "room" theme attempt.
- Gotcha: changing the D1 database_id creates a fresh local DB — rerun `wrangler d1 migrations apply arai --local`.
- Owner approved the ambient-space direction (after revisions: Tamil hand-lettered logo only; remove AI-looking details). Implemented: `scripts/build-logo.mjs` outlines அறை/அ from Kavivanar via HarfBuzz → `logoPaths.ts` + favicon; self-hosted fonts; `ambientPalette` in @arai/shared (4 tests; caught "bad" parsing as hex); `Ambient.tsx` background (empty = grain + faint அ; projects = ink-edged drifting glows); all pages restyled; dev-only `/dev/ambient-preview.html`. Vite `assetsInlineLimit: 0` so fonts never become `data:` URIs (CSP caught it). E2E 12/12 green.

## Session 4 — 2026-11-01
- Phase 2 start (no R2 yet): encrypted projects end to end. Migration 0002 (projects, project_members, project_keys); `@arai/crypto` signed key grants (3 tests); `@arai/shared` project schemas (b64 moved to `encoding.ts` to avoid an import cycle); `routes/projects.ts` with `requireProjectRole`; 11 API tests; web: ProjectsProvider (decrypt/verify), Library grid with typographic colour covers + filters, New project form (colour swatches, visibility with warning), Project page (edit, public/private confirm, typed-name delete). Ambient background now follows real project colours.
- E2E `projects-flow.mjs` verifies the private name/description never appear in any request body.
- Next: owner enables R2 → uploads, player, versions.

## Session 5 — 2026-11-01
- Owner declined R2 (no automatic card charges). ADR-011: audio stored encrypted in a free-plan SQLite Durable Object (`FileStore`, per project) with quotas (500 MB/user, 4.5 GB platform, 250 MB/file).
- Built: migration 0003 (files, tracks, append-only track_versions); file register → chunk PUT (exact sizes) → complete; chunk GET (listener+, immutable private cache); tracks/versions API; storage purge on track/project delete; 11 API tests (55 total).
- Web: `lib/audio.ts` (magic-byte sniff, Web Audio analysis), `lib/tracks.ts` (UploadJob with resume/retry, decrypt-to-blob playback), `lib/player.tsx` + PlayerBar + scrubbable Waveform, TracksSection (drop zone, uploads, track list, versions, delete).
- E2E `tracks-flow.mjs`: ciphertext-only chunks, byte-identical decrypt, keyboard seek, speed, versions, fake-file rejection, mobile fit. CSP `connect-src` gained `blob:`.
- Fixed during testing: waveform overflow in the player; player now clears when its track is deleted.

## Session 6 — 2026-11-01
- Owner requests: centre the layout; import from Samply/Untitled; profiles with pictures and headers now.
- Layout: content column, auth panel, empty states and the faint அ are centred (E2E asserts equal side space at 1440 px).
- Profiles: migration 0004, `routes/profiles.ts` (public GET, own edit, images with magic-byte + dimension checks in `lib/images.ts`), web ProfileView / EditProfile / public visitor page, ambient glow from public project colours. Bug caught by E2E: D1 returns BLOBs as number arrays → images served empty; fixed + test now checks bytes. Second bug: uploading a picture reset unsaved form text; fixed.
- Import (ADR-012): `lib/importer.ts` (folder/drag/ZIP via fflate, version grouping, cover colour) + Import page (review, rename, progress) + 5 unit tests + E2E.

## Session 7 — 2026-11-01
- Owner feedback round: cropping, neutral wording for other platforms, instant playback, detailed waveforms, drag reorder, no fingerprint, motion, keyboard media keys, project page with only Edit details / Add tracks (overlays), row click to play, version insights; auto-deploy; Samply screenshot as layout inspiration.
- Built: streaming service worker (ADR-014), canvas waveform (peak+RMS), BS.1770 loudness + peak + bit depth, Modal/Menu/ImageCropper components, FLIP reorder, Media Session + shortcuts, compact project page + sidebar project list, view transitions and motion system; deploy on branch push (ADR-015).
- Bugs found by tests: drag hit-test used animated boxes (order bounced back) → use offsetTop; duplicate dialog title ids mislabelled overlays → useId.

## Session 8 — 2026-11-01
- Owner feedback (mobile screenshot): track menu covered by rows (entrance animations left transforms → stacking contexts; fixed with fill-mode backwards + raised row; phones get a bottom-sheet menu), cluttered buttons (icon+label, labels hidden on phones, one row), cover art as hero on mobile (~78vw), universal playback (providers moved above the router; E2E proves music continues across pages), avatar picture in the shell (`lib/me.tsx`), smooth drag (row follows pointer each frame, midpoint swaps, FLIP neighbours, edge auto-scroll, settle animation), general mobile rhythm.

## Session 9 — 2026-11-02
- Owner: home-screen app showed Safari bars; no back button on mobile. Added manifest (display standalone), apple-mobile-web-app meta + black-translucent status bar, generated icons (180/192/512 + maskable) from the outlined அ, viewport-fit=cover with safe-area padding, overscroll none; Back button (mobile bar + desktop content) on non-tab routes; creating a project replaces the form in history. E2E covers manifest and back navigation.
- Note for users: an app added before this deploy must be removed and re-added from the home screen; installed apps keep their own sign-in (separate from Safari).

## Session 10 — 2026-11-02
- Owner (home-screen screenshot): blur smearing content at the top, choppy/rigid scrolling.
- Cause: the sticky mobile bar used `backdrop-filter` under the translucent status bar, and every scroll frame re-composited full-screen SVG displacement filters + live feTurbulence grain behind it; `overscroll-behavior: none` removed iOS rubber-band, so scrolling felt hard.
- Fix: solid top bar with a short fade below it; native bounce restored; on phones/coarse pointers the ambient glows are plain CSS radial gradients (no SVG filters, normal blending) and the grain is a static 128 px tile (`scripts/build-grain.mjs`); ambient layer promoted to its own compositor layer (`contain: strict`); no backdrop blur on the player, tab bar or overlay backdrop on phones; momentum scrolling in overlays, menus and the project list.
- Verified: typecheck, 86 unit/API tests, all 4 E2E flows; mobile screenshots at 390×844.

## Session 11 — 2026-11-02
- Owner: the player bar covered the end of the library (one project could not be fully read at the bottom). Cause: hard-coded bottom padding that ignored the home-indicator inset and the real player height.
- Fix: `AppShell` measures the fixed bottom chrome (player + tab bar) with a ResizeObserver and sets `--chrome-bottom`; page content and mobile menu sheets are offset by it. Phone player made more compact (smaller thumb/buttons, 26 px waveform).
- E2E (`tracks-flow`): scrolls to the bottom of the project page and the library at 375 and 1280 px and asserts every content element ends above the player/tab bar.

## Session 12 — 2026-11-02
- Owner: phases 3–7 automatically.
- Phase 3: keyring + key versions, invitations, roles, removal → rotation, encrypted time-coded comments, share links (fragment secret, password, expiry, guest comments), public listening (migration 0005).
- Phase 4: follows, friends, blocks, reports, notifications/Activity, FTS5 discovery (migration 0006).
- Phase 5: E2EE DMs/groups/project chats, per-user realtime hub, attachments, reactions, edits/deletes, read receipts, typing, message requests; GIFs greyed out (migration 0007).
- Phase 6: varispeed, trim, A–B loop, offline copies, play counts (migration 0008). Phase 7: admin CLI, dashboard, moderation actions, restricted/suspended enforcement.
- Bugs found by E2E and fixed: "a editor" grammar; People/Share dialogs reset on project refresh; message menus remounted by read receipts (thread reloaded on every conversation refresh); WebSocket response headers immutable under the security-header middleware; typing indicator only fired on key presses.

## Session 13 — 2026-11-02
- Owner feedback: stay signed in until sign-out; artwork upload now; unreadable native dropdown on desktop; grain looked thrown on top; continue through phase 14 (spec defines 0–8; phases 9–14 defined from the backlog in PROJECT_STATUS).
- Remembered devices (migration 0009 `sessions.device_secret`, double-wrapped keys, 400-day sessions), artwork (encrypted, public copy, share payload, import uses cover art, colour from the dominant hue), dropdown colours, grain only inside colour (overlay 0.28) and no cover noise. `admin.mjs` accepts "@name".
- Phase 8: oxlint (typescript-eslint lacks TS 7 support), code splitting (548 → 318 kB), axe audit (fixed cover-title contrast), RUNBOOK + RELEASE_CHECKLIST.
- Phase 9: change password/username, data export, download original, account deletion. Phase 10: encrypted prefs (pins, folders, recents), library search incl. track titles, sort.
- Phase 11: A/B compare (Web Audio, loudness-matched), AIFF→WAV. Phase 12: dual-element gapless handoff (~+36 ms measured), AudioWorklet pitch shift.
- Phase 13: Web Push with empty pushes (VAPID), badge, update banner. Phase 14: welcome guide, shortcut sheet, /privacy, /help.
- Mistakes caught and fixed: a pushed lint error (unused state) and a pushed typecheck error (node:crypto in the API vitest config), both made the deploy job refuse that commit; fixed immediately. CompareDialog needed AudioContext.resume(); handoff readiness used readyState instead of an event streams may not fire.

## Session 14 — 2026-11-14
- Owner: finish all phases; Dropbox/Google Drive storage; iOS top blur; guide as an overlay reopened from Help; artwork on the lock screen.
- iOS: `black-translucent` status bar let content scroll under the clock on pages without the sticky bar, and a 20 px fade under the bar read as blur → solid black status bar (needs re-adding the Home Screen app), hairline instead of fade, sticky edge on public pages.
- Media Session artwork; guide overlay with spotlights + Help button (dismissal saved immediately: a quick reload used to bring it back); track rename; TOTP 2FA + recovery codes; invite links; bring-your-own storage (Dropbox E2E with a local mock; Drive untested end to end).
- Player listeners now attach once to both audio elements (no gap between re-binds). A "flaky" gapless test was actually the test: concurrent uploads make track order nondeterministic.
- Mistake: a scripted edit truncated `lib/tracks.ts` (it had no uncommitted changes; restored from git, edit redone).
