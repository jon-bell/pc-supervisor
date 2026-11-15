-- Imports (spec §3, §10.3): every import is a new version; old versions stay. An accepted import
-- stores all its rows; a rejected one (status 'rejected') stores its row errors and no rows.
CREATE TABLE import_run (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, source TEXT NOT NULL, at INTEGER NOT NULL,
  file_hash TEXT NOT NULL, rows INTEGER NOT NULL, status TEXT NOT NULL, row_errors TEXT NOT NULL,
  mapping TEXT, assumption TEXT
);
CREATE INDEX import_run_kind_at ON import_run(kind, at);
CREATE TABLE import_row (
  run_id INTEGER NOT NULL, row_no INTEGER NOT NULL, key TEXT NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY (run_id, row_no)
);
CREATE UNIQUE INDEX import_row_key ON import_row(run_id, key);
