-- 0010 private library preferences (pins, folders, recently played), encrypted
-- client-side with a key derived from the account secret key.
CREATE TABLE account_prefs (
  user_id    TEXT PRIMARY KEY REFERENCES users(id),
  enc_data   BLOB NOT NULL,
  updated_at INTEGER NOT NULL
);
