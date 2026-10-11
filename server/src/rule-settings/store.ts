// rule_revision (migration 7): the chair's rule-setting overrides, one
// append-only row per change. See migrations.ts for the column meanings.

import type { Db } from "../store/db.js";
import { sanitizeOverrides, type Overrides, type SettingChange } from "../rules/settings.js";

export interface RuleRevision {
  id: number;
  /** Epoch ms. */
  at: number;
  actor: string;
  kind: "set" | "revert";
  /** For a revert: the revision restored (0 = the env defaults). */
  revertedTo: number | null;
  note: string | null;
  /** The complete override map after this revision. */
  overrides: Overrides;
  diff: SettingChange[];
}

interface Row {
  id: number;
  at: number;
  actor: string;
  kind: "set" | "revert";
  reverted_to: number | null;
  note: string | null;
  overrides: string;
  diff: string;
}

function parse(r: Row): RuleRevision {
  let raw: unknown = {};
  let diff: unknown = [];
  try {
    raw = JSON.parse(r.overrides);
    diff = JSON.parse(r.diff);
  } catch {
    // A corrupt row reads as "no overrides" rather than crashing every view.
  }
  return {
    id: r.id,
    at: r.at * 1000,
    actor: r.actor,
    kind: r.kind,
    revertedTo: r.reverted_to,
    note: r.note,
    overrides: sanitizeOverrides(raw).overrides,
    diff: Array.isArray(diff) ? (diff as SettingChange[]) : [],
  };
}

/** The latest revision id (0 = none: the env defaults apply). One indexed lookup. */
export function latestRevisionId(db: Db): number {
  return (db.prepare("select coalesce(max(id), 0) as id from rule_revision").get() as { id: number }).id;
}

export function getRevision(db: Db, id: number): RuleRevision | null {
  const r = db.prepare("select * from rule_revision where id = ?").get(id) as Row | undefined;
  return r ? parse(r) : null;
}

/** The overrides in force now (latest revision), or none. */
export function currentOverrides(db: Db): { revision: RuleRevision | null; overrides: Overrides } {
  const r = db.prepare("select * from rule_revision order by id desc limit 1").get() as Row | undefined;
  const rev = r ? parse(r) : null;
  return { revision: rev, overrides: rev?.overrides ?? {} };
}

/** The overrides in force at an instant (epoch ms): the latest revision at or before it. */
export function overridesAt(db: Db, atMs: number): Overrides {
  const r = db.prepare("select * from rule_revision where at <= ? order by at desc, id desc limit 1").get(Math.floor(atMs / 1000)) as Row | undefined;
  return r ? parse(r).overrides : {};
}

/** Newest first. */
export function listRevisions(db: Db, o: { limit?: number } = {}): RuleRevision[] {
  return (db.prepare("select * from rule_revision order by id desc limit ?").all(o.limit ?? 200) as Row[]).map(parse);
}

export interface NewRevision {
  atMs: number;
  actor: string;
  kind: "set" | "revert";
  revertedTo?: number | null;
  note?: string | null;
  overrides: Overrides;
  diff: SettingChange[];
}

export function insertRevision(db: Db, r: NewRevision): RuleRevision {
  const info = db
    .prepare("insert into rule_revision (at, actor, kind, reverted_to, note, overrides, diff) values (?, ?, ?, ?, ?, ?, ?)")
    .run(Math.floor(r.atMs / 1000), r.actor, r.kind, r.revertedTo ?? null, r.note ?? null, JSON.stringify(r.overrides), JSON.stringify(r.diff));
  return getRevision(db, Number(info.lastInsertRowid))!;
}
