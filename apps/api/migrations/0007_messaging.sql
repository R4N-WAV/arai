-- 0007 end-to-end encrypted messaging: DMs, groups and project chats.
-- Message bodies (text, attachment keys, GIF links) are encrypted client-side
-- with the conversation key (DMs/groups) or the project key (project chats).
-- The server sees who talks to whom and when, never what is said.

CREATE TABLE conversations (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('dm','group','project')),
  project_id      TEXT UNIQUE REFERENCES projects(id),
  dm_key          TEXT UNIQUE,                 -- "<userA>:<userB>" sorted, DMs only
  created_by      TEXT NOT NULL REFERENCES users(id),
  key_version     INTEGER NOT NULL DEFAULT 1 CHECK (key_version >= 1),
  enc_meta        BLOB,                        -- group name, sealed with the conversation key
  rotation_due    INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  last_message_at INTEGER,
  CHECK ((kind = 'project') = (project_id IS NOT NULL)),
  CHECK ((kind = 'dm') = (dm_key IS NOT NULL))
);

-- Project chats have rows here only to hold read state; access comes from project membership.
CREATE TABLE conversation_members (
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  user_id         TEXT NOT NULL REFERENCES users(id),
  role            TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','admin')),
  -- 'request': someone who is not a friend messaged this person; they choose to accept.
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','request','left')),
  joined_at       INTEGER NOT NULL,
  last_read_at    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX conversation_members_user ON conversation_members(user_id, status);

CREATE TABLE conversation_keys (
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  key_version     INTEGER NOT NULL,
  user_id         TEXT NOT NULL REFERENCES users(id),
  wrapped_key     BLOB NOT NULL,
  granted_by      TEXT NOT NULL REFERENCES users(id),
  grant_sig       BLOB NOT NULL,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, key_version, user_id)
);

CREATE TABLE messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  sender_id       TEXT NOT NULL REFERENCES users(id),
  key_version     INTEGER NOT NULL,
  enc_body        BLOB,
  reply_to        TEXT REFERENCES messages(id),
  created_at      INTEGER NOT NULL,
  edited_at       INTEGER,
  deleted_at      INTEGER,
  CHECK ((deleted_at IS NULL) = (enc_body IS NOT NULL))
);
CREATE INDEX messages_conversation ON messages(conversation_id, created_at);

-- A fixed set of reactions (metadata, like read receipts): no free text here.
CREATE TABLE message_reactions (
  message_id TEXT NOT NULL REFERENCES messages(id),
  user_id    TEXT NOT NULL REFERENCES users(id),
  reaction   TEXT NOT NULL CHECK (reaction IN ('like','love','laugh','wow','sad','fire')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id, reaction)
);

-- Encrypted attachments (chunked like audio, in the same free Durable Object storage).
CREATE TABLE conv_files (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  uploader_id     TEXT NOT NULL REFERENCES users(id),
  enc_size        INTEGER NOT NULL CHECK (enc_size > 0),
  chunk_count     INTEGER NOT NULL CHECK (chunk_count > 0),
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready','deleted')),
  created_at      INTEGER NOT NULL
);
CREATE INDEX conv_files_uploader ON conv_files(uploader_id, status);
