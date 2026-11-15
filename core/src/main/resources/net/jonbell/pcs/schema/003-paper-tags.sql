-- Paper tags as the chair sees them (hidden pcs-* tags included): the shared record of spec §11.
ALTER TABLE paper ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
