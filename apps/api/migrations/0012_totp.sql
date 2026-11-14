-- 0012 two-factor sign-in with an authenticator app (TOTP, RFC 6238).
-- The shared secret is stored encrypted with a key derived from the server
-- pepper, so a database copy alone does not reveal it. Recovery codes reuse
-- the recovery_codes table (HMAC-hashed, single use).
CREATE TABLE totp_secrets (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret_enc BLOB NOT NULL,
  enabled_at INTEGER,          -- NULL while being set up
  last_step  INTEGER NOT NULL DEFAULT 0,  -- refuses replay of a used code
  created_at INTEGER NOT NULL
);
