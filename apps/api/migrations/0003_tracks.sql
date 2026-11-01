-- 0003 tracks, append-only versions, encrypted files.
-- Audio bytes live (encrypted, chunked) in the FileStore Durable Object;
-- D1 holds only ids, sizes, status and wrapped keys.

CREATE TABLE files (
  id            TEXT PRIMARY KEY,            -- client-generated (bound into chunk AAD)
  project_id    TEXT NOT NULL REFERENCES projects(id),
  uploader_id   TEXT NOT NULL REFERENCES users(id),
  kind          TEXT NOT NULL CHECK (kind IN ('audio')),
  enc_size      INTEGER NOT NULL CHECK (enc_size > 0),
  chunk_count   INTEGER NOT NULL CHECK (chunk_count > 0),
  enc_file_key  BLOB NOT NULL,               -- file key sealed with the project key (client-side)
  key_version   INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready','deleted')),
  created_at    INTEGER NOT NULL,
  completed_at  INTEGER,
  deleted_at    INTEGER
);
CREATE INDEX files_project ON files(project_id);
CREATE INDEX files_uploader ON files(uploader_id, status);

CREATE TABLE tracks (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id),
  enc_meta            BLOB NOT NULL,        -- title etc., encrypted with the project key
  position            REAL NOT NULL,
  current_version_id  TEXT,
  created_by          TEXT NOT NULL REFERENCES users(id),
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  deleted_at          INTEGER
);
CREATE INDEX tracks_project ON tracks(project_id, position);

-- Append-only: versions are never updated in place or overwritten.
CREATE TABLE track_versions (
  id          TEXT PRIMARY KEY,
  track_id    TEXT NOT NULL REFERENCES tracks(id),
  number      INTEGER NOT NULL,
  file_id     TEXT NOT NULL REFERENCES files(id),
  enc_meta    BLOB NOT NULL,                -- duration, waveform, notes… encrypted
  created_by  TEXT NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  UNIQUE (track_id, number)
);
CREATE TRIGGER track_versions_no_update BEFORE UPDATE ON track_versions
BEGIN SELECT RAISE(ABORT, 'track versions are append-only'); END;
