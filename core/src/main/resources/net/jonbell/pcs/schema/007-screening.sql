-- Screening triage and desk reject (concepts §3.4; spec §10.4 B). `paper.modified_at` is HotCRP's time of the paper's last edit (a cure
-- of the Q1 fix window is an edit inside the window). `triage_feedback` holds the answers to the Q4 form: local to this chair's copy,
-- collected for the evaluation of the screening (agent.md §8), and never an input to any decision about that paper (S12).
ALTER TABLE paper ADD COLUMN modified_at INTEGER;
CREATE TABLE triage_feedback (
  pid INTEGER NOT NULL, reviewer TEXT NOT NULL, flag_right TEXT NOT NULL, missed TEXT NOT NULL, would_refer TEXT NOT NULL,
  note TEXT, recorded_at INTEGER NOT NULL, PRIMARY KEY (pid, reviewer)
);
