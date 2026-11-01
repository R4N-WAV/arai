# Session Log

## Session 1 — 2026-11-01
- Phase 0 complete: feature research (reference sites blocked by sandbox network, used search results), feature matrix, architecture + ADR-001…007, schema, threat model & crypto design, design system, cost/limits.
- Phase 1 started: npm workspaces; `packages/crypto` (libsodium) with 13 tests; `apps/api` Worker (Hono) with security headers, CSRF/origin guard, body limit, opaque errors; migration 0001; hash-chained audit log; 10 Workers-runtime tests (Miniflare D1).
- Bug found by tests and fixed: username CHECK used a GLOB that only validated the first character.
- Tooling notes: npm 10.9 arborist crashes on vitest's optional peers → `.npmrc legacy-peer-deps=true`. `@cloudflare/vitest-pool-workers` is deprecated → use `@cloudflare/vitest-plugin`.

## Session 2 — 2026-11-01
- Owner decisions: has a Cloudflare account; domain later; email verification and SMS 2FA deferred → grey out. Proposed GitHub Pages; chose workers.dev + GitHub Actions deploy instead (ADR-008, cookies would be third-party on Pages).
- Built auth API (register, prelogin, login, logout, session, sessions list/revoke, login history, email-less recovery-key reset), `@arai/shared` contract, provider feature flags + `/api/config` (ADR-009).
- Schema change (pre-deploy, edited 0001 in place): status defaults to active; email unique only when verified; `recovery_auth_hash`.
- Built `apps/web`: tokens/CSS, app shell (sidebar / mobile tab bar), sign in, register with recovery-key step, unlock-after-reload, recover, settings with greyed-out email/SMS features. Argon2id runs in a Web Worker.
- CSRF origin check now compares with the request's own origin (no APP_ORIGIN config).
- Tests: crypto 14, api 33, browser E2E 10 steps — all green. Deploy workflow added (inactive until secrets/variable set).
- Gotcha: `pkill -f <pattern>` in a Bash call kills the calling shell if the pattern appears in the command; run `wrangler dev` with run_in_background instead.

## Session 3 — 2026-11-01
- Deployed: owner set up Cloudflare (D1 id committed in wrangler.jsonc; token + account id as GitHub secrets). Live at https://arai.ranuj-s.workers.dev (deploy run 41337995261, secrets auto-created).
- Bug: clicking the logo did a full reload and required unlocking. Fixed: brand links use router `<Link>`; added tab-scoped unlock persistence (`lib/tabvault.ts`, SECURITY §3.5). E2E extended (logo click, reload, new tab) — 12 steps pass.
- Design: owner wants a stronger identity — ambient space with project colours flowing in like paint, animated. Mockups on the design canvas (see HANDOFF task 0); implementation waits for feedback. Discarded an earlier uncommitted "room" theme attempt.
- Gotcha: changing the D1 database_id creates a fresh local DB — rerun `wrangler d1 migrations apply arai --local`.
