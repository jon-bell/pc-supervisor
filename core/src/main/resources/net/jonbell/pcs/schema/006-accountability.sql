-- Accountability requests (concepts §3.6; spec §10.4 D). `tag_seen` is when a sync first saw each PC Supervisor
-- request, reminder and case tag on a paper (HotCRP's tag has no time). The other tables are local to this chair's copy:
-- a dismissed suggestion (AR4: it is never written to HotCRP and never reaches the engagement record), the suggestions
-- an AC or the junior PC chair asked for, and the status of an Accountability case before a PC chair upholds it.
CREATE TABLE tag_seen (
  pid INTEGER NOT NULL, name TEXT NOT NULL, value TEXT, first_seen_at INTEGER NOT NULL, changed_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL, gone_at INTEGER, PRIMARY KEY (pid, name)
);
CREATE TABLE acc_dismissal (
  pid INTEGER NOT NULL, ordinal TEXT NOT NULL, dismissed_at INTEGER NOT NULL, dismissed_by TEXT, PRIMARY KEY (pid, ordinal)
);
CREATE TABLE acc_suggestion (
  pid INTEGER NOT NULL, ordinal TEXT NOT NULL, source TEXT NOT NULL, criteria TEXT NOT NULL, reasons TEXT NOT NULL,
  created_at INTEGER NOT NULL, PRIMARY KEY (pid, ordinal)
);
CREATE TABLE acc_case (
  nominee TEXT PRIMARY KEY, status TEXT NOT NULL, opened_at INTEGER NOT NULL, decided_at INTEGER, note TEXT
);
