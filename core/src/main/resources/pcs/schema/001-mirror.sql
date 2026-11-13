-- Mirror (concepts §3.2; spec §3). Every row records when a sync first and last saw it, and
-- when it disappeared; nothing is silently dropped.
CREATE TABLE person (
  email TEXT PRIMARY KEY, name TEXT, roles TEXT NOT NULL, tags TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, gone_at INTEGER
);
CREATE TABLE paper (
  pid INTEGER PRIMARY KEY, title TEXT, status TEXT, decision TEXT, authors TEXT NOT NULL, pc_conflicts TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, gone_at INTEGER
);
CREATE TABLE assignment (
  pid INTEGER NOT NULL, email TEXT NOT NULL, role TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, gone_at INTEGER,
  PRIMARY KEY (pid, email, role)
);
CREATE TABLE review (
  rid INTEGER PRIMARY KEY, pid INTEGER NOT NULL, email TEXT, rtype INTEGER NOT NULL, status TEXT NOT NULL,
  ordinal TEXT, vtag TEXT, modified_at INTEGER, scores TEXT NOT NULL, word_count INTEGER NOT NULL, ratings TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL, first_complete_seen_at INTEGER, last_seen_at INTEGER NOT NULL, gone_at INTEGER
);
CREATE INDEX review_pid ON review(pid);
CREATE INDEX review_email ON review(email);
CREATE TABLE review_version (
  rid INTEGER NOT NULL, vtag TEXT NOT NULL, seen_at INTEGER NOT NULL, source TEXT NOT NULL,
  scores TEXT NOT NULL, status TEXT NOT NULL, PRIMARY KEY (rid, vtag)
);
CREATE TABLE rating_change (rid INTEGER NOT NULL, seen_at INTEGER NOT NULL, before TEXT NOT NULL, after TEXT NOT NULL);
CREATE TABLE review_text (
  rid INTEGER NOT NULL, vtag TEXT NOT NULL, field_uid TEXT NOT NULL, text TEXT NOT NULL, PRIMARY KEY (rid, vtag, field_uid)
);
CREATE TABLE comment (
  cid INTEGER PRIMARY KEY, pid INTEGER NOT NULL, email TEXT, topic TEXT, visibility TEXT, response_round TEXT,
  draft INTEGER NOT NULL, word_count INTEGER NOT NULL, mentions TEXT NOT NULL, tags TEXT NOT NULL, modified_at INTEGER,
  first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, deleted_seen_at INTEGER
);
CREATE INDEX comment_pid ON comment(pid);
CREATE TABLE comment_text (cid INTEGER NOT NULL, modified_at INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY (cid, modified_at));
CREATE TABLE sync_run (
  id INTEGER PRIMARY KEY AUTOINCREMENT, started_at INTEGER NOT NULL, finished_at INTEGER, now_used INTEGER NOT NULL,
  counts TEXT, errors TEXT
);
CREATE VIRTUAL TABLE fts USING fts5(kind, ref, text);
