-- 0014 bring-your-own storage (Dropbox / Google Drive). Audio chunks are
-- encrypted in the browser and uploaded straight to the user's own cloud as
-- one file; Arai keeps only a read link to that ciphertext and relays byte
-- ranges to members. Such files do not count toward the Arai quota.
ALTER TABLE files ADD COLUMN storage TEXT NOT NULL DEFAULT 'arai' CHECK (storage IN ('arai','dropbox','gdrive'));
ALTER TABLE files ADD COLUMN remote_ref TEXT;

-- The user's cloud connection: refresh token encrypted with a key derived
-- from their account key (Arai cannot read it), so their other devices can
-- upload too.
CREATE TABLE storage_accounts (
  user_id      TEXT NOT NULL REFERENCES users(id),
  provider     TEXT NOT NULL CHECK (provider IN ('dropbox','gdrive')),
  enc_token    BLOB NOT NULL,
  connected_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, provider)
);
