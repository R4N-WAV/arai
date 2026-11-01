# Arai — Architecture

Status: Phase 0 baseline (2026-11-01). Decisions are recorded as ADRs in §9;
change them only with a new ADR entry.

## 1. Overview

```
Browser (React SPA + Service Worker + libsodium WASM)
  │  all plaintext of private content exists ONLY here
  │
  │ same-origin HTTPS (cookies, JSON)            presigned URLs (ciphertext)
  ▼                                              ▼
Cloudflare Worker "arai"  ───────────────────►  R2 bucket  arai-files   (private)
  ├─ static assets (SPA build)                   R2 bucket  arai-public  (published audio/images)
  ├─ /api/*  Hono router, zod validation
  ├─ D1 (SQLite)  relational data, FTS5 for public search
  ├─ Durable Objects (SQLite)  realtime: chat rooms, presence, notifications fan-out
  ├─ Rate-limiting binding + D1 counters
  ├─ Turnstile verification
  └─ Email provider (HTTP API, e.g. Resend/Brevo) ; SMS provider (optional, paid)
```

- **Single origin**: the Worker serves the SPA (static assets, headers from
  `apps/web/public/_headers`) and `/api`. No CORS, strict CSP, cookies
  `SameSite=Strict`. Hosted at the free `arai.<subdomain>.workers.dev` until a
  custom domain exists (ADR-008). GitHub Actions deploys on push to `main`.
- **Zero-access**: private project metadata (names, descriptions, track titles,
  comments), audio, artwork, waveforms, messages and attachments are encrypted
  in the browser before upload. The server stores ciphertext plus the minimum
  operational metadata (ids, owners, sizes, timestamps, membership, roles).
- **Public content** is an explicit, user-initiated exception: publishing
  uploads plaintext copies to `arai-public`; un-publishing deletes them.

## 2. Repository layout (npm workspaces)

```
apps/web        React 18 + TypeScript + Vite SPA, service worker
apps/api        Cloudflare Worker (Hono), D1 migrations, Durable Objects
packages/shared zod schemas + types shared by web and api (API contract)
packages/crypto libsodium-based crypto module (vault, envelopes, chunked AEAD)
scripts/        admin bootstrap, ops scripts
docs/           authoritative documentation
```

## 3. Technology choices

| Concern | Choice | Why |
|---|---|---|
| Frontend | React + TS + Vite, React Router, TanStack Query | mature, small enough, typed |
| Styling | Plain CSS with design tokens (CSS custom properties) | no framework dependency, full control |
| API | Hono on Workers | tiny, typed routing, Workers-native |
| Validation | zod (shared) | one schema for client + server |
| DB | Cloudflare D1, raw parameterised SQL (`prepare().bind()`) | free 5 GB, SQL, FTS5; no ORM to audit |
| Files | R2 + presigned S3 URLs (aws4fetch) | free 10 GB, **zero egress**, ranges; bypasses Worker request quota |
| Realtime | Durable Objects + WebSocket hibernation | free on SQLite backend |
| Crypto | libsodium.js (sumo) + Web Crypto | audited, Argon2id, X25519, Ed25519, XChaCha20-Poly1305 |
| Audio | `<audio>` fed by Service Worker decrypting stream; Web Audio + AudioWorklet for pitch | native codecs, seeking, low memory |
| Metadata | `music-metadata` (browser) client-side | server cannot read private files |
| Tests | Vitest, `@cloudflare/vitest-pool-workers` (real D1/R2/DO in Miniflare), Playwright | integration tests without cloud account |
| Bot protection | Turnstile + honeypot + rate limits + email verification | free, accessible mode |

## 4. Request & auth flow

1. **Prelogin** `POST /api/auth/prelogin {identifier}` → `{kdfSalt, kdfParams}`.
   For unknown identifiers the server returns `HMAC(KDF_SALT_SECRET, identifier)`
   so responses are indistinguishable. Separate salts are stored for the
   username path and the email path (see SECURITY §3.1) to prevent linking an
   email to a username.
2. Client runs **Argon2id** (libsodium `crypto_pwhash`, 64 MiB, opslimit 3)
   → `masterKey`; HKDF splits it into `authKey` and `vaultKey`.
3. **Login** `POST /api/auth/login {identifier, authKey, turnstile?}`. Server
   computes `HMAC-SHA256(AUTH_PEPPER, authKey)` and compares in constant time.
4. Session: 256-bit random token in cookie `__Host-arai_s` (HttpOnly, Secure,
   SameSite=Strict, Path=/). DB stores `SHA-256(token)` only. Idle timeout
   7 days, absolute 30 days, rotation on privilege change.
5. Client fetches its encrypted vault and decrypts with `vaultKey`
   (private keys never leave the browser unencrypted).
6. State-changing requests require an `Origin` header equal to the request's
   own origin and `X-Arai-CSRF: 1` (defence in depth with SameSite=Strict).
7. Decrypted keys live only in memory. After a reload the session is still
   valid but the UI shows an Unlock screen; the password re-derives the vault
   key locally (`GET /api/auth/session` returns the encrypted vault).
8. While email delivery is off (ADR-009) users sign in with their username;
   email sign-in only works for verified emails.

## 5. Data model (D1)

All ids are 128-bit random (base32/ULID-like, not sequential). `enc_*`
columns are ciphertext produced client-side. Timestamps are unix ms integers.

### Identity & auth
- `users(id, username UNIQUE COLLATE NOCASE, email_normalized UNIQUE, email_verified_at, status[pending|active|restricted|suspended|banned|deleted], created_at, deleted_at)`
- `credentials(user_id PK, salt_username, salt_email, kdf_params, auth_hash_u, auth_hash_e, updated_at)` — two hashes because two salts.
- `vaults(user_id PK, enc_vault_pw, enc_vault_recovery, recovery_hint_set, version)` — account secret key wrapped by password key and by recovery key.
- `user_keys(id, user_id, device_label, x25519_pub, ed25519_pub, created_at, revoked_at)` — public keys; fingerprint shown in UI.
- `sessions(id, user_id, token_hash UNIQUE, created_at, last_seen_at, expires_at, ip_hmac, ua_summary, mfa_passed, revoked_at)`
- `login_events(id, user_id, at, success, ip_hmac, ua_summary, reason, suspicious)`
- `email_tokens(id, user_id, purpose[verify|reset|email_change|otp], token_hash, expires_at, used_at, attempts)`
- `mfa_methods(id, user_id, type[email|sms], target_enc, verified_at)` ; `recovery_codes(id, user_id, code_hash, used_at)`
- `rate_limits(key, window_start, count)` — fallback counters.

### Social
- `profiles(user_id PK, display_name, bio, location, avatar_file_id, banner_file_id, links_json, updated_at)` — public by nature.
- `privacy_settings(user_id PK, dm_policy[everyone|friends|nobody], friend_req_policy, show_followers, searchable)`
- `follows(follower_id, followee_id, created_at)` PK both.
- `friendships(user_a, user_b, created_at)` with `user_a < user_b`; `friend_requests(id, from_id, to_id, status, created_at)`
- `blocks(blocker_id, blocked_id, created_at)` ; `reports(id, reporter_id, target_type, target_id, reason, details, status, created_at, handled_by)`

### Workspace
- `projects(id, owner_id, visibility[private|public], key_version, enc_meta, public_meta_json NULL, created_at, updated_at, published_at, deleted_at)`
- `project_members(project_id, user_id, role[listener|editor|admin|owner], added_by, created_at, revoked_at)`
- `project_keys(project_id, key_version, user_id, wrapped_key, wrapped_by, created_at)` — project key sealed to each member's X25519 key.
- `folders(id, project_id, parent_id, enc_name, position)` ; `collections(id, owner_id, enc_meta)`, `collection_items(collection_id, track_id, position)`
- `tracks(id, project_id, folder_id, position, current_version_id, created_by, created_at, deleted_at)`
- `track_versions(id, track_id, number, file_id, waveform_file_id, enc_meta, created_by, created_at, restored_from)` — append-only; never overwritten.
- `files(id, owner_id, project_id NULL, kind[audio|waveform|artwork|avatar|attachment], bucket, object_key, size, chunk_size, enc_file_key, key_version, mime_claimed, status[pending|ready|deleted], created_at)` — `object_key` random, never user-derived.
- `favorites(user_id, target_type, target_id)` ; `recent_access(user_id, project_id, at)`
- `invitations(id, project_id, inviter_id, invitee_user_id NULL, invitee_email_hash NULL, role, token_hash, expires_at, accepted_at, revoked_at)`
- `pending_key_grants(project_id, user_id, created_at)` — member accepted but key not yet wrapped (an online admin's client completes it).
- `comments(id, track_id, version_id, author_id, parent_id, time_ms NULL, enc_body, resolved_at, created_at, edited_at, deleted_at)`
- `share_links(id, project_id, track_id NULL, token_hash, password_hash NULL, allow_download, allow_comments, require_account, expires_at, disabled_at, created_by)` — link key carried in URL fragment (never sent to server).
- `activity(id, project_id, actor_id, type, target_id, at)`

### Messaging
- `conversations(id, type[dm|group|project], project_id NULL, created_by, created_at, epoch)`
- `conversation_members(conversation_id, user_id, role, joined_at, left_at, last_read_message_id)`
- `conversation_keys(conversation_id, epoch, user_id, device_key_id, wrapped_key)`
- `messages(id, conversation_id, sender_id, epoch, ciphertext, reply_to, created_at, edited_at, deleted_at)` — body, reactions-on-message and attachment refs all inside ciphertext; reactions stored as `message_reactions(message_id, user_id, enc_reaction)`.
- `message_requests(conversation_id, status)`

### Notifications, analytics, admin
- `notifications(id, user_id, type, actor_id, ref_type, ref_id, created_at, read_at)` — no content, only references.
- `play_events_daily(track_id, day, plays, unique_listeners_hll)` ; listener uniqueness via daily-salted HMAC, raw ids discarded.
- `platform_roles(user_id PK, role[owner|moderator], granted_by, granted_at)` — separate from project roles.
- `moderation_actions(id, actor_id, target_user_id, action, reason, expires_at, at)`
- `audit_log(seq PK, at, actor_id, action, target, details_json, prev_hash, hash)` — hash chain, append-only (no UPDATE/DELETE path in code; triggers abort modifications).

Migrations live in `apps/api/migrations/NNNN_name.sql` (wrangler D1 migrations).

## 6. Free-tier budget and limits (verified 2026-11)

| Service | Free allowance | Impact on Arai |
|---|---|---|
| Workers | 100k requests/day, 10 ms CPU/request | Audio bytes never pass through the Worker (presigned R2 URLs). Heavy crypto runs client-side. |
| D1 | 5 GB, 5M rows read/day, 100k rows written/day | Fine for early users; queries over limit fail → monitor. |
| R2 | 10 GB free but **requires a card on file** | Not used (ADR-011). |
| Durable Objects SQLite storage | 5 GB total on the free plan, no card | Encrypted audio (ADR-011): 4.5 GB platform cap, 500 MB/user. |
| Durable Objects (SQLite) | 100k requests/day, 13k GB-s/day | Realtime chat/presence for small community. |
| Turnstile | free | bot challenge |
| Email (Resend free: 3,000/mo, 100/day; Brevo free: 300/day) | free | **Deferred** (ADR-009). Requires a sending domain (≈ $10/yr) for deliverability. |
| SMS (Twilio etc.) | **no free production tier** | SMS 2FA implemented behind provider interface, disabled until configured & paid. |
| Hosting domain | `*.workers.dev` free | Used now (ADR-008). Custom domain later, no code changes. |

## 7. Audio pipeline

- **Upload** (browser): sniff magic bytes (RIFF/WAVE, ID3/MPEG sync, fLaC,
  FORM/AIFF, ftyp M4A, OggS) → reject mismatches; extract metadata
  (`music-metadata`); compute waveform peaks (decode via Web Audio, or
  streaming for large files); generate random file key; encrypt in 1 MiB
  chunks (XChaCha20-Poly1305, nonce = random prefix ‖ chunk index, AAD = file
  id ‖ chunk index ‖ final flag); multipart PUT to presigned R2 URLs; report
  completion; server verifies object size matches the declared chunk layout.
- **Playback**: page passes file key to the Service Worker (postMessage, kept in
  memory); `<audio src="/_stream/<fileId>">`; SW maps byte ranges to chunks,
  fetches ciphertext ranges via presigned URLs, decrypts, returns `206`
  responses. Original bytes are reproduced bit-exactly → lossless where the
  browser decodes the codec. AIFF (unsupported in Chromium/Firefox) is
  re-wrapped client-side as WAV PCM for playback only; the original stays intact.
- **Speed** via `playbackRate` + `preservesPitch`; **pitch** independent via
  Web Audio graph with a time-stretch AudioWorklet (SoundTouch port, LGPL —
  evaluated in Phase 6). Trimming/looping are non-destructive (stored as
  encrypted region metadata).
- **Offline**: encrypted chunks cached in Cache Storage; keys in IndexedDB
  wrapped by a non-extractable device key + require vault unlock.

## 8. Realtime

One Durable Object per conversation (fan-out of ciphertext, typing, receipts)
and one per user (notifications, presence). WebSocket auth via short-lived
ticket from `/api/realtime/ticket` (cookie-authenticated), validated by the DO.

## 9. Architecture Decision Records

- **ADR-001 Cloudflare over Supabase/Vercel.** Supabase free: 500 MB DB, 1 GB
  storage, projects pause after a week idle, auth uses bcrypt. Vercel/Netlify:
  function limits and egress costs for audio. Cloudflare gives zero egress,
  no sleeping, DO realtime, all free. Trade-off: 10 ms CPU and vendor lock-in
  (mitigated: SQL is portable SQLite, R2 is S3-compatible, Hono runs on Node).
- **ADR-002 Client-side Argon2id + server keyed hash.** Argon2id (≥64 MiB)
  cannot run within 10 ms Worker CPU. Since zero-access encryption already
  requires a client-side password KDF, Argon2id runs in the browser; the server
  stores `HMAC-SHA256(pepper, authKey)`. A DB-only compromise yields nothing
  testable without the pepper; with the pepper every guess still costs one
  Argon2id. Server never sees the password. (Same family as Bitwarden/1Password
  designs.) Requires JS + WASM for login — documented accessibility note.
- **ADR-003 Presigned R2 URLs for file bytes.** Keeps the Worker under the
  daily request quota; URLs expire in ≤5 min and only ever expose ciphertext
  (private) or intentionally public files.
- **ADR-004 Envelope encryption.** file key → wrapped by project key (versioned)
  → sealed to each member's X25519 key. Revocation rotates the project key and
  re-wraps file keys (cheap); optional full re-encryption.
- **ADR-005 Messaging protocol.** Target: MLS (RFC 9420) via `ts-mls` if it
  passes review in Phase 5 (test vectors, maintenance, licence). Fallback:
  Megolm-style sender keys on libsodium primitives with rotation on every
  membership change — documented as lacking per-message forward secrecy.
  Decision is finalised at the start of Phase 5 and recorded here.
- **ADR-006 Raw SQL, no ORM.** All queries parameterised via D1 bindings; a
  lint rule/test forbids template-string SQL with interpolation.
- **ADR-007 Admin bootstrap by CLI only.** `scripts/admin-bootstrap.ts` runs
  through `wrangler d1 execute` with the operator's Cloudflare credentials; it
  only succeeds if no platform owner exists and writes an audit entry. No
  HTTP endpoint can create platform roles from nothing.
- **ADR-008 Host on workers.dev, deploy from GitHub; not GitHub Pages.**
  (2026-11-01) Owner first proposed GitHub Pages. Rejected: github.io and
  workers.dev are different sites, so session cookies become third-party and
  are blocked by Safari/Firefox by default; Pages also cannot send security
  headers (CSP frame-ancestors, HSTS, nosniff). Instead the Worker serves the
  SPA on the free workers.dev subdomain and `.github/workflows/deploy.yml`
  deploys on push to `main`. Server secrets are generated in the deploy job on
  first run and stored only in Cloudflare.
- **ADR-009 Provider-gated features are flagged off and greyed out.**
  (2026-11-01) Email delivery and SMS are postponed by the owner.
  `FEATURE_EMAIL` / `FEATURE_SMS` (wrangler vars, default `off`) are exposed via
  `GET /api/config`; the UI renders dependent features (verify email, email
  sign-in, email reset, email OTP, SMS OTP) disabled with a "Not available yet"
  badge. Consequences, by design: accounts are active without verification;
  emails are unique only once verified (partial unique index) so unverified
  addresses can't be squatted or enumerated; password reset works without
  email via the recovery key (`/api/auth/recover/challenge` + `/recover`).
- **ADR-010 Client-generated project ids; signed key grants.** (2026-11-01)
  The browser generates each project's 128-bit id so it can be bound into the
  metadata AEAD context (`project/<id>/meta`) before the first request. Every
  wrapped project key carries the granter's Ed25519 signature over
  (scope, id, key version, recipient, hash of sealed box); clients verify it
  before use and verify their own grants against the locally held signing key.
  Outsiders get 404 for any project (existence never leaks); members lacking
  a role get 403.
- **ADR-011 Audio in free-plan Durable Objects, not R2.** (2026-11-01)
  The owner does not want any service that can charge a card automatically;
  R2 requires a payment method. Encrypted 1 MiB chunks are stored in a
  SQLite-backed Durable Object (`FileStore`, one per project; free plan, no
  card, hard limits instead of bills). Chunks go through the Worker (no
  presigned URLs), so each chunk costs one Worker + one DO request (free:
  100k/day each). Capacity: 5 GB total → platform cap 4.5 GB
  (`PLATFORM_QUOTA_BYTES`), 500 MB per user (`USER_QUOTA_BYTES`), 250 MB per
  file. Playback currently downloads + decrypts the whole file into a blob URL
  (byte-exact, lossless); Service-Worker range streaming is a later
  optimisation. Storage sits behind `FileStore` so R2/B2 can replace it later.
- **ADR-012 Library import from downloads, not account linking.** (2026-11-01)
  Untitled has no public API and Samply's API could not be verified for
  third-party bulk export (and would require handing Arai a session/API key,
  plus server-side fetching that would see plaintext). Import therefore reads
  what users download from those services (folders, ZIPs via fflate streaming
  in the page — no workers, CSP-safe) entirely in the browser
  (`apps/web/src/lib/importer.ts`), plans projects/tracks/versions, lets the
  user review and rename, then uses the normal encrypted upload pipeline. If
  either service later offers an official export API, an adapter can feed the
  same plan.
- **ADR-013 Profiles are public data in D1.** Profile text and images are
  public by design and stored unencrypted (images ≤300 KB / ≤900 KB in D1).
  Images are re-encoded client-side (strips EXIF/GPS) and validated
  server-side (magic bytes, size, pixel dimensions ≤512 / ≤1800 to stop
  decompression bombs). Links must be https without credentials and render
  with `rel="noopener noreferrer nofollow ugc"`.
- **ADR-014 Streaming playback via Service Worker.** (2026-11-01) The owner
  required instant, track-to-track playback. A module service worker answers
  Range requests for `/_stream/<token>` by fetching + decrypting 1 MiB chunks
  (2-chunk read-ahead, small in-memory plaintext LRU) so `<audio>` starts after
  the first chunk; the next queue item is pre-warmed. Built as a second Vite
  entry emitted at `/sw.js`.
- **ADR-015 Auto-deploy.** (2026-11-01) At the owner's request the deploy
  workflow also runs on pushes to the development branch, so finished work is
  live without manual steps.
