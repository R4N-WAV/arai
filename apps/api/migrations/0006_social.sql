-- 0006 social graph, safety, notifications, discovery.

CREATE TABLE follows (
  follower_id TEXT NOT NULL REFERENCES users(id),
  followee_id TEXT NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id <> followee_id)
);
CREATE INDEX follows_followee ON follows(followee_id);

-- Friendship is mutual and needs acceptance. Stored once per pair (user_a < user_b).
CREATE TABLE friendships (
  user_a       TEXT NOT NULL REFERENCES users(id),
  user_b       TEXT NOT NULL REFERENCES users(id),
  requested_by TEXT NOT NULL REFERENCES users(id),
  status       TEXT NOT NULL CHECK (status IN ('pending','accepted')),
  created_at   INTEGER NOT NULL,
  accepted_at  INTEGER,
  PRIMARY KEY (user_a, user_b),
  CHECK (user_a < user_b),
  CHECK (requested_by IN (user_a, user_b))
);
CREATE INDEX friendships_b ON friendships(user_b);

CREATE TABLE blocks (
  blocker_id TEXT NOT NULL REFERENCES users(id),
  blocked_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);
CREATE INDEX blocks_blocked ON blocks(blocked_id);

CREATE TABLE reports (
  id          TEXT PRIMARY KEY,
  reporter_id TEXT NOT NULL REFERENCES users(id),
  target_type TEXT NOT NULL CHECK (target_type IN ('user','project','comment','message')),
  target_id   TEXT NOT NULL,
  reason      TEXT NOT NULL CHECK (reason IN ('spam','harassment','hate','sexual','violence','copyright','impersonation','other')),
  details     TEXT NOT NULL DEFAULT '' CHECK (length(details) <= 2000),
  -- Optional plaintext evidence the reporter chose to reveal (e.g. decrypted message text).
  evidence    TEXT CHECK (evidence IS NULL OR length(evidence) <= 4000),
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','actioned','dismissed')),
  created_at  INTEGER NOT NULL,
  resolved_by TEXT REFERENCES users(id),
  resolved_at INTEGER,
  resolution  TEXT
);
CREATE INDEX reports_status ON reports(status, created_at);

-- Notifications carry ids only; clients render text (and decrypt anything private) themselves.
CREATE TABLE notifications (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  kind       TEXT NOT NULL CHECK (kind IN ('invite','comment','follow','friend_request','friend_accept','message','moderation')),
  actor_id   TEXT REFERENCES users(id),
  target_id  TEXT,
  created_at INTEGER NOT NULL,
  read_at    INTEGER
);
CREATE INDEX notifications_user ON notifications(user_id, created_at);

-- Moderation: hidden public content stays out of discovery and profiles.
ALTER TABLE projects ADD COLUMN hidden_at INTEGER;

-- Discovery over public profiles and public projects only (maintained by the API).
CREATE VIRTUAL TABLE search_index USING fts5(kind UNINDEXED, ref UNINDEXED, title, body, tokenize = 'unicode61 remove_diacritics 2');
