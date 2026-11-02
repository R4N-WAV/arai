-- 0009 remembered devices and project artwork.

-- Half of a remembered device's unlock key. The other half is a
-- non-extractable key in that browser. Revoking the session (sign out, revoke
-- in Settings, suspension) destroys this half, so the stored keys on the
-- device become unreadable.
ALTER TABLE sessions ADD COLUMN device_secret BLOB;

-- Cover artwork: encrypted with the project key (enc_data); a plain copy
-- (public_data) exists only while the project is public.
CREATE TABLE project_art (
  project_id  TEXT PRIMARY KEY REFERENCES projects(id),
  key_version INTEGER NOT NULL,
  enc_data    BLOB NOT NULL,
  public_data BLOB,
  public_mime TEXT CHECK (public_mime IS NULL OR public_mime IN ('image/webp','image/jpeg','image/png')),
  updated_at  INTEGER NOT NULL,
  CHECK ((public_data IS NULL) = (public_mime IS NULL))
);
