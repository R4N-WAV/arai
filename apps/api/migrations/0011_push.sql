-- 0011 Web Push subscriptions (one per device). Pushes carry no payload: the
-- device fetches what happened over its signed-in connection, so nothing
-- about the content passes through the push services.
CREATE TABLE push_subscriptions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  endpoint   TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  failed_at  INTEGER
);
CREATE INDEX push_subscriptions_user ON push_subscriptions(user_id);
