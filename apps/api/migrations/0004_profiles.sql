-- 0004 public profiles. Everything here is public by the user's choice.
CREATE TABLE profiles (
  user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name  TEXT NOT NULL DEFAULT '',
  bio           TEXT NOT NULL DEFAULT '',
  location      TEXT NOT NULL DEFAULT '',
  links_json    TEXT NOT NULL DEFAULT '[]',
  updated_at    INTEGER NOT NULL
);

-- Avatar and header images, re-encoded client-side and validated server-side.
CREATE TABLE profile_images (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('avatar','banner')),
  mime        TEXT NOT NULL CHECK (mime IN ('image/jpeg','image/png','image/webp')),
  data        BLOB NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind)
);
