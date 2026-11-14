-- 0013 project invite links: /join/<id>#<secret>. The project keyring is
-- sealed with a key derived from the fragment secret; the server keeps only
-- a hash of the access token. A key rotation revokes every invite link.
CREATE TABLE invite_links (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id),
  role        TEXT NOT NULL CHECK (role IN ('listener','editor')),
  created_by  TEXT NOT NULL REFERENCES users(id),
  token_hash  BLOB NOT NULL,
  enc_payload BLOB NOT NULL,
  enc_secret  BLOB NOT NULL,       -- secret sealed with the project key (members can copy the link again)
  key_version INTEGER NOT NULL,
  max_uses    INTEGER NOT NULL CHECK (max_uses BETWEEN 1 AND 100),
  uses        INTEGER NOT NULL DEFAULT 0,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  revoked_at  INTEGER
);
CREATE INDEX invite_links_project ON invite_links(project_id) WHERE revoked_at IS NULL;
