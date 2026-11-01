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
