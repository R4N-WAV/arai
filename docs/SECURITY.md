# Arai — Security Model

Status: Phase 0 design. Implementation status per control is tracked in
`PROJECT_STATUS.md`. Nothing here is "done" until its test exists.

## 1. Assets & trust boundaries

| Asset | Who may read plaintext |
|---|---|
| Private audio, artwork, waveforms, project/track names, comments | Project members (client-side only) |
| Private DMs, attachments, reactions | Conversation members (client-side only) |
| Account secret keys | The account holder's unlocked devices |
| Passwords | Nobody — never leave the browser |
| Operational metadata (ids, sizes, timestamps, membership, roles, email) | Server; admins see only what moderation needs |
| Public profiles & published projects | Everyone (user's explicit choice) |

The server, database, storage and platform administrators are **untrusted
for confidentiality** of private content. They are trusted for availability
and for honest public-key distribution (see §6 limitation and mitigation).

## 2. Threat model & mitigations

| Threat | Mitigations |
|---|---|
| External attacker / API abuse | AuthZ on every route via central `requireProjectRole()` / `requireConversationMember()` helpers; zod validation; request-size limits (JSON 64 KB); rate limits per IP-HMAC and per account; safe error bodies (no stack traces). |
| Credential stuffing / brute force | Per-account + per-IP exponential backoff, Turnstile after N failures, login notifications, optional 2FA, client-side Argon2id raises guess cost. |
| Automated account creation | Turnstile, honeypot field, registration throttling per IP-HMAC, email verification before normal functionality, new-account restrictions (limits on invites/DMs first 24 h). |
| Account / email enumeration | Prelogin returns deterministic fake salts; register/reset/login responses identical for existing/non-existing; uniqueness conflicts reported via email or generic message; timing equalised. Username availability check is rate-limited (usernames are public by design). |
| Malicious users / IDOR | Random 128-bit ids; ownership/role joins in every query (`WHERE project_id=? AND EXISTS member`); tests per endpoint for cross-user access. |
| Permission escalation | Role hierarchy enforced server-side: editors cannot grant roles; admins cannot grant owner or demote owner; platform roles in a separate table unreachable from project APIs. |
| Revoked collaborator | Membership `revoked_at` checked on every request; realtime sockets for that user/project closed; project key rotated; presigned URLs ≤5 min. |
| Compromised account | Session list + remote revocation, revoke-all on password change, suspicious-login detection (new device/country-agnostic IP-HMAC change + UA), email alerts. |
| Insider / admin | Zero-access encryption; admin UI has no content endpoints; audit log hash chain; no backdoor or escrow key. |
| Database compromise | Only ciphertext + keyed hashes; pepper and secrets stored as Worker secrets, not in D1. |
| Storage (R2) compromise | Ciphertext only for private content; random object keys. |
| Malicious uploads | Client magic-byte sniffing; server enforces size, quota, declared kind and chunk layout; files are never served from the app origin as HTML (presigned R2 host, `Content-Disposition: attachment` for downloads, `X-Content-Type-Options: nosniff`); public files validated server-side by magic bytes before publishing; images re-encoded client-side (canvas) to strip metadata/payloads. |
| Unauthorised downloads | Presigned URLs only after authZ check; `allow_download` enforced by not issuing download keys/URLs for whole files (streaming still possible — documented: anyone who can listen can record). |
| XSS | React escaping, no `dangerouslySetInnerHTML`, strict CSP (`default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'`), Trusted Types where supported, link previews rendered as text. |
| SQL injection | Parameterised D1 bindings only (ADR-006), test that greps for interpolated SQL. |
| CSRF | `SameSite=Strict` cookies, `Origin` check, required custom header. |
| SSRF | No server-side fetching of user URLs by default. Optional link-preview fetcher: https only, DNS/IP allow rules (no private/link-local ranges), 1 MB / 3 s cap, no redirects to other hosts. |
| Path traversal | Object keys are server-generated random ids; no user input in storage paths. |
| Session theft | HttpOnly `__Host-` cookie, hashed tokens in DB, rotation on login/privilege change, idle + absolute expiry, device overview. |
| Supply chain | Minimal dependencies, lockfile, `npm audit` in CI, Dependabot, pinned versions, Subresource-free single-origin bundling, no CDN scripts. |
| Data leakage | Public API serializers whitelist fields; private projects excluded at SQL level from search/profile; tests assert no private ids in public responses. |
| Encryption key compromise | Per-project and per-file keys limit blast radius; rotation on revocation; device keys revocable; recovery key separate from password. |

## 3. Cryptographic architecture

Libraries: **libsodium.js** (audited) and **Web Crypto**. No custom primitives.

### 3.1 Password & account keys
- `masterKey = Argon2id(password, salt, opslimit=3, memlimit=64 MiB, 32 bytes)`
  (libsodium `crypto_pwhash` ALG_ARGON2ID13). Parameters stored per user so they can be raised.
- `authKey = HKDF-SHA256(masterKey, "arai/auth/v1")`, `vaultKey = HKDF(masterKey, "arai/vault/v1")`.
- Two salts: `salt_username`, `salt_email`, each giving a distinct masterKey;
  both auth hashes and both vault wraps are stored, so prelogin responses for
  a username and its email cannot be linked. Changing username/email requires
  the password and re-derives the corresponding path.
- Server stores `HMAC-SHA256(AUTH_PEPPER, authKey)`, compared in constant time.
- **Account secret key (ASK)**: random 32 bytes; encrypts the user's private
  keys (X25519 for encryption, Ed25519 for signing). ASK is wrapped by
  `vaultKey` (both paths) and by the **recovery key** (random 256-bit, shown
  once as a 24-word/base32 code at registration).

### 3.2 Content encryption
- AEAD: XChaCha20-Poly1305 (IETF). Files: 1 MiB chunks, per-file random key,
  nonce = 16-byte random prefix ‖ 8-byte chunk index, AAD binds file id,
  chunk index and "last chunk" flag (prevents reorder/truncation).
- Envelope: file key wrapped with project key `K_p(v)`; `K_p(v)` sealed
  (`crypto_box_seal`) to each member's X25519 public key. Metadata blobs
  encrypted directly with `K_p(v)`.
- Rotation: on revoke or on demand → new `K_p(v+1)`, re-wrap all file keys and
  metadata; remaining members receive sealed `K_p(v+1)`.
- Share links: link key generated client-side, placed in URL **fragment**
  (`#k=`), never sent to the server; it wraps the subset of file keys the link
  covers. Password-protected links additionally require server-side password
  check (Argon2id client-side, HMAC server-side) before ciphertext URLs issue.

### 3.3 Messaging
See ARCHITECTURE ADR-005. Messages are signed (Ed25519) and encrypted with the
conversation epoch key; epoch rotates on every membership change and every
N messages/7 days. Attachments use the file scheme above with keys embedded
in the encrypted message.

### 3.4 Multi-device
Each device has its own X25519/Ed25519 key pair registered in `user_keys`;
new devices are added after vault unlock (the ASK decrypts the account's
long-term key, which re-seals project keys to the new device).

## 4. Recovery strategy (no backdoor)

- Forgotten password + recovery key → full restore.
- Forgotten password, **no** recovery key → email reset restores the
  *account* (profile, follows, memberships) but **all encrypted content
  previously only accessible by this user is permanently lost**. Collaborators
  can re-share project keys to the new key pair. The UI requires explicit
  acknowledgement of this before reset and at registration.
- Administrators cannot recover keys. There is no escrow.

## 5. Platform administration separation

`platform_roles` (owner, moderator) are distinct from `project_members.role`.
Admin endpoints return metadata only (account status, counts, sizes, report
records, security events). Moderation can suspend/ban/restrict and delete
*public* content; it cannot read private content because the server cannot.
Reported private messages: the reporter's client may voluntarily attach the
decrypted reported messages (user-initiated disclosure, clearly stated).
All admin actions write to the hash-chained `audit_log`.

## 6. Known limitations (honest)

Zero-access encryption does **not** protect against:
- malware or a compromised, unlocked device;
- recordings/screenshots by authorised recipients;
- copies downloaded before access was revoked;
- a malicious server substituting public keys (MITM) — mitigated by key
  fingerprints/safety numbers and key-change warnings, not eliminated;
- a malicious server serving modified JavaScript (inherent to web apps) —
  mitigated by open source, reproducible builds and CSP; not eliminated;
- metadata analysis (who collaborates with whom, file sizes, timing).

Other limitations: private content is not server-searchable (client-side
search only); SMS 2FA requires a paid provider; streaming permission implies
the ability to record.

## 7. Security test suite (target)

Located in `apps/api/test/security/`. Must pass before release:
unauthorised project access · unauthorised track/file URL issuance ·
unauthorised conversation access · role escalation · revoked collaborator ·
enumeration (register/login/reset/prelogin parity) · reset token reuse/expiry ·
session revocation & expiry · upload size/kind/quota abuse · rate limits ·
cross-user leakage in public endpoints · audit-log tamper detection ·
crypto round-trip and tamper tests in `packages/crypto`.
