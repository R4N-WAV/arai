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
1. **Artwork**: upload an image per project (re-encode via canvas to strip metadata, encrypt like audio, small size cap); derive the cover colour from it (average/dominant colour → `meta.color`); show it in sleeves, project hero and player.
2. **Track polish**: rename (inline), reorder (drag + "Move up/down" buttons), AIFF→WAV rewrap for Chromium playback, A/B version comparison.
3. **Streaming**: Service Worker that maps `<audio>` byte ranges to encrypted chunks so long files start instantly; keep the blob fallback.
4. **Phase 3**: collaborators — invite by username, wrap the project key to their X25519 key (createGrant), roles UI, revoke + key rotation (re-wrap file keys), time-coded comments per version.
5. Phase 1 leftovers: password/username change, ESLint, axe in E2E, lazy-load crypto.

Local E2E: three scripts in `apps/web/e2e/` (auth, projects, tracks). Registration is rate-limited (5/hour per network). Before re-running E2E locally many times, clear counters: `npx wrangler d1 execute arai --local --command "DELETE FROM rate_limits"` (in `apps/api`).

## Owner actions still required (not blocking local development)
Deployment setup (README "Deployment": D1 database id, API token, account id into GitHub). Later: R2 enablement (Phase 2), Turnstile keys, domain + email provider, SMS provider. See `docs/REMAINING_TO_V1.md §2`.
