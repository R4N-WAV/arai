# Project Status — authoritative checklist

Last updated: 2026-11-02 (session 12). Tests: 106 passing (crypto 20, shared 4, api 77, web 5) + browser E2E: `auth-flow`, `projects-flow`, `tracks-flow`, `profile-import-flow`, `collab-flow` (15), `messages-flow` (8), `audio-admin-flow` (7). `[x]` done & tested · `[~]` in progress · `[ ]` not started · `[!]` blocked.

## Phase 0 — Research & architecture
- [x] Repository inspected (empty, greenfield)
- [~] Reference research (search-based; live sites blocked by sandbox network — re-verify in Phase 8)
- [x] Feature matrix — `docs/FEATURE_MATRIX.md`
- [x] Infrastructure selected (Cloudflare Workers/D1/R2/DO, free tier) — `ARCHITECTURE.md §6, ADR-001`
- [x] Database schema designed — `ARCHITECTURE.md §5`
- [x] Security architecture & threat model — `docs/SECURITY.md`
- [x] Design system defined — `docs/DESIGN_SYSTEM.md`
- [x] Financial limitations documented — `ARCHITECTURE.md §6`, `REMAINING_TO_V1.md`

## Phase 1 — Technical foundation
- [~] Monorepo scaffold — npm workspaces, TS strict, Vitest, CI + Dependabot done; ESLint not yet added
- [~] Worker + Hono + security headers/CSP + origin/CSRF guard + body limit + opaque errors (tested); static assets serving waits for `apps/web`
- [x] D1 migration 0001 (identity, credentials, vaults, keys, sessions, tokens, MFA, rate limits, platform roles, audit log) — DB-level uniqueness/format/single-owner/append-only tested
- [x] Hash-chained audit log (`apps/api/src/lib/audit.ts`) + tamper tests
- [x] `packages/crypto`: Argon2id KDF w/ downgrade floor, HKDF split, AEAD blobs w/ context binding, vault wrap/unwrap, recovery key codec, sealed boxes, signatures, fingerprints, chunked random-access file encryption (13 tests)
- [x] Prelogin / register / login / logout / session API with enumeration parity, cookie hardening, expiry, new-device flag (tests)
- [x] Rate limiting (per IP-HMAC + per account) + honeypot (tests); Turnstile adapter written, **not yet configured** (owner: add keys)
- [x] Password reset with recovery key (email-less) + data-loss acknowledgement at signup (tests + E2E)
- [x] Settings: sessions list/revoke/revoke-others, login history (key fingerprint UI removed at owner's request; see SECURITY §6)
- [x] Web shell: tokens, desktop sidebar / mobile tab bar, sign in, register (recovery key step), unlock, recover, settings (E2E at 1280 & 375 px)
- [x] Provider-gated features greyed out via `/api/config` (ADR-009)
- [x] Deploy pipeline GitHub -> Cloudflare (`deploy.yml`) — **inactive until owner sets secrets/variable**
- [!] Email verification, email sign-in, email reset, email OTP — blocked: email provider + domain (deferred by owner)
- [!] SMS 2FA — blocked: paid SMS provider (deferred by owner)
- [ ] 2FA recovery codes (only meaningful once a 2FA method exists)
- [x] Password change, username change (Phase 9) · [!] email change (needs email delivery to verify)
- [x] Visual identity "ambient space" implemented (DESIGN_SYSTEM.md): hand-lettered அறை logo outlined to SVG, self-hosted fonts, ambient background engine (`ambientPalette` + `Ambient.tsx`), all screens restyled; E2E green
- [x] Logo click / reload keeps the tab unlocked (`tabvault.ts`)
- [ ] ESLint; axe accessibility checks in E2E; lazy-load crypto (main bundle 905 kB / 304 kB gz)
- [x] Account export & deletion (Phase 9)

## Phase 2 — Music workspace
- [x] Projects: create / list / view / edit / public↔private / delete — metadata encrypted per project key, signed self-grant, `requireProjectRole` authz, migration 0002 (11 API tests incl. cross-user, roles, revocation; E2E incl. no-plaintext check)
- [x] Project colour drives the ambient background (focus mode on the project page)
- [ ] Folders, ordering (+ keyboard alternative), favourites, recents
- [x] Encrypted chunked uploads to free-plan Durable Object storage (ADR-011): multi-file, drag-and-drop + picker, progress, cancel, resume/retry, magic-byte sniffing, quotas (migration 0003; 11 API tests)
- [x] Duration/sample rate/channels + waveform peaks extracted client-side (encrypted in version metadata)
- [x] Player: queue, play/pause, prev/next, scrubbable waveform (pointer + keyboard slider), volume, repeat, speed (pitch preserved); byte-exact lossless decrypt (E2E)
- [x] Version history: append-only (DB trigger), upload new version, play any version, make current
- [~] AIFF uploads keep the original but only play where the browser decodes AIFF (Safari); in-browser AIFF→WAV rewrap TODO
- [ ] Artwork upload (cropper ready; needs encrypted image files), track rename UI
- [x] Service-Worker range streaming: playback starts after the first decrypted chunk (~1.4 s locally incl. key setup); next track pre-warmed; blob fallback (`src/sw.ts`, `lib/stream.ts`)
- [x] Detailed canvas waveforms (1600 buckets, peak + RMS); loudness (BS.1770 LUFS), sample peak, bit depth in version insights
- [x] Track reorder by drag (live FLIP) and keyboard on the handle; persisted; row click plays; ⋯ menu per track
- [x] Keyboard media controls (Space/K, ←/→, Shift+←/→, ↑/↓, M, R) + Media Session (OS media keys)
- [x] Project page: Play / Add tracks / Edit details; overlays for edit (incl. visibility + delete) and add tracks; sidebar project list
- [x] Image scale-and-crop for profile picture and header (drag, zoom, pinch, keyboard)
- [x] Motion: page view-transitions, shared cover transition, staggered lists, overlay/menu animations, tactile buttons (reduced-motion respected)
- [x] Universal playback: player/projects/profile providers live above the router, music continues across every page (E2E)
- [x] Mobile: cover-first project hero, single-row icon actions, calm rows, menus as bottom sheets; avatar picture in shell; smooth pointer-following drag with edge auto-scroll
- [x] Installable app: web manifest (standalone), iOS home-screen meta, app icons from the அ mark (`scripts/build-icons.mjs`), safe-area padding; Back button on all non-tab pages (mobile bar + desktop)
- [x] Home-screen app polish: solid top bar (no backdrop blur smearing content at the status bar), native rubber-band scrolling restored, lightweight ambient on phones (CSS gradients, static grain tile, no live SVG filters) for smooth 60 fps scrolling
- [ ] Version comparison (A/B), search (client-side) — gapless tracked in Phase 6
- [x] Library import from Samply / Untitled downloads (ADR-012): folder, ZIP or files; projects per folder, versions grouped by name markers, colour from cover art; review/rename before import; quota-aware; runs through the encrypted upload pipeline (unit tests + E2E)
- [x] Layout centred on wide screens (content column, auth, empty states)

## Phase 3 — Privacy & collaboration
- [x] Keyring: every member holds all key versions they were granted; tracks/versions/comments/files record their key version (migration 0005)
- [x] Invitations by username (all key versions sealed + signed), accept/decline in the library, pending shown in People; roles listener/editor/admin with owner/admin rules (8 API tests + collab E2E)
- [x] Remove member / leave / decline → key rotation for exactly the remaining members (admin client, automatic); old content still decrypts
- [x] Time-coded comments per version: replies (one level), resolve/reopen, edit, delete, waveform markers, jump-to-time; encrypted
- [x] Share links: fragment secret, optional password, expiry, download button, guest comments; payload refreshed when tracks change; streaming via the service worker with a share token
- [x] Public listening for public projects (published link; not E2EE by design, stated in the UI) — profiles and Discover link to `/listen/<id>`
- [ ] Invite by email or invite link (email provider-gated)

## Phase 4 — Social
- [x] Profiles (session 6) · [x] listening from profiles · [x] follows · [x] friends (request/accept) · [x] blocks (end follows/friendships, hide from lookup) · [x] reports · [x] FTS5 discovery of public projects and people · [x] notifications (Activity page, bell with unread count)

## Phase 5 — Messaging
- [x] E2EE DMs, groups (admin add/remove, rotation on leave) and project chats (project keyring) (migration 0007; 5 API tests; messages E2E)
- [x] Realtime via per-user Durable Object hub (hibernating WebSockets): messages, edits, deletes, reactions, typing, read receipts
- [x] Encrypted attachments up to 25 MB (quota-counted) · [x] reactions (fixed set) · [x] edit / delete for everyone · [x] message requests · [x] report message with optional evidence
- [!] GIFs — greyed out until a GIF provider key is configured (`FEATURE_GIFS`, `GIF_API_KEY`)

## Phase 6 — Advanced audio
- [x] Varispeed (pitch follows speed) alongside pitch-preserving speed · [ ] independent pitch shift (needs a DSP worklet)
- [x] Non-destructive trim per version (encrypted in track metadata) · [x] A–B section loop
- [x] Offline copies (ciphertext in Cache Storage; service worker falls back to it) with management in Settings
- [x] Play counts (daily per-track totals, member vs link; shown in insights) (migration 0008)
- [ ] Gapless (sample-accurate) playback · [ ] A/B version compare

## Phase 7 — Administration
- [x] CLI bootstrap `scripts/admin.mjs` (grant-owner, grant-moderator, revoke, list, verify-audit)
- [x] Dashboard `/admin`: stats, reports queue with actions (dismiss, hide/unhide project, restrict, suspend, reactivate, ban [owner], remove comment/message), moderators (owner), audit log with live chain verification
- [x] Restricted accounts cannot publish, share or start conversations; suspended/banned accounts are signed out everywhere

## Phase 8 — Testing & release
- [x] Lint (oxlint; correctness errors fail CI and deploy) · [x] route-level code splitting (main bundle 548 → 318 kB)
- [x] Accessibility: axe (WCAG 2.0–2.2 A/AA) on 13 screens + overlays at 360/768/1280 px — zero serious/critical (`e2e/a11y-flow.mjs`); fixed cover-title contrast
- [x] Security suite mapping (RELEASE_CHECKLIST.md) · [x] RUNBOOK.md (deploy, secrets, backups, restore drill, incidents, capacity) · [x] RELEASE_CHECKLIST.md
- [ ] Manual device pass (iPhone/Android/Safari/Firefox) and first restore drill — owner, see checklist

## Phases 9–14 (defined in session 13; the original spec ends at phase 8)
The owner asked to continue to phase 14. These phases take the remaining backlog in a sensible order.

### Phase 9 — Account control
- [x] Change password (account key re-wrapped in the browser; other sessions signed out) · [x] change username · [x] download my data (decrypted JSON) + “Download original” per track · [x] delete account (owned projects purged, messages/comments erased, name freed) — 3 API tests, account E2E

### Phase 10 — Library organisation
- [ ] Search (client-side over decrypted names, tracks, tags) · [ ] pin favourites · [ ] recently played · [ ] sort · [ ] folders

### Phase 11 — Version tools
- [ ] A/B compare two versions (same position, loudness-matched, instant switch) · [ ] AIFF → WAV in the browser for playback everywhere

### Phase 12 — Playback engine
- [ ] Gapless playback between tracks · [ ] independent pitch shift (semitones, speed unchanged)

### Phase 13 — Notifications & installed app
- [ ] Web Push (VAPID) for messages, invitations and comments, opt-in per device · [ ] app icon badge · [ ] "new version available" prompt

### Phase 14 — Help, privacy & onboarding
- [ ] First-run guide · [ ] keyboard shortcut sheet · [ ] plain-language privacy page (what is encrypted, what the server sees) · [ ] help page
