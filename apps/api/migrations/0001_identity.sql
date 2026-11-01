-- 0001 identity, sessions, tokens, rate limits, platform roles, audit log
-- Conventions: ids are random text (server-generated), timestamps unix ms.

CREATE TABLE users (
  id               TEXT PRIMARY KEY,
  username         TEXT NOT NULL COLLATE NOCASE,
  email_normalized TEXT NOT NULL,
  email_verified_at INTEGER,
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','active','restricted','suspended','banned','deleted')),
  created_at       INTEGER NOT NULL,
  deleted_at       INTEGER,
  CHECK (length(username) BETWEEN 3 AND 30),
  CHECK (username NOT GLOB '*[^A-Za-z0-9_.]*')
);
CREATE UNIQUE INDEX users_username_uq ON users(username);
CREATE UNIQUE INDEX users_email_uq ON users(email_normalized);

-- Client-side Argon2id; server stores HMAC(pepper, authKey) per login path.
CREATE TABLE credentials (
  user_id        TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  salt_username  BLOB NOT NULL,
  salt_email     BLOB NOT NULL,
  kdf_params     TEXT NOT NULL,         -- JSON {alg, opslimit, memlimit}
  auth_hash_u    BLOB NOT NULL,
  auth_hash_e    BLOB NOT NULL,
  updated_at     INTEGER NOT NULL
);

-- Encrypted key material only. Server cannot decrypt.
CREATE TABLE vaults (
  user_id             TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enc_ask_username    BLOB NOT NULL,
  enc_ask_email       BLOB NOT NULL,
  enc_ask_recovery    BLOB,              -- NULL only after recovery-less reset
  enc_private_keys    BLOB NOT NULL,
  version             INTEGER NOT NULL DEFAULT 1,
  updated_at          INTEGER NOT NULL
);

CREATE TABLE user_keys (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  x25519_pub   BLOB NOT NULL,
  ed25519_pub  BLOB NOT NULL,
  created_at   INTEGER NOT NULL,
  revoked_at   INTEGER
);
CREATE INDEX user_keys_user ON user_keys(user_id);

CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    BLOB NOT NULL UNIQUE,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  ip_hmac       TEXT,
  ua_summary    TEXT,
  mfa_passed    INTEGER NOT NULL DEFAULT 0,
  revoked_at    INTEGER
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE login_events (
  id          TEXT PRIMARY KEY,
  user_id     TEXT REFERENCES users(id) ON DELETE CASCADE,
  at          INTEGER NOT NULL,
  success     INTEGER NOT NULL,
  ip_hmac     TEXT,
  ua_summary  TEXT,
  reason      TEXT,
  suspicious  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX login_events_user ON login_events(user_id, at);

CREATE TABLE email_tokens (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     TEXT NOT NULL CHECK (purpose IN ('verify','reset','email_change','otp')),
  token_hash  BLOB NOT NULL UNIQUE,
  payload     TEXT,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER,
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX email_tokens_user ON email_tokens(user_id, purpose);

CREATE TABLE mfa_methods (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type         TEXT NOT NULL CHECK (type IN ('email','sms')),
  target       TEXT,
  verified_at  INTEGER,
  created_at   INTEGER NOT NULL
);

CREATE TABLE recovery_codes (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  BLOB NOT NULL,
  used_at    INTEGER
);

CREATE TABLE rate_limits (
  key           TEXT NOT NULL,
  window_start  INTEGER NOT NULL,
  count         INTEGER NOT NULL,
  PRIMARY KEY (key, window_start)
);

-- Platform roles are a separate permission system from project roles.
CREATE TABLE platform_roles (
  user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('owner','moderator')),
  granted_by  TEXT,
  granted_at  INTEGER NOT NULL
);
-- At most one platform owner.
CREATE UNIQUE INDEX platform_single_owner ON platform_roles(role) WHERE role = 'owner';

-- Hash-chained, append-only audit log. Modification is blocked at DB level.
CREATE TABLE audit_log (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  at            INTEGER NOT NULL,
  actor_id      TEXT,
  action        TEXT NOT NULL,
  target        TEXT,
  details_json  TEXT,
  prev_hash     TEXT NOT NULL,
  hash          TEXT NOT NULL
);
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
