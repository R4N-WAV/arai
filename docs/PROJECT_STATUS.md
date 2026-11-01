# Project Status — authoritative checklist

Last updated: 2026-11-01 (session 6). Tests: 86 passing (crypto 17, shared 4, api 60, web 5) + browser E2E: `auth-flow` (12), `projects-flow` (8), `tracks-flow` (12), `profile-import-flow` (6). `[x]` done & tested · `[~]` in progress · `[ ]` not started · `[!]` blocked.

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
- [x] Settings: sessions list/revoke/revoke-others, login history, key fingerprint (tests + E2E)
- [x] Web shell: tokens, desktop sidebar / mobile tab bar, sign in, register (recovery key step), unlock, recover, settings (E2E at 1280 & 375 px)
- [x] Provider-gated features greyed out via `/api/config` (ADR-009)
- [x] Deploy pipeline GitHub -> Cloudflare (`deploy.yml`) — **inactive until owner sets secrets/variable**
- [!] Email verification, email sign-in, email reset, email OTP — blocked: email provider + domain (deferred by owner)
- [!] SMS 2FA — blocked: paid SMS provider (deferred by owner)
- [ ] 2FA recovery codes (only meaningful once a 2FA method exists)
- [ ] Password change (signed in), username change, email change
- [x] Visual identity "ambient space" implemented (DESIGN_SYSTEM.md): hand-lettered அறை logo outlined to SVG, self-hosted fonts, ambient background engine (`ambientPalette` + `Ambient.tsx`), all screens restyled; E2E green
- [x] Logo click / reload keeps the tab unlocked (`tabvault.ts`)
- [ ] ESLint; axe accessibility checks in E2E; lazy-load crypto (main bundle 905 kB / 304 kB gz)
- [ ] Account export & deletion

## Phase 2 — Music workspace
- [x] Projects: create / list / view / edit / public↔private / delete — metadata encrypted per project key, signed self-grant, `requireProjectRole` authz, migration 0002 (11 API tests incl. cross-user, roles, revocation; E2E incl. no-plaintext check)
- [x] Project colour drives the ambient background (focus mode on the project page)
- [ ] Folders, ordering (+ keyboard alternative), favourites, recents
- [x] Encrypted chunked uploads to free-plan Durable Object storage (ADR-011): multi-file, drag-and-drop + picker, progress, cancel, resume/retry, magic-byte sniffing, quotas (migration 0003; 11 API tests)
- [x] Duration/sample rate/channels + waveform peaks extracted client-side (encrypted in version metadata)
- [x] Player: queue, play/pause, prev/next, scrubbable waveform (pointer + keyboard slider), volume, repeat, speed (pitch preserved); byte-exact lossless decrypt (E2E)
- [x] Version history: append-only (DB trigger), upload new version, play any version, make current
- [~] AIFF uploads keep the original but only play where the browser decodes AIFF (Safari); in-browser AIFF→WAV rewrap TODO
- [ ] Artwork upload (and cover colour from artwork), track rename UI, reorder tracks (+ keyboard alternative)
- [ ] Service-Worker range streaming (start playback before full download), gapless
- [ ] Version comparison (A/B), search (client-side)
- [x] Library import from Samply / Untitled downloads (ADR-012): folder, ZIP or files; projects per folder, versions grouped by name markers, colour from cover art; review/rename before import; quota-aware; runs through the encrypted upload pipeline (unit tests + E2E)
- [x] Layout centred on wide screens (content column, auth, empty states)

## Phase 3 — Privacy & collaboration
- [ ] Project key envelopes, member key grants, pending grants
- [ ] Invitations (username/email/link), roles, revoke + key rotation
- [ ] Time-coded comments, replies, resolve, per version
- [ ] Share links (fragment key, password, expiry, download/comment flags)
- [ ] Publish/unpublish (public bucket copies)

## Phase 4 — Social
- [x] Profiles (pulled forward at owner's request): display name, bio, location, up to 8 https links, profile picture + header (client re-encode, server magic-byte/size/dimension checks), public view for signed-out visitors, glow from public project colours (migration 0004; 5 API tests; E2E)
- [ ] Listening from profiles (needs public audio copies) · [ ] follows · [ ] friends · [ ] blocks/reports · [ ] discovery & FTS · [ ] notifications

## Phase 5 — Messaging
- [ ] ADR-005 final decision · [ ] DMs/groups/project chats · [ ] DO realtime · [ ] attachments · [ ] reactions/edits/deletes/receipts/typing · [ ] GIFs (configurable) · [ ] message requests

## Phase 6 — Advanced audio
- [ ] Speed/pitch independent · [ ] trim · [ ] section loop · [ ] offline encrypted cache · [ ] analytics · [ ] gapless

## Phase 7 — Administration
- [ ] CLI bootstrap · [ ] dashboard · [ ] moderation · [ ] hash-chained audit log verification · [ ] stats

## Phase 8 — Release
- [ ] Security audit · [ ] a11y audit · [ ] responsive tests · [ ] perf · [ ] deployment & backup docs · [ ] release checklist
