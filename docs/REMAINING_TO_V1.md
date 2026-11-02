# Remaining to V1

V1 is released only when every item below is implemented, tested and the
release gate in §3 passes. Current state (session 13): phases 0–14 built and tested; what remains is owner-side release work and provider-gated features.

## 1. Functional requirements outstanding
Blocked by deferred providers: email verification, email change, email reset, email/SMS 2FA, invites by email, GIFs.
Owner actions: manual device pass, restore drill, appoint platform owner, Turnstile keys (RELEASE_CHECKLIST.md).
Possible later improvements (not required for V1): sample-accurate gapless, phase-vocoder pitch shift, translations.

## 2. Infrastructure / accounts the owner must provide
| Item | Cost | Needed for |
|---|---|---|
| Cloudflare account (Workers, D1, R2, DO, Turnstile) | free — **owner has one**; D1 database + API token + GitHub secrets still to create (README "Deployment"). **No card on file by owner's choice** — R2 not used; audio in free-plan Durable Objects (5 GB, ADR-011) | hosting, DB, files, realtime, bot protection |
| Domain name | ≈ $10/yr — **deferred**, to be chosen together later | reliable email sending (SPF/DKIM/DMARC); optional custom app URL |
| Email API account (Resend or Brevo) | free tier | verification, reset, OTP, alerts |
| SMS provider (e.g. Twilio) | paid, per message | SMS 2FA — **will be shown as unavailable until configured** |
| GIF provider API key (optional) | free tier, ToS restrictions | GIF search |

Secrets: `AUTH_PEPPER`, `KDF_SALT_SECRET`, `IP_HMAC_SECRET` are generated
automatically by the deploy job on first run and live only in Cloudflare. Added later: `TURNSTILE_SECRET`, `EMAIL_API_KEY`,
optional `SMS_*`, `GIF_API_KEY`.

## 3. Release gate
- No unresolved critical/high security findings; full security suite (SECURITY §7) green.
- Cross-account leakage tests green; encryption & tamper tests green.
- File access, revocation and recovery flows tested end-to-end.
- Playwright flows pass on 360 px, 768 px, 1280 px viewports; axe: zero serious/critical.
- Deployment, backup (D1 time-travel export + R2 lifecycle) and incident procedures documented.
- Reference features re-verified against live Untitled/Samply sites.

## 4. Known scope exclusions for V1 (documented, not silently dropped)
AI stem splitting, tuner/recording, paywalled links, DAW marker integration,
synced listening sessions, native apps, public API.
