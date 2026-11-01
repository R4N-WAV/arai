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
0. **Redesign (in review)**: owner rejected the first look and the "room" idea. New direction = *ambient space*: near-black void that fills with glows derived from project cover colours (harmonised: saturation ≤68%, lightness 58–62%, screen-blended, blurred, slow 30–60 s drift, reduced-motion = static), glass panels, Bricolage Grotesque / Inter / JetBrains Mono / Noto Sans Tamil (self-host via @fontsource-variable), open-ring logo. Mockups: https://claude.ai/artifact/DBvtsi2PmcgZ2cB6pS4Bp7 (boards: Direction, interactive Canvas demo, Library desktop, Phone empty). **Wait for owner feedback before implementing**; then rewrite `apps/web/src/styles/*` and components, update `docs/DESIGN_SYSTEM.md`.
1. Finish Phase 1 leftovers (small): signed-in password change (re-wrap ASK, revoke other sessions), username change (re-derive username path; needs password), ESLint, axe checks in the E2E script, lazy-load `@arai/crypto` to shrink the main bundle.
2. Phase 2 start — projects: migration 0002 (projects, project_members, project_keys, folders, tracks, track_versions, files per ARCHITECTURE §5); project CRUD with `enc_meta` encrypted client-side under a project key sealed to the owner's X25519 key; Library page listing/creating projects; authorization helper `requireProjectRole()` with cross-user tests.
3. Then R2: owner must enable R2 (needs a payment method on file, free tier) and create bucket `arai-files` + R2 API token → presigned upload/download (aws4fetch).

## Owner actions still required (not blocking local development)
Deployment setup (README "Deployment": D1 database id, API token, account id into GitHub). Later: R2 enablement (Phase 2), Turnstile keys, domain + email provider, SMS provider. See `docs/REMAINING_TO_V1.md §2`.
