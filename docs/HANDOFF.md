# Handoff — how to continue

## Start of every session
1. Read this file, `docs/PROJECT_STATUS.md`, the last entry of `docs/SESSION_LOG.md`.
2. `npm install` then `npm test` and `npm run typecheck` — both must be green before new work.
3. Open only the files listed for the next task below.

## Current state (end of session 2)
- Phase 0 done. Phase 1 mostly done: crypto, auth API, sessions, recovery-key reset, settings, web shell, deploy workflow. See PROJECT_STATUS.
- Email/SMS features are deliberately off and greyed out (ADR-009). Do not build email/SMS flows until the owner sets up providers.
- Not deployed yet: waiting for owner to add GitHub secrets/variable (README "Deployment").

## Layout
- `packages/crypto` (libsodium; vault, AEAD, chunked files), `packages/shared` (zod contract, CURRENT_KDF, Capabilities).
- `apps/api/src/routes/auth.ts` (all auth/account routes), `src/lib/{session,crypto,ratelimit,turnstile,audit,security,validate,ids}.ts`, `migrations/0001_identity.sql` (not yet deployed → still editable).
- `apps/web/src/lib/{account,api,kdf,kdf.worker,session}.ts(x)`, `pages/*`, `components/{AppShell,Field,Unavailable,Icons}.tsx`, `styles/{tokens,app}.css`, `public/_headers` (static security headers).
- Tests: `npm test` (crypto + Workers-runtime API). Browser E2E: build web, `wrangler dev` (run in background), `NODE_PATH=$(npm root -g) node apps/web/e2e/auth-flow.mjs`.

## Next concrete tasks
1. **R2 (owner action first)**: Cloudflare dashboard → R2 → enable (needs a payment method on file; free tier 10 GB) → create bucket `arai-files` → *Manage R2 API tokens* → create token with Object Read & Write on that bucket → save Access Key ID / Secret as GitHub secrets `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (deploy job must push them with `wrangler secret put`). Then add the R2 binding to wrangler.jsonc and bucket CORS for the workers.dev origin (PUT/GET, headers content-type, range).
2. **Uploads**: migration 0003 (folders, tracks, track_versions, files per ARCHITECTURE §5); presigned multipart PUT via aws4fetch; client: magic-byte sniff → metadata (`music-metadata`) → waveform peaks → chunked XChaCha20 encryption (`@arai/crypto` chunks.ts, file key wrapped by project key) → upload with progress/cancel/retry; quota per user.
3. **Player**: Service Worker that decrypts byte ranges for `<audio>`; queue, seek, volume, loop; waveform scrubbing; version history.
4. Phase 1 leftovers: password/username change, ESLint, axe in E2E, lazy-load crypto.

Local E2E note: registration is rate-limited (5/hour per network). Before re-running E2E locally many times, clear counters: `npx wrangler d1 execute arai --local --command "DELETE FROM rate_limits"` (in `apps/api`).

## Owner actions still required (not blocking local development)
Deployment setup (README "Deployment": D1 database id, API token, account id into GitHub). Later: R2 enablement (Phase 2), Turnstile keys, domain + email provider, SMS provider. See `docs/REMAINING_TO_V1.md §2`.
