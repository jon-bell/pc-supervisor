// Read API for submission data (migration 4, PLAN M10): paper authors with
// affiliations, submission-option values, and the option definitions.
// Plain functions over the store's db handle, so the Store interface stays
// unchanged: `paperAuthors(store.db)`.

import type { Db } from "./db.js";

export interface PaperAuthorRow {
  pid: number;
  ord: number;
  /** Lowercased; null for an author listed without an email. */
  email: string | null;
  name: string | null;
  affiliation: string | null;
}

export interface PaperOptionRow {
  pid: number;
  /** The option's name in HotCRP (its /papers key), e.g. "Reserve designee". */
  name: string;
  /** string (text, dropdown choice), number, boolean, or string[] (checkboxes). */
  value: unknown;
  firstSeenAt: number;
  changedSeenAt: number;
}

export interface SubmissionFieldRow {
  name: string;
  sfId: number;
  type: string | null;
  /** Choice names for dropdown/radio/checkboxes. */
  values: string[] | null;
}

function pidClause(pids: readonly number[] | undefined, col: string): { sql: string; args: number[] } {
  if (!pids) return { sql: "", args: [] };
  return { sql: ` and ${col} in (select value from json_each(?))`, args: [JSON.stringify(pids)] as unknown as number[] };
}

/** Current authors, by pid then author order. */
export function paperAuthors(db: Db, o: { pids?: readonly number[] } = {}): PaperAuthorRow[] {
  const f = pidClause(o.pids, "pid");
  return db
    .prepare(`select pid, ord, email, name, affiliation from paper_author where removed_seen_at is null${f.sql} order by pid, ord`)
    .all(...f.args) as PaperAuthorRow[];
}

/** Current option values, optionally for one option name. */
export function paperOptions(db: Db, o: { name?: string; pids?: readonly number[] } = {}): PaperOptionRow[] {
  const f = pidClause(o.pids, "pid");
  const nameSql = o.name !== undefined ? " and name = ?" : "";
  const args: unknown[] = o.name !== undefined ? [o.name, ...f.args] : [...f.args];
  const rows = db
    .prepare(
      `select pid, name, value, first_seen_at, changed_seen_at from paper_option where removed_seen_at is null${nameSql}${f.sql} order by pid, name`,
    )
    .all(...args) as { pid: number; name: string; value: string; first_seen_at: number; changed_seen_at: number }[];
  return rows.map((r) => ({
    pid: r.pid,
    name: r.name,
    value: JSON.parse(r.value) as unknown,
    firstSeenAt: r.first_seen_at,
    changedSeenAt: r.changed_seen_at,
  }));
}

/** Configured submission options currently defined in HotCRP. */
export function submissionFields(db: Db): SubmissionFieldRow[] {
  const rows = db
    .prepare("select name, sf_id, type, values_json from submission_field where removed_seen_at is null order by sf_id")
    .all() as { name: string; sf_id: number; type: string | null; values_json: string | null }[];
  return rows.map((r) => ({
    name: r.name,
    sfId: r.sf_id,
    type: r.type,
    values: r.values_json ? (JSON.parse(r.values_json) as string[]) : null,
  }));
}
