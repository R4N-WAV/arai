# Handoff — how to continue

## Start of every session
1. Read this file, `docs/PROJECT_STATUS.md`, the last entry of `docs/SESSION_LOG.md`.
2. `npm install` then `npm test` and `npm run typecheck` — both must be green before new work.
3. Open only the files listed for the next task below.

## Current state (end of session 13)
- Phases 0–14 built (phases 9–14 were defined from the backlog; see PROJECT_STATUS). Live: https://arai.ranuj-s.workers.dev, deploys automatically on push.
- Provider-gated and greyed out: email (verification, email change, email invites), SMS 2FA, GIFs.
- Before every push: `npm run typecheck && npm run lint && npm test` (the deploy job runs the same and refuses to deploy on failure).

## Layout
- `packages/crypto` (libsodium; vault, AEAD, chunked files), `packages/shared` (zod contract, CURRENT_KDF, Capabilities).
- `apps/api/src/routes/{auth,projects,tracks,profiles,collab,social,messages,admin}.ts`, `src/hub.ts` (realtime), `src/filestore.ts`, `src/lib/{session,crypto,ratelimit,turnstile,audit,security,validate,ids}.ts`, `migrations/0001_identity.sql` (not yet deployed → still editable).
- `apps/web/src/lib/{account,api,kdf,kdf.worker,session}.ts(x)`, `pages/*`, `components/{AppShell,Field,Unavailable,Icons}.tsx`, `styles/{tokens,app}.css`, `public/_headers` (static security headers).
- Tests: `npm test` (crypto + Workers-runtime API). Browser E2E: build web, `wrangler dev` (run in background), `NODE_PATH=$(npm root -g) node apps/web/e2e/auth-flow.mjs`.

## Next concrete tasks
1. Owner: manual device pass + first restore drill (docs/RELEASE_CHECKLIST.md, docs/RUNBOOK.md); appoint the platform owner (`node scripts/admin.mjs grant-owner <username>`); add Turnstile keys before advertising sign-ups.
2. When a domain + email provider exist: email verification, email change, invite by email, login alerts.
3. Nice-to-have: sample-accurate gapless (Web Audio buffers for short tracks), higher-quality pitch shifting (phase vocoder), translations (Tamil/English).

Local E2E: 15 scripts in `apps/web/e2e/`. Build the web app, apply local migrations (`npx wrangler d1 migrations apply arai --local` in `apps/api`), run `wrangler dev` in the background (restart it after each build; it can serve stale assets), clear counters before each run (`npx wrangler d1 execute arai --local --command "DELETE FROM rate_limits"`), then `NODE_PATH=$(npm root -g) node apps/web/e2e/<flow>.mjs`. Push tests need `VAPID_PRIVATE_JWK` in `apps/api/.dev.vars` (never committed).

## Owner actions still required (not blocking local development)
Deployment setup (README "Deployment": D1 database id, API token, account id into GitHub). Later: R2 enablement (Phase 2), Turnstile keys, domain + email provider, SMS provider. See `docs/REMAINING_TO_V1.md §2`.
