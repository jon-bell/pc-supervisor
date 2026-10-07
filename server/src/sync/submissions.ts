// Sync of submission data (PLAN M10, phase-2 foundations): configured
// submission fields (GET /settings?filter=sf), paper authors with emails and
// affiliations, and submission-option values (GET /papers, pid chunks).
// Called by runSync inside its transaction. Abstracts, documents, and any
// other paper content in /papers are ignored, never stored.
//
// Same conventions as the rest of the store: current state plus first-seen
// and removed-seen times; nothing is deleted.

import { submissionOptionValue, type Paper, type SettingsSfField } from "../hotcrp/schemas.js";
import type { Db } from "../store/db.js";

export interface CountSink {
  add(key: string, n?: number): void;
}

/** Option types whose values are documents or layout, not data. */
const SKIP_OPTION_TYPES: ReadonlySet<string> = new Set(["pdf", "slides", "document", "attachments", "separator"]);

/** The configured submission options worth storing: numeric id, data-valued type. */
export function storedOptionFields(sf: readonly SettingsSfField[]): SettingsSfField[] {
  return sf.filter((f) => typeof f.id === "number" && !SKIP_OPTION_TYPES.has(f.type ?? ""));
}

/** Upsert submission_field rows; mark vanished ones removed. */
export function syncSubmissionFields(db: Db, fields: readonly SettingsSfField[], now: number, counts: CountSink): void {
  const get = db.prepare("select sf_id, type, values_json, removed_seen_at from submission_field where name = ?");
  const ins = db.prepare(
    "insert into submission_field (name, sf_id, type, values_json, first_seen_at) values (?, ?, ?, ?, ?)",
  );
  const upd = db.prepare(
    "update submission_field set sf_id = ?, type = ?, values_json = ?, removed_seen_at = null where name = ?",
  );
  const seen = new Set<string>();
  for (const f of fields) {
    if (seen.has(f.name)) continue;
    seen.add(f.name);
    const values = f.values ? JSON.stringify(f.values.map((v) => v.name)) : null;
    const type = f.type ?? null;
    const old = get.get(f.name) as
      | { sf_id: number; type: string | null; values_json: string | null; removed_seen_at: number | null }
      | undefined;
    if (!old) {
      ins.run(f.name, f.id as number, type, values, now);
      counts.add("submission_fields_new");
    } else if (old.sf_id !== f.id || old.type !== type || old.values_json !== values || old.removed_seen_at !== null) {
      upd.run(f.id as number, type, values, f.name);
      counts.add("submission_fields_changed");
    }
  }
  const live = db.prepare("select name from submission_field where removed_seen_at is null").all() as { name: string }[];
  const rm = db.prepare("update submission_field set removed_seen_at = ? where name = ?");
  for (const { name } of live) {
    if (!seen.has(name)) {
      rm.run(now, name);
      counts.add("submission_fields_removed");
    }
  }
}

export function submissionStatements(db: Db) {
  return {
    authors: db.prepare("select author_key, ord, email, name, affiliation, removed_seen_at from paper_author where pid = ?"),
    insAuthor: db.prepare(
      "insert into paper_author (pid, author_key, ord, email, name, affiliation, first_seen_at) values (?, ?, ?, ?, ?, ?, ?)",
    ),
    updAuthor: db.prepare(
      "update paper_author set ord = ?, email = ?, name = ?, affiliation = ?, removed_seen_at = null where pid = ? and author_key = ?",
    ),
    rmAuthor: db.prepare("update paper_author set removed_seen_at = ? where pid = ? and author_key = ?"),
    options: db.prepare("select name, value, removed_seen_at from paper_option where pid = ?"),
    insOption: db.prepare(
      "insert into paper_option (pid, name, value, first_seen_at, changed_seen_at) values (?, ?, ?, ?, ?)",
    ),
    updOption: db.prepare(
      "update paper_option set value = ?, changed_seen_at = ?, removed_seen_at = null where pid = ? and name = ?",
    ),
    rmOption: db.prepare("update paper_option set removed_seen_at = ? where pid = ? and name = ?"),
  };
}

export interface SubmissionCtx {
  now: number;
  /** Option names to store (storedOptionFields). */
  optionNames: readonly string[];
}

const clean = (s: string | undefined): string | null => {
  const t = (s ?? "").trim();
  return t === "" ? null : t;
};

/** Authors and option values of one chunk of /papers objects. */
export function applyPaperDetails(
  st: ReturnType<typeof submissionStatements>,
  papers: readonly Paper[],
  ctx: SubmissionCtx,
  counts: CountSink,
): void {
  for (const p of papers) {
    if (p.authors === undefined) {
      // Not visible to this token (blind submission without forceShow):
      // keep what we had rather than marking every author removed.
      counts.add("papers_authors_hidden");
    } else {
      applyAuthors(st, p, ctx.now, counts);
    }
    applyOptions(st, p, ctx, counts);
  }
}

function applyAuthors(st: ReturnType<typeof submissionStatements>, p: Paper, now: number, counts: CountSink): void {
  type Old = { author_key: string; ord: number; email: string | null; name: string | null; affiliation: string | null; removed_seen_at: number | null };
  const old = new Map((st.authors.all(p.pid) as Old[]).map((r) => [r.author_key, r]));
  const seen = new Set<string>();
  (p.authors ?? []).forEach((a, ord) => {
    const email = clean(a.email)?.toLowerCase() ?? null;
    const name = clean([a.given_name ?? "", a.family_name ?? ""].join(" "));
    const key = email ?? `name:${(name ?? "").toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    const aff = clean(a.affiliation);
    const prev = old.get(key);
    if (!prev) {
      st.insAuthor.run(p.pid, key, ord, email, name, aff, now);
      counts.add("authors_new");
    } else if (prev.ord !== ord || prev.email !== email || prev.name !== name || prev.affiliation !== aff || prev.removed_seen_at !== null) {
      st.updAuthor.run(ord, email, name, aff, p.pid, key);
      counts.add("authors_changed");
    }
  });
  for (const [key, prev] of old) {
    if (prev.removed_seen_at === null && !seen.has(key)) {
      st.rmAuthor.run(now, p.pid, key);
      counts.add("authors_removed");
    }
  }
}

function applyOptions(st: ReturnType<typeof submissionStatements>, p: Paper, ctx: SubmissionCtx, counts: CountSink): void {
  type Old = { name: string; value: string; removed_seen_at: number | null };
  const old = new Map((st.options.all(p.pid) as Old[]).map((r) => [r.name, r]));
  for (const name of ctx.optionNames) {
    const v = submissionOptionValue(p, name);
    const empty = v === undefined || v === null || v === "" || v === false || (Array.isArray(v) && v.length === 0);
    const prev = old.get(name);
    if (empty) {
      if (prev && prev.removed_seen_at === null) {
        st.rmOption.run(ctx.now, p.pid, name);
        counts.add("options_removed");
      }
      continue;
    }
    const value = JSON.stringify(v);
    if (!prev) {
      st.insOption.run(p.pid, name, value, ctx.now, ctx.now);
      counts.add("options_new");
    } else if (prev.value !== value || prev.removed_seen_at !== null) {
      st.updOption.run(value, ctx.now, p.pid, name);
      counts.add("options_changed");
    }
  }
}
