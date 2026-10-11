// Versioned storage of imports (spec §10.3, PLAN M9). Tables: migration 2 in
// ../store/migrations.ts.
//
// - importCsv() / importFile(): stream the file through the validator and
//   write one import_run and all its rows in ONE transaction, rolled back on
//   any problem: nothing is written. Memory is bounded by the longest row.
// - runAsOf(kind, t): the version in force at t (latest imported_at <= t).
// - diffRuns(kind, a, b): added / removed / changed rows by the kind's key.
//
// imported_at comes from the app clock (clock.ts, PCS_NOW), in epoch seconds.

import { createHash } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";
import type { Clock } from "../clock.js";
import { CsvError } from "../hotcrp/csv.js";
import type { Db } from "../store/db.js";
import { CsvStreamParser } from "./csv-stream.js";
import { KINDS, rowKey, type ImportKind, type ImportRowMap, type ParseContext } from "./kinds.js";
import { csvProblem, ImportRowReader, type ImportProblem, type ParseOptions } from "./parse.js";

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
      /** The file had no header row (--no-header, or a sniffed plain list). */
      headerless: boolean;
      /** An earlier run of this kind with the same file hash, if any. */
      sameAsRunId: number | null;
    }
  | {
      ok: false;
      /** The first MAX_PROBLEMS_KEPT problems. */
      problems: ImportProblem[];
      problemCount: number;
    };

export interface ImportOptions extends ParseContext, ParseOptions {
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

/** Bytes read per chunk when streaming a file. */
const CHUNK_BYTES = 1 << 20;

class Rollback extends Error {}

function* bufferChunks(buf: Uint8Array): Generator<Uint8Array> {
  for (let i = 0; i < buf.length; i += CHUNK_BYTES) yield buf.subarray(i, i + CHUNK_BYTES);
}

function* fileChunks(path: string): Generator<Uint8Array> {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.allocUnsafe(CHUNK_BYTES);
    for (;;) {
      const n = readSync(fd, buf, 0, CHUNK_BYTES, null);
      if (n === 0) return;
      yield buf.subarray(0, n);
    }
  } finally {
    closeSync(fd);
  }
}

/** Import `bytes` (a CSV file's contents) as a new version of `kind`. */
export function importCsv<K extends ImportKind>(
  db: Db,
  kind: K,
  bytes: Uint8Array | string,
  opts: ImportOptions,
): ImportResult<K> {
  const buf = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
  return importChunks(db, kind, bufferChunks(buf), opts);
}

/** Import a CSV file by streaming it (memory stays bounded, whatever the file size). */
export function importFile<K extends ImportKind>(db: Db, kind: K, path: string, opts: ImportOptions): ImportResult<K> {
  return importChunks(db, kind, fileChunks(path), opts);
}

/**
 * The streaming import: decode, parse, validate, and insert row by row inside
 * one transaction, which is rolled back if any problem turns up. Duplicate
 * keys are caught by the table's primary key (no in-memory key set).
 */
export function importChunks<K extends ImportKind>(
  db: Db,
  kind: K,
  chunks: Iterable<Uint8Array>,
  opts: ImportOptions,
): ImportResult<K> {
  const spec = KINDS[kind];
  const cols = spec.columns.map((c) => c.name);
  const insertRow = db.prepare(
    `insert into ${spec.table} (run_id, line, ${cols.join(", ")}) values (?, ?, ${cols.map(() => "?").join(", ")}) on conflict do nothing`,
  );
  const firstLine = db.prepare(`select line from ${spec.table} where run_id = ? and ${spec.key.map((k) => `${k} = ?`).join(" and ")}`);
  const reader = new ImportRowReader(kind, { tz: opts.tz }, { map: opts.map, header: opts.header });
  const hash = createHash("sha256");
  const decoder = new TextDecoder("utf-8", { fatal: true });

  let result: { run: ImportRun<K>; ignoredColumns: string[] } | undefined;
  try {
    result = db.transaction(() => {
      const importedAt = sec(opts.clock.now());
      const info = db
        .prepare("insert into import_run (kind, file_sha256, file_name, imported_at, row_count) values (?, '', ?, ?, 0)")
        .run(kind, opts.fileName ?? null, importedAt);
      const id = Number(info.lastInsertRowid);
      let count = 0;
      const parser = new CsvStreamParser((l) => {
        const p = reader.next(l);
        if (!p) return;
        const r = p.row as unknown as Record<string, unknown>;
        if (insertRow.run(id, p.line, ...cols.map((c) => sqlValue(r[c]))).changes === 0) {
          const first = firstLine.get(id, ...spec.key.map((k) => r[k])) as { line: number };
          reader.problems.add({ line: p.line, column: spec.key.join("+"), message: `duplicate key (first at line ${first.line})` });
        } else {
          count++;
        }
      });
      try {
        for (const chunk of chunks) {
          hash.update(chunk);
          parser.push(decoder.decode(chunk, { stream: true }));
          if (reader.dead) break;
        }
        if (!reader.dead) {
          parser.push(decoder.decode());
          parser.end();
        }
      } catch (e) {
        if (e instanceof CsvError) reader.problems.add(csvProblem(e));
        else if (e instanceof TypeError && (e as { code?: string }).code === "ERR_ENCODING_INVALID_ENCODED_DATA") {
          reader.problems.add({ line: null, column: null, message: "not UTF-8 text (export the sheet as CSV UTF-8)" });
        } else throw e;
        reader.dead = true;
      }
      reader.finish();
      if (reader.problems.count > 0) throw new Rollback();
      const sha = hash.digest("hex");
      db.prepare("update import_run set file_sha256 = ?, row_count = ? where id = ?").run(sha, count, id);
      return {
        run: { id, kind, fileSha256: sha, fileName: opts.fileName ?? null, importedAt, rowCount: count },
        ignoredColumns: reader.ignoredColumns,
      };
    })();
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  if (!result) return { ok: false, problems: reader.problems.items, problemCount: reader.problems.count };
  const same = db
    .prepare("select max(id) as id from import_run where kind = ? and file_sha256 = ? and id < ?")
    .get(kind, result.run.fileSha256, result.run.id) as { id: number | null };
  return { ok: true, ...result, headerless: reader.headerless, sameAsRunId: same.id };
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

export interface DiffCounts {
  added: number;
  removed: number;
  changed: number;
  unchanged: number;
}

/**
 * The counts of diffRuns, computed in SQL over the (run_id, key) primary key:
 * no rows are loaded, so it suits the 1.44M-row affinity kinds too.
 */
export function diffCounts(db: Db, kind: ImportKind, fromRunId: number | null, toRunId: number): DiffCounts {
  const spec = KINDS[kind];
  const t = spec.table;
  const total = (id: number) => (db.prepare(`select count(*) as n from ${t} where run_id = ?`).get(id) as { n: number }).n;
  const to = total(toRunId);
  if (fromRunId === null) return { added: to, removed: 0, changed: 0, unchanged: 0 };
  const from = total(fromRunId);
  const on = spec.key.map((k) => `a.${k} = b.${k}`).join(" and ");
  const values = spec.columns.map((c) => c.name).filter((c) => !spec.key.includes(c));
  const differs = values.length > 0 ? values.map((c) => `a.${c} is not b.${c}`).join(" or ") : "0";
  const m = db
    .prepare(`select count(*) as matched, coalesce(sum(${differs}), 0) as changed from ${t} a join ${t} b on ${on} where a.run_id = ? and b.run_id = ?`)
    .get(fromRunId, toRunId) as { matched: number; changed: number };
  return { added: to - m.matched, removed: from - m.matched, changed: m.changed, unchanged: m.matched - m.changed };
}

/** diffCounts against the previous run of the same kind. */
export function diffCountsWithPrevious(db: Db, run: ImportRun): DiffCounts & { previousRunId: number | null } {
  const prev = previousRun(db, run)?.id ?? null;
  return { ...diffCounts(db, run.kind, prev, run.id), previousRunId: prev };
}

/** Diff a run against the previous run of its kind. */
export function diffWithPrevious<K extends ImportKind>(db: Db, run: ImportRun<K>): ImportDiff<ImportRowMap[K]> {
  return diffRuns(db, run.kind, previousRun(db, run)?.id ?? null, run.id);
}
