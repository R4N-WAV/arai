# Session Log

## Session 1 — 2026-11-01
- Phase 0 complete: feature research (reference sites blocked by sandbox network, used search results), feature matrix, architecture + ADR-001…007, schema, threat model & crypto design, design system, cost/limits.
- Phase 1 started: npm workspaces; `packages/crypto` (libsodium) with 13 tests; `apps/api` Worker (Hono) with security headers, CSRF/origin guard, body limit, opaque errors; migration 0001; hash-chained audit log; 10 Workers-runtime tests (Miniflare D1).
- Bug found by tests and fixed: username CHECK used a GLOB that only validated the first character.
- Tooling notes: npm 10.9 arborist crashes on vitest's optional peers → `.npmrc legacy-peer-deps=true`. `@cloudflare/vitest-pool-workers` is deprecated → use `@cloudflare/vitest-plugin`.
