# Remaining to V1

V1 is released only when every item below is implemented, tested and the
release gate in §3 passes. Current state: Phase 1 mostly done (auth, sessions, recovery, settings shell, deploy pipeline). Email/SMS deferred by owner.

## 1. Functional requirements outstanding
Done (tested): registration, login/logout, secure sessions, password recovery
via recovery key, session/device management, settings shell, responsive shell.
Blocked by deferred providers: email verification, email reset, 2FA (email/SMS).
Outstanding:
profiles, public/private projects, organisation, uploads, playback, versions,
invitations, permission levels, revocation, time-coded comments, sharing,
friends, following, DMs, E2EE messages, encrypted project content,
attachments, notifications, remaining settings (password/username/email change, export, deletion), admin dashboard, moderation, security
logging, responsive UI. See `PROJECT_STATUS.md` for the per-phase breakdown.

## 2. Infrastructure / accounts the owner must provide
| Item | Cost | Needed for |
|---|---|---|
| Cloudflare account (Workers, D1, R2, DO, Turnstile) | free — **owner has one**; D1 database + API token + GitHub secrets still to create (README "Deployment"). R2 needs a payment method on file to enable (Phase 2), charges only beyond free tier | hosting, DB, files, realtime, bot protection |
| Domain name | ≈ $10/yr — **deferred**, to be chosen together later | reliable email sending (SPF/DKIM/DMARC); optional custom app URL |
| Email API account (Resend or Brevo) | free tier | verification, reset, OTP, alerts |
| SMS provider (e.g. Twilio) | paid, per message | SMS 2FA — **will be shown as unavailable until configured** |
| GIF provider API key (optional) | free tier, ToS restrictions | GIF search |

Secrets: `AUTH_PEPPER`, `KDF_SALT_SECRET`, `IP_HMAC_SECRET` are generated
automatically by the deploy job on first run and live only in Cloudflare. Added later: `TURNSTILE_SECRET`, `EMAIL_API_KEY`,
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, optional `SMS_*`, `GIF_API_KEY`.

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
