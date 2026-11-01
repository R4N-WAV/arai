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

### Run locally

```bash
printf 'AUTH_PEPPER=%s\nKDF_SALT_SECRET=%s\nIP_HMAC_SECRET=%s\n' $(openssl rand -hex 32) $(openssl rand -hex 32) $(openssl rand -hex 32) > apps/api/.dev.vars
```

```bash
npm run build -w @arai/web && cd apps/api && npx wrangler d1 migrations apply arai --local && npx wrangler dev
```

Open http://localhost:8787. Browser end-to-end check (with the server running):

```bash
node apps/web/e2e/auth-flow.mjs
```

Never commit `.dev.vars`, `.env` or any secret.

## Deployment (Cloudflare, from GitHub)

The site and API run on one Cloudflare Worker at a free
`arai.<your-subdomain>.workers.dev` address. Every push to `main` is tested
and deployed by `.github/workflows/deploy.yml`. One-time setup:

1. **Cloudflare dashboard → Storage & Databases → D1 → Create database**,
   name it `arai`, and copy its **Database ID**.
2. **Cloudflare dashboard → Account home**: copy your **Account ID**
   (right-hand side of the Workers & Pages overview).
3. **My Profile → API Tokens → Create Token → "Edit Cloudflare Workers"
   template**, then add the permission **Account · D1 · Edit**. Create it and
   copy the token.
4. **GitHub → R4N-WAV/arai → Settings → Secrets and variables → Actions**:
   - Secrets: `CLOUDFLARE_API_TOKEN` (step 3), `CLOUDFLARE_ACCOUNT_ID` (step 2)
   - Variables tab: `D1_DATABASE_ID` (step 1)
5. Merge to `main` (or run the *Deploy* workflow manually). The first run
   creates the server secrets inside Cloudflare automatically; the job log
   prints the workers.dev URL.

Email verification and SMS 2FA are switched off (`FEATURE_EMAIL`,
`FEATURE_SMS` in `apps/api/wrangler.jsonc`) and shown greyed out in the app
until providers are configured.

## Licence

To be decided by the owner before public release.
