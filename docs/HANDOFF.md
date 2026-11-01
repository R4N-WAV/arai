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
0. Deploys are automatic on push to this branch (ADR-015). Check the Deploy run after pushing.
1. **Phase 3 — collaboration**: invite by username (look up their X25519/Ed25519 keys, show fingerprint), `createGrant` to wrap the project key for them, accept/decline invitations, roles UI (listener/editor/admin), remove member → rotate project key (new version, re-wrap file keys + metadata), pending grants for offline owners. Migration 0005 (invitations, pending_key_grants).
2. **Time-coded comments** per version (encrypted bodies, replies, resolve), markers on the waveform.
3. **Share links** (key in URL fragment, optional password, expiry, download/comment flags) and **public listening** (public audio copies) so profiles can play public projects.
4. Track polish: artwork upload, rename, reorder, AIFF→WAV rewrap, A/B compare; Service-Worker streaming.
5. Phase 1 leftovers: password/username change, ESLint, axe, lazy-load crypto.

Local E2E: four scripts in `apps/web/e2e/` (auth, projects, tracks, profile-import). Registration is rate-limited (5/hour per network). Before re-running E2E locally many times, clear counters: `npx wrangler d1 execute arai --local --command "DELETE FROM rate_limits"` (in `apps/api`).

## Owner actions still required (not blocking local development)
Deployment setup (README "Deployment": D1 database id, API token, account id into GitHub). Later: R2 enablement (Phase 2), Turnstile keys, domain + email provider, SMS provider. See `docs/REMAINING_TO_V1.md §2`.
