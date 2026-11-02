-- 0008 listening stats and moderation support.

-- Daily play counts per track (counts only: no listener ids, no timestamps).
CREATE TABLE track_plays (
  track_id TEXT NOT NULL REFERENCES tracks(id),
  day      INTEGER NOT NULL,           -- days since the Unix epoch (UTC)
  source   TEXT NOT NULL CHECK (source IN ('member','link')),
  count    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (track_id, day, source)
);

-- Moderation removals of encrypted items keep a trace of who acted.
ALTER TABLE comments ADD COLUMN removed_by TEXT;
ALTER TABLE messages ADD COLUMN removed_by TEXT;
