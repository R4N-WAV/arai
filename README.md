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

1. ~~Create the D1 database `arai`~~ — done; its id is in `apps/api/wrangler.jsonc`.
2. **Account ID**: open https://dash.cloudflare.com and look at the address
   bar. It reads `https://dash.cloudflare.com/<32 letters and digits>/home`;
   that string is the Account ID. (Also shown under *Account details* on the
   Account home page.)
3. **API token**: https://dash.cloudflare.com/profile/api-tokens → *Create
   Token* → *Edit Cloudflare Workers* → *Use template* → *+ Add more* and pick
   **Account · D1 · Edit** → under *Account Resources* choose your account →
   *Continue to summary* → *Create Token* → copy it (shown only once).
4. **GitHub**: https://github.com/R4N-WAV/arai/settings/secrets/actions →
   *New repository secret* twice: `CLOUDFLARE_ACCOUNT_ID` (step 2) and
   `CLOUDFLARE_API_TOKEN` (step 3). Never paste the token anywhere else.
5. **Deploy**: https://github.com/R4N-WAV/arai/actions → *Deploy* → *Run
   workflow*. Later, every push to `main` deploys automatically. The first run
   creates the server secrets inside Cloudflare; the *Deploy Worker* step log
   prints the site's `workers.dev` address.

Email verification and SMS 2FA are switched off (`FEATURE_EMAIL`,
`FEATURE_SMS` in `apps/api/wrangler.jsonc`) and shown greyed out in the app
until providers are configured.

## Licence

To be decided by the owner before public release.

Third-party design assets: the logo is outlined from the Kavivanar typeface,
and the interface uses Bricolage Grotesque, Inter, Fraunces and JetBrains Mono
— all under the SIL Open Font License 1.1 (self-hosted via @fontsource).
