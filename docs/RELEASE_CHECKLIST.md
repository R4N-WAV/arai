# Release checklist

Run before calling a version "released". Every line must be ticked.

## Automated (all green)
- [ ] `npm run typecheck` · `npm run lint` (no errors) · `npm test`
- [ ] Browser E2E against `wrangler dev`: auth, projects, tracks, profile-import,
      collab, messages, audio-admin, device-art, account, library, versions,
      playback, push, onboarding, a11y (axe: zero serious/critical at 360/768/1280 px)
- [ ] Deploy workflow green on the release commit

## Security (SECURITY.md §7 — covered by)
| Requirement | Tests |
|---|---|
| Unauthorised project access, role escalation, revoked collaborator | `projects.test.ts`, `collab.test.ts` |
| Unauthorised track/file/attachment access | `tracks.test.ts`, `messages.test.ts`, `collab.test.ts` (share chunks) |
| Unauthorised conversation access, blocks, requests | `messages.test.ts` |
| Enumeration parity, session expiry/revocation, recovery | `auth.test.ts`, `devices-art.test.ts` |
| Upload size/kind/quota abuse, image validation | `tracks.test.ts`, `profiles.test.ts`, `devices-art.test.ts` |
| Rate limits, honeypot, origin/CSRF guard, realtime origin check | `foundation.test.ts`, `messages.test.ts` |
| Cross-user leakage in public endpoints (discover, profiles, share) | `collab.test.ts`, `admin.test.ts` |
| Audit-log tamper detection | `foundation.test.ts`, `admin.test.ts` |
| Crypto round-trip, tamper, grant substitution, share keys | `packages/crypto/test/*` |
| No plaintext leaves the browser (audio, comments, messages, art) | E2E: tracks, collab, messages, device-art |

## Manual
- [ ] iPhone home-screen app: sign in, reopen (stays signed in), play, lock screen controls
- [ ] Android Chrome and desktop Safari/Firefox smoke test
- [ ] Restore drill done in the last 90 days (RUNBOOK)
- [ ] Platform owner appointed (`scripts/admin.mjs grant-owner`)
- [ ] Turnstile keys configured before public sign-ups are advertised
- [ ] PROJECT_STATUS, SECURITY, REMAINING_TO_V1 up to date
