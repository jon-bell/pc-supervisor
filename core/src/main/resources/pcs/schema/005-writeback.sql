-- Review round (spec §11: the `screen` round holds triage and second opinions; null = the unnamed round).
ALTER TABLE review ADD COLUMN round TEXT;
-- Writeback (concepts §3.2; spec §6): every change PC Supervisor makes to HotCRP is one row here, from
-- draft to observed. `status` is drafted, dry-run, confirmed, applied, handed-off, observed, mismatch or failed.
CREATE TABLE writeback_artifact (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, payload TEXT NOT NULL, summary TEXT NOT NULL,
  status TEXT NOT NULL, drafted_at INTEGER NOT NULL,
  dry_run_at INTEGER, dry_run_digest TEXT, dry_run_result TEXT,
  confirmed_at INTEGER, confirmed_by TEXT,
  applied_at INTEGER, apply_result TEXT,
  expectations TEXT, observed_at INTEGER, checked_at INTEGER, mismatch TEXT
);
CREATE INDEX writeback_artifact_status ON writeback_artifact(status);
-- Facts about the HotCRP instance's configuration that the last sync read (spec §11 relies on them).
CREATE TABLE instance_fact (k TEXT PRIMARY KEY, v TEXT NOT NULL, read_at INTEGER NOT NULL);
