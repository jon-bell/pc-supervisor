// Versioned storage of imports (spec §10.3, PLAN M9). Tables: migration 2 in
// ../store/migrations.ts.
//
// - importCsv(): parse + validate the whole file, then write one import_run
//   and all its rows in ONE transaction. Any problem -> nothing is written.
// - runAsOf(kind, t): the version in force at t (latest imported_at <= t).
// - diffRuns(kind, a, b): added / removed / changed rows by the kind's key.
//
// imported_at comes from the app clock (clock.ts, PCS_NOW), in epoch seconds.

import { createHash } from "node:crypto";
import type { Clock } from "../clock.js";
import type { Db } from "../store/db.js";
import { KINDS, rowKey, type ImportKind, type ImportRowMap, type ParseContext } from "./kinds.js";
import { parseImport, type ImportProblem } from "./parse.js";

export interface ImportRun<K extends ImportKind = ImportKind> {
  id: number;
  kind: K;
  fileSha256: string;
  fileName: string | null;
  /** Epoch seconds (app clock). */
  importedAt: number;
  rowCount: number;
}

export type ImportResult<K extends ImportKind = ImportKind> =
  | {
      ok: true;
      run: ImportRun<K>;
      ignoredColumns: string[];
      /** An earlier run of this kind with the same file hash, if any. */
      sameAsRunId: number | null;
    }
  | { ok: false; problems: ImportProblem[] };

export interface ImportOptions extends ParseContext {
  clock: Clock;
  /** Recorded for `pcs import --list`; pass a basename, not a full path. */
  fileName?: string;
}

const sec = (d: Date): number => Math.floor(d.getTime() / 1000);

interface RunSql {
  id: number;
  kind: ImportKind;
  file_sha256: string;
  file_name: string | null;
  imported_at: number;
  row_count: number;
}

function toRun(r: RunSql): ImportRun {
  return {
    id: r.id,
    kind: r.kind,
    fileSha256: r.file_sha256,
    fileName: r.file_name,
    importedAt: r.imported_at,
    rowCount: r.row_count,
  };
}

function sqlValue(v: unknown): unknown {
  return typeof v === "boolean" ? (v ? 1 : 0) : v;
}

/** Import `bytes` (a CSV file's contents) as a new version of `kind`. */
export function importCsv<K extends ImportKind>(
  db: Db,
  kind: K,
  bytes: Uint8Array | string,
  opts: ImportOptions,
): ImportResult<K> {
  const buf = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.from(bytes);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return { ok: false, problems: [{ line: null, column: null, message: "not UTF-8 text (export the sheet as CSV UTF-8)" }] };
  }
  const parsed = parseImport(kind, text, { tz: opts.tz });
  if (!parsed.ok) return parsed;

  const spec = KINDS[kind];
  const sha = createHash("sha256").update(buf).digest("hex");
  const cols = spec.columns.map((c) => c.name);
  const insertRow = db.prepare(
    `insert into ${spec.table} (run_id, line, ${cols.join(", ")}) values (?, ?, ${cols.map(() => "?").join(", ")})`,
  );
  const same = db
    .prepare("select max(id) as id from import_run where kind = ? and file_sha256 = ?")
    .get(kind, sha) as { id: number | null };

  const run = db.transaction((): ImportRun<K> => {
    const importedAt = sec(opts.clock.now());
    const info = db
      .prepare("insert into import_run (kind, file_sha256, file_name, imported_at, row_count) values (?, ?, ?, ?, ?)")
      .run(kind, sha, opts.fileName ?? null, importedAt, parsed.rows.length);
    const id = Number(info.lastInsertRowid);
    for (const { line, row } of parsed.rows) {
      const r = row as unknown as Record<string, unknown>;
      insertRow.run(id, line, ...cols.map((c) => sqlValue(r[c])));
    }
    return { id, kind, fileSha256: sha, fileName: opts.fileName ?? null, importedAt, rowCount: parsed.rows.length };
  })();
  return { ok: true, run, ignoredColumns: parsed.ignoredColumns, sameAsRunId: same.id };
}

/** Import history, oldest first; optionally one kind. */
export function listRuns(db: Db, kind?: ImportKind): ImportRun[] {
  const rows = (
    kind
      ? db.prepare("select * from import_run where kind = ? order by imported_at, id").all(kind)
      : db.prepare("select * from import_run order by imported_at, id").all()
  ) as RunSql[];
  return rows.map(toRun);
}

export function getRun(db: Db, id: number): ImportRun | undefined {
  const r = db.prepare("select * from import_run where id = ?").get(id) as RunSql | undefined;
  return r ? toRun(r) : undefined;
}

/** The version of `kind` in force at `at`: the latest run imported at or before it. */
export function runAsOf(db: Db, kind: ImportKind, at: Date): ImportRun | undefined {
  const r = db
    .prepare("select * from import_run where kind = ? and imported_at <= ? order by imported_at desc, id desc limit 1")
    .get(kind, sec(at)) as RunSql | undefined;
  return r ? toRun(r) : undefined;
}

/** The newest run of `kind`. */
export function latestRun(db: Db, kind: ImportKind): ImportRun | undefined {
  const r = db.prepare("select * from import_run where kind = ? order by imported_at desc, id desc limit 1").get(kind) as
    | RunSql
    | undefined;
  return r ? toRun(r) : undefined;
}

/** The run of the same kind just before `run` (for consecutive diffs). */
export function previousRun(db: Db, run: ImportRun): ImportRun | undefined {
  const r = db
    .prepare(
      `select * from import_run where kind = ? and (imported_at < ? or (imported_at = ? and id < ?))
       order by imported_at desc, id desc limit 1`,
    )
    .get(run.kind, run.importedAt, run.importedAt, run.id) as RunSql | undefined;
  return r ? toRun(r) : undefined;
}

/** The rows of one run, in file order. */
export function runRows<K extends ImportKind>(db: Db, kind: K, runId: number): ImportRowMap[K][] {
  const spec = KINDS[kind];
  const cols = spec.columns.map((c) => c.name);
  const bools = spec.columns.filter((c) => c.sql === "bool").map((c) => c.name);
  const rows = db.prepare(`select ${cols.join(", ")} from ${spec.table} where run_id = ? order by line`).all(runId) as Record<
    string,
    unknown
  >[];
  for (const r of rows) for (const b of bools) r[b] = r[b] === null ? null : r[b] === 1;
  return rows as unknown as ImportRowMap[K][];
}

/** What the sheet said at `at`: the rows of runAsOf(kind, at), or [] if none. */
export function rowsAsOf<K extends ImportKind>(db: Db, kind: K, at: Date): { run: ImportRun | undefined; rows: ImportRowMap[K][] } {
  const run = runAsOf(db, kind, at);
  return { run, rows: run ? runRows(db, kind, run.id) : [] };
}

export interface ImportDiff<R> {
  added: R[];
  removed: R[];
  changed: { before: R; after: R }[];
  unchanged: number;
}

function sameRow(a: Record<string, unknown>, b: Record<string, unknown>, cols: string[]): boolean {
  return cols.every((c) => a[c] === b[c]);
}

/**
 * Rows added, removed, and changed (same key, different values) between two
 * runs of `kind`. `fromRunId` null = diff against nothing (all added).
 */
export function diffRuns<K extends ImportKind>(
  db: Db,
  kind: K,
  fromRunId: number | null,
  toRunId: number,
): ImportDiff<ImportRowMap[K]> {
  const cols = KINDS[kind].columns.map((c) => c.name);
  const before = new Map((fromRunId === null ? [] : runRows(db, kind, fromRunId)).map((r) => [rowKey(kind, r), r]));
  const out: ImportDiff<ImportRowMap[K]> = { added: [], removed: [], changed: [], unchanged: 0 };
  for (const r of runRows(db, kind, toRunId)) {
    const k = rowKey(kind, r);
    const b = before.get(k);
    if (!b) out.added.push(r);
    else if (sameRow(b as unknown as Record<string, unknown>, r as unknown as Record<string, unknown>, cols)) out.unchanged++;
    else out.changed.push({ before: b, after: r });
    before.delete(k);
  }
  out.removed = [...before.values()];
  return out;
}

/** Diff a run against the previous run of its kind. */
export function diffWithPrevious<K extends ImportKind>(db: Db, run: ImportRun<K>): ImportDiff<ImportRowMap[K]> {
  return diffRuns(db, run.kind, previousRun(db, run)?.id ?? null, run.id);
}
