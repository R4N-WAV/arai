# Project Status — authoritative checklist

Last updated: 2026-11-01 (end of session 1). Tests: 23 passing (crypto 13, api 10). `[x]` done & tested · `[~]` in progress · `[ ]` not started · `[!]` blocked.

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
- [ ] Prelogin / register / verify email / login / logout / sessions API (+ tests incl. enumeration parity)
- [ ] Rate limiting + Turnstile + honeypot
- [ ] Email provider adapter (console adapter in dev, clearly labelled)
- [ ] Password reset with recovery-key flow and data-loss acknowledgement
- [ ] 2FA: email OTP, recovery codes; SMS adapter (disabled without provider)
- [ ] Settings: sessions list/revoke, login history, password/email/username change
- [ ] Web shell: tokens, layout (desktop/tablet/mobile), auth screens, axe tests

## Phase 2 — Music workspace
- [ ] Projects CRUD (encrypted meta), folders, ordering (+ keyboard alternative)
- [ ] Chunked encrypted upload via presigned R2 (progress/cancel/retry, magic-byte sniff)
- [ ] Metadata extraction, waveform peaks, artwork
- [ ] Service Worker decrypting stream + player (queue, seek, volume, loop)
- [ ] Version history (append-only, restore, compare)
- [ ] Favourites, recents, search (client-side for private)

## Phase 3 — Privacy & collaboration
- [ ] Project key envelopes, member key grants, pending grants
- [ ] Invitations (username/email/link), roles, revoke + key rotation
- [ ] Time-coded comments, replies, resolve, per version
- [ ] Share links (fragment key, password, expiry, download/comment flags)
- [ ] Publish/unpublish (public bucket copies)

## Phase 4 — Social
- [ ] Profiles + images, links · [ ] follows · [ ] friends · [ ] blocks/reports · [ ] discovery & FTS · [ ] notifications

## Phase 5 — Messaging
- [ ] ADR-005 final decision · [ ] DMs/groups/project chats · [ ] DO realtime · [ ] attachments · [ ] reactions/edits/deletes/receipts/typing · [ ] GIFs (configurable) · [ ] message requests

## Phase 6 — Advanced audio
- [ ] Speed/pitch independent · [ ] trim · [ ] section loop · [ ] offline encrypted cache · [ ] analytics · [ ] gapless

## Phase 7 — Administration
- [ ] CLI bootstrap · [ ] dashboard · [ ] moderation · [ ] hash-chained audit log verification · [ ] stats

## Phase 8 — Release
- [ ] Security audit · [ ] a11y audit · [ ] responsive tests · [ ] perf · [ ] deployment & backup docs · [ ] release checklist
