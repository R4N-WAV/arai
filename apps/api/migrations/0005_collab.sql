-- 0005 collaboration: invitations, key rotation, comments, share links.

-- A member row with accepted_at NULL is a pending invitation. Invitees hold
-- key grants already (so they can read the project name before accepting),
-- which is why any removal, decline included, marks the key for rotation.
ALTER TABLE project_members ADD COLUMN accepted_at INTEGER;
UPDATE project_members SET accepted_at = created_at;
ALTER TABLE projects ADD COLUMN rotation_due INTEGER NOT NULL DEFAULT 0;

-- Which project key version encrypted each piece of metadata. Members keep
-- every key version they were granted (a keyring), so old content stays
-- readable after a rotation while new content uses the new key.
ALTER TABLE tracks ADD COLUMN key_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE track_versions ADD COLUMN key_version INTEGER NOT NULL DEFAULT 1;

CREATE TABLE share_links (
  id                 TEXT PRIMARY KEY,           -- public, random 130-bit
  project_id         TEXT NOT NULL REFERENCES projects(id),
  track_id           TEXT REFERENCES tracks(id), -- NULL = whole project
  created_by         TEXT NOT NULL REFERENCES users(id),
  token_hash         BLOB NOT NULL,              -- SHA-256 of the access token (derived from the fragment secret + password)
  has_password       INTEGER NOT NULL DEFAULT 0 CHECK (has_password IN (0,1)),
  allow_download     INTEGER NOT NULL DEFAULT 0 CHECK (allow_download IN (0,1)),
  allow_comments     INTEGER NOT NULL DEFAULT 0 CHECK (allow_comments IN (0,1)),
  enc_payload        BLOB NOT NULL,              -- sealed with the link key
  enc_secret         BLOB NOT NULL,              -- link secret (+password) sealed with the project key, for members
  secret_key_version INTEGER NOT NULL,
  is_public          INTEGER NOT NULL DEFAULT 0 CHECK (is_public IN (0,1)),
  public_secret      TEXT,                       -- ONLY for the listening link of a public project
  expires_at         INTEGER,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  revoked_at         INTEGER,
  CHECK ((is_public = 1) = (public_secret IS NOT NULL))
);
CREATE INDEX share_links_project ON share_links(project_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX share_links_one_public ON share_links(project_id) WHERE is_public = 1 AND revoked_at IS NULL;

-- Files a link may stream (ids only; the keys are inside enc_payload).
CREATE TABLE share_link_files (
  link_id    TEXT NOT NULL REFERENCES share_links(id),
  file_id    TEXT NOT NULL REFERENCES files(id),
  version_id TEXT NOT NULL REFERENCES track_versions(id),
  PRIMARY KEY (link_id, file_id)
);

-- Time-coded comments on a track version. Member comments are encrypted with
-- the project key (key_version); guest comments left through a share link
-- with that link's key (link_id). The time position lives inside enc_body.
CREATE TABLE comments (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id),
  version_id  TEXT NOT NULL REFERENCES track_versions(id),
  parent_id   TEXT REFERENCES comments(id),
  author_id   TEXT REFERENCES users(id),
  link_id     TEXT REFERENCES share_links(id),
  key_version INTEGER,
  enc_body    BLOB,
  resolved_at INTEGER,
  resolved_by TEXT,
  created_at  INTEGER NOT NULL,
  edited_at   INTEGER,
  deleted_at  INTEGER,
  CHECK ((author_id IS NULL) <> (link_id IS NULL)),
  CHECK ((author_id IS NULL) OR key_version IS NOT NULL),
  CHECK ((deleted_at IS NULL) = (enc_body IS NOT NULL))
);
CREATE INDEX comments_version ON comments(version_id, created_at);
CREATE INDEX comments_project ON comments(project_id);
