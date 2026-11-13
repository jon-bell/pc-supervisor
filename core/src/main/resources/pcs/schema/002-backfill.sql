-- The one-time /reviewhistory backfill (spec §4): which reviews have had their history read.
CREATE TABLE backfill (rid INTEGER PRIMARY KEY, done_at INTEGER NOT NULL);
