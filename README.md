# Arai

A private-by-default music workspace and collaboration network: organise
projects, upload and version tracks, play them back properly, collaborate
with time-coded comments, share selectively, publish when ready, and talk to
collaborators over end-to-end encrypted messages.

**Status:** early development. Nothing is production-ready. See
[`docs/PROJECT_STATUS.md`](docs/PROJECT_STATUS.md).

## Architecture in one paragraph

A React + TypeScript SPA and a Hono API run on a single Cloudflare Worker
(same origin). Data lives in D1 (SQLite), files in R2 (accessed via
short-lived presigned URLs), realtime in Durable Objects. Private content is
encrypted in the browser with libsodium (Argon2id-derived keys, per-project
and per-file keys, XChaCha20-Poly1305), so the server and its administrators
hold only ciphertext. Details: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md),
[`docs/SECURITY.md`](docs/SECURITY.md).

## Documentation

| File | Purpose |
|---|---|
| `docs/ARCHITECTURE.md` | system design, schema, ADRs, free-tier budget |
| `docs/SECURITY.md` | threat model, crypto, recovery, limitations |
| `docs/DESIGN_SYSTEM.md` | visual language, tokens, components, a11y baseline |
| `docs/FEATURE_MATRIX.md` | Untitled vs Samply vs Arai |
| `docs/PROJECT_STATUS.md` | authoritative checklist |
| `docs/REMAINING_TO_V1.md` | outstanding work, required accounts, release gate |
| `docs/HANDOFF.md` / `docs/SESSION_LOG.md` | continuity between sessions |

## Development

Requires Node 22+.

```bash
npm install
```

```bash
npm test
```

Setup for local Worker development (`wrangler dev`) and deployment will be
documented here as Phase 1 lands. Never commit `.dev.vars`, `.env` or any secret.

## Licence

To be decided by the owner before public release.
