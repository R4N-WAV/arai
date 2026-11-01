# Handoff — how to continue

## Start of every session
1. Read this file, `docs/PROJECT_STATUS.md`, the last entry of `docs/SESSION_LOG.md`.
2. `npm install` then `npm test` and `npm run typecheck` — both must be green before new work.
3. Open only the files listed for the next task below.

## Current state (end of session 1)
- Phase 0 done. Phase 1 in progress: crypto package, Worker skeleton, migration 0001, audit log done and tested.
- No auth endpoints, no web app yet. Nothing is deployed. No Cloudflare account configured.

## Layout
- `packages/crypto/src/index.ts` (KDF, AEAD, vault, keys), `chunks.ts` (file encryption). Tests in `packages/crypto/test/`.
- `apps/api/src/index.ts` (Hono app), `src/lib/security.ts` (headers, CSP, origin guard), `src/lib/audit.ts`, `src/lib/ids.ts`, `src/env.ts`.
- `apps/api/migrations/0001_identity.sql`. Migration 0001 is **not yet deployed**, so it may still be edited; after first deploy, only add new migrations.
- Tests run in the Workers runtime via `@cloudflare/vitest-plugin` (`apps/api/vitest.config.ts`, test secrets defined there; `test/env.d.ts` types `env`/`exports`).

## Next concrete task (Phase 1, batch 2: authentication API)
Create `packages/shared` (zod schemas: username 3–30 `[A-Za-z0-9_.]`, password ≥8 with letter+digit checked **client-side** since server only sees authKey, email) and in `apps/api`:
1. `src/lib/hmac.ts`: `hmac(secret, data)`, constant-time compare, `ipHmac` (daily-rotating via date in input).
2. `src/lib/ratelimit.ts`: D1 fixed-window counters on `rate_limits` (key, window) with `limit(key, max, windowMs)`.
3. `src/routes/auth.ts`:
   - `POST /api/auth/prelogin {identifier}` → stored salt + kdf params, or `HMAC(KDF_SALT_SECRET, path+identifier)`-derived fake salt with default params (identical shape/timing).
   - `POST /api/auth/register {username, email, saltU, saltE, kdfParams, authKeyU, authKeyE, vault{encAskU, encAskE, encAskRecovery, encPrivateKeys}, publicKeys{x25519, ed25519}, turnstileToken, website(honeypot)}` → always `202 {status:"check_email"}`; on duplicate username/email send a "someone tried to register" email instead of an error (no enumeration). Username availability endpoint is separate and rate-limited.
   - `POST /api/auth/verify-email {token}`; `POST /api/auth/login {identifier, authKey}` → session cookie `__Host-arai_s` (HttpOnly; Secure; SameSite=Strict; Path=/), returns encrypted vault; `POST /api/auth/logout`; `GET /api/auth/session`.
   - Session middleware `requireUser` (hash token, check expiry/revocation, slide `last_seen_at` at most once per 5 min).
4. `src/lib/email.ts`: provider interface; `console` provider in dev/test **clearly labelled as a development fixture**; Resend adapter via fetch.
5. Tests in `apps/api/test/auth.test.ts`: register→verify→login happy path using real `@arai/crypto` derivations (FAST params as in crypto tests), enumeration parity (prelogin/register/login responses for existing vs unknown), wrong password, unverified login blocked, logout revokes, expired session rejected, rate limit triggers, honeypot rejects silently.
Then: Turnstile verification adapter (skipped when `TURNSTILE_SECRET` unset in dev, never in prod), password reset with recovery key, sessions list/revoke.

## Owner actions still required (not blocking local development)
Cloudflare account; domain (~$10/yr) for email; Resend/Brevo API key; optionally SMS provider. See `docs/REMAINING_TO_V1.md §2`.
