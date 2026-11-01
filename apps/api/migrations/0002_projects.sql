-- 0002 projects, membership, per-member wrapped project keys.
-- Private metadata (name, description, tags, colour) is encrypted client-side
-- under the project key (enc_meta). public_meta is plaintext ONLY while the
-- owner has made the project public.

CREATE TABLE projects (
  id           TEXT PRIMARY KEY,           -- client-generated 128-bit random id (bound into AEAD context)
  owner_id     TEXT NOT NULL REFERENCES users(id),
  visibility   TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','public')),
  key_version  INTEGER NOT NULL DEFAULT 1 CHECK (key_version >= 1),
  enc_meta     BLOB NOT NULL,
  public_meta  TEXT,                       -- JSON, NULL unless visibility = 'public'
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  published_at INTEGER,
  deleted_at   INTEGER,
  CHECK ((visibility = 'public') = (public_meta IS NOT NULL))
);
CREATE INDEX projects_owner ON projects(owner_id);
CREATE INDEX projects_public ON projects(visibility, published_at) WHERE visibility = 'public' AND deleted_at IS NULL;

CREATE TABLE project_members (
  project_id  TEXT NOT NULL REFERENCES projects(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  role        TEXT NOT NULL CHECK (role IN ('listener','editor','admin','owner')),
  added_by    TEXT,
  created_at  INTEGER NOT NULL,
  revoked_at  INTEGER,
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX project_members_user ON project_members(user_id) WHERE revoked_at IS NULL;
-- Exactly one owner row per project.
CREATE UNIQUE INDEX project_single_owner ON project_members(project_id) WHERE role = 'owner';

-- Project key sealed to a member's X25519 key, signed by the granter (Ed25519)
-- so a member can detect a server-substituted key.
CREATE TABLE project_keys (
  project_id   TEXT NOT NULL REFERENCES projects(id),
  key_version  INTEGER NOT NULL,
  user_id      TEXT NOT NULL REFERENCES users(id),
  wrapped_key  BLOB NOT NULL,
  granted_by   TEXT NOT NULL REFERENCES users(id),
  grant_sig    BLOB NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (project_id, key_version, user_id)
);
