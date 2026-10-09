-- skyback: initial schema.
-- Applied with: zsh ~/Code/app-ops/bin/migrate.sh <local|remote>
-- Migration files are hand-authored and forward-only -- never edit a migration
-- that has already been applied anywhere; add a new numbered file instead.

-- Every post skyback has seen, once.
--
-- Bluesky posts cannot be edited, so a row is written the first time a post is
-- seen and never updated afterwards. Seeing it again costs a read, not a write,
-- which is what keeps the archive inside the D1 free allowance. That also means
-- the like/repost/reply counts are a snapshot from first sight, not live.
--
-- NEVER UPDATE text, extra, author_handle or author_name. posts_fts is an
-- external content index kept in step by the insert and delete triggers below
-- only; an UPDATE would leave the index pointing at text that is no longer
-- there. Delete and reinsert instead.
CREATE TABLE posts (
  uri           TEXT PRIMARY KEY,
  cid           TEXT,
  author_did    TEXT NOT NULL,
  author_handle TEXT NOT NULL DEFAULT '',
  author_name   TEXT NOT NULL DEFAULT '',
  author_avatar TEXT,
  text          TEXT NOT NULL DEFAULT '',
  -- Searchable text that is not the post body: image alt text, link card
  -- titles and descriptions, the quoted post, full link URLs, hashtags.
  extra         TEXT NOT NULL DEFAULT '',
  -- Compact summary of images, video, link card and quoted post, for rendering.
  embed_json    TEXT,
  -- The post's own createdAt as ISO 8601 UTC, clamped to indexed_at when it
  -- claims to be from the future (createdAt is whatever the client said).
  created_at    TEXT NOT NULL,
  indexed_at    TEXT,
  reply_parent  TEXT,
  -- Bit flags: 1 image, 2 video, 4 link, 8 quote, 16 reply.
  flags         INTEGER NOT NULL DEFAULT 0,
  like_count    INTEGER,
  repost_count  INTEGER,
  reply_count   INTEGER,
  first_seen_at TEXT NOT NULL
);

CREATE INDEX posts_created_at ON posts (created_at);

CREATE VIRTUAL TABLE posts_fts USING fts5(
  text,
  extra,
  author_handle,
  author_name,
  content = 'posts',
  content_rowid = 'rowid',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER posts_fts_insert AFTER INSERT ON posts BEGIN
  INSERT INTO posts_fts (rowid, text, extra, author_handle, author_name)
  VALUES (new.rowid, new.text, new.extra, new.author_handle, new.author_name);
END;

CREATE TRIGGER posts_fts_delete AFTER DELETE ON posts BEGIN
  INSERT INTO posts_fts (posts_fts, rowid, text, extra, author_handle, author_name)
  VALUES ('delete', old.rowid, old.text, old.extra, old.author_handle, old.author_name);
END;

-- Where and how a post turned up: in which feed ('following', or a feed or list
-- at:// URI), and as what. how is 'post', 'repost' (by_* says who reposted it),
-- 'parent' or 'root' (shown above a reply in the feed). appeared_at is the
-- feed's own timestamp for the item, the closest thing there is to "when it was
-- in your feed".
CREATE TABLE sightings (
  uri         TEXT NOT NULL,
  feed        TEXT NOT NULL,
  how         TEXT NOT NULL,
  by_did      TEXT NOT NULL DEFAULT '',
  by_handle   TEXT NOT NULL DEFAULT '',
  appeared_at TEXT NOT NULL,
  PRIMARY KEY (uri, feed, how, by_did)
) WITHOUT ROWID;

-- The feeds you can archive. 'following' is your home timeline and is always on.
-- The rest come from your saved feeds in Bluesky (the Feeds panel's "Reload my
-- saved feeds"), and are off until you switch them on.
CREATE TABLE feeds (
  uri            TEXT PRIMARY KEY,
  kind           TEXT NOT NULL,              -- timeline | feed | list
  name           TEXT NOT NULL DEFAULT '',
  description    TEXT NOT NULL DEFAULT '',
  avatar         TEXT,
  pinned         INTEGER NOT NULL DEFAULT 0,
  saved          INTEGER NOT NULL DEFAULT 1, -- still in your saved feeds at the last reload
  enabled        INTEGER NOT NULL DEFAULT 0,
  position       INTEGER NOT NULL DEFAULT 0, -- order in your saved feeds
  last_synced_at TEXT,
  last_new       INTEGER,
  last_error     TEXT,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO feeds (uri, kind, name, description, pinned, saved, enabled, position)
VALUES ('following', 'timeline', 'Following', 'Your home timeline', 1, 1, 1, -1);

-- Small key/value store: the Bluesky session, sync cursors, counters, last run.
CREATE TABLE state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
) WITHOUT ROWID;

INSERT INTO state (key, value) VALUES ('posts_count', '0'), ('lock_until', '');

-- skyback's own D1 usage per UTC day, from each query's meta. This is what the
-- DAILY_WRITE_BUDGET and DAILY_READ_BUDGET guards read.
CREATE TABLE usage (
  day          TEXT PRIMARY KEY,
  rows_read    INTEGER NOT NULL DEFAULT 0,
  rows_written INTEGER NOT NULL DEFAULT 0,
  runs         INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

-- Per-IP throttle for the in-app bug-report button, used when the Worker mounts
-- it with `limit: "d1"`. See app-ops/lib/bug-report/limit.js.
CREATE TABLE bug_report_limits (
  ip           TEXT PRIMARY KEY,
  count        INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
