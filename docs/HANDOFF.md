# Handoff — how to continue

## Start of every session
1. Read this file, `docs/PROJECT_STATUS.md`, the last entry of `docs/SESSION_LOG.md`.
2. `npm install` then `npm test` and `npm run typecheck` — both must be green before new work.
3. Open only the files listed for the next task below.

## Current state (end of session 12)
- Phases 0–7 built and deployed (see PROJECT_STATUS for the few open items). Live: https://arai.ranuj-s.workers.dev. Deploys run automatically on push to this branch.
- Email/SMS/GIFs are deliberately off and greyed out (provider-gated).
- Phase 8 (release hardening) is next.

## Layout
- `packages/crypto` (libsodium; vault, AEAD, chunked files), `packages/shared` (zod contract, CURRENT_KDF, Capabilities).
- `apps/api/src/routes/{auth,projects,tracks,profiles,collab,social,messages,admin}.ts`, `src/hub.ts` (realtime), `src/filestore.ts`, `src/lib/{session,crypto,ratelimit,turnstile,audit,security,validate,ids}.ts`, `migrations/0001_identity.sql` (not yet deployed → still editable).
- `apps/web/src/lib/{account,api,kdf,kdf.worker,session}.ts(x)`, `pages/*`, `components/{AppShell,Field,Unavailable,Icons}.tsx`, `styles/{tokens,app}.css`, `public/_headers` (static security headers).
- Tests: `npm test` (crypto + Workers-runtime API). Browser E2E: build web, `wrangler dev` (run in background), `NODE_PATH=$(npm root -g) node apps/web/e2e/auth-flow.mjs`.

## Next concrete tasks
1. **Phase 8 — release**: axe accessibility checks in every E2E flow (360/768/1280 px), ESLint, lazy-load crypto (main bundle ~1 MB), security review against SECURITY §7, backup/restore runbook (D1 time travel export), release checklist.
2. Open items: independent pitch shift, gapless, A/B version compare, artwork upload, AIFF→WAV rewrap, password/username change, account export & deletion, invite links.
3. To appoint the first admin: `node scripts/admin.mjs grant-owner <username>` (needs Cloudflare credentials; `--local` for wrangler dev).

Local E2E: seven scripts in `apps/web/e2e/`. Build the web app, run `wrangler dev` in the background, apply local migrations (`npx wrangler d1 migrations apply arai --local` in `apps/api`), clear counters before re-running (`npx wrangler d1 execute arai --local --command "DELETE FROM rate_limits"`), then `NODE_PATH=$(npm root -g) node apps/web/e2e/<flow>.mjs`.

## Owner actions still required (not blocking local development)
Deployment setup (README "Deployment": D1 database id, API token, account id into GitHub). Later: R2 enablement (Phase 2), Turnstile keys, domain + email provider, SMS provider. See `docs/REMAINING_TO_V1.md §2`.
