// CSV rows -> validated rows for one import kind, or a row-level error report.
// All-or-nothing: if any row has any problem, nothing is imported.
//
// ImportRowReader validates one CSV row at a time (header first), so a large
// file (a 1.44M-row affinity matrix) streams through it; ./store.ts feeds it
// from the file and checks duplicate keys in SQL. parseImport() is the
// in-memory form for a whole text.
//
// Column binding, in order:
//   1. --map (`paper=Paper ID,email=Reviewer[,round=…]`): a mapped column is
//      read from the named header (matched like any header) or, for a bare
//      number, from that 1-based position. The mapping overrides header
//      detection for the columns it names.
//   2. Every other column is found by its name or aliases, among the headers
//      the mapping didn't take.
//   3. A header-less file (--no-header, or a kind that sniffs it, e.g. a
//      plain list of registered emails) binds columns by position, in the
//      kind's column order, unless mapped.

import { CsvError, type CsvLine } from "../hotcrp/csv.js";
import { CsvStreamParser } from "./csv-stream.js";
import {
  KINDS,
  normalizeHeader,
  rowKey,
  rowSchema,
  type ImportKind,
  type ImportRowMap,
  type KindSpec,
  type ParseContext,
} from "./kinds.js";

export interface ImportProblem {
  /** 1-based line in the file (the header is line 1); null = the whole file. */
  line: number | null;
  /** Canonical column name, when the problem is in one cell or one column. */
  column: string | null;
  message: string;
}

export interface ParsedRow<R> {
  line: number;
  row: R;
}

export interface ParseOptions {
  /** Column mapping, as given to `pcs import --map`. */
  map?: string | undefined;
  /** false = the file has no header row (`--no-header`). Default: it has one. */
  header?: boolean | undefined;
}

export type ParseResult<K extends ImportKind> =
  | { ok: true; rows: ParsedRow<ImportRowMap[K]>[]; ignoredColumns: string[]; headerless: boolean }
  | { ok: false; problems: ImportProblem[]; problemCount: number };

/** A large bad file reports at most this many problems (all are counted). */
export const MAX_PROBLEMS_KEPT = 1000;

export class ProblemList {
  readonly items: ImportProblem[] = [];
  count = 0;
  add(p: ImportProblem): void {
    this.count++;
    if (this.items.length < MAX_PROBLEMS_KEPT) this.items.push(p);
  }
}

type Target = { header: string } | { position: number };

/**
 * Parse a --map value: comma-separated `column=header` pairs, where column is
 * a canonical column name or alias of the kind (`paper` = pid) and header a
 * header cell or a 1-based position. Header names can't contain commas.
 */
export function parseColumnMap(spec: KindSpec, text: string, problems: ProblemList): Map<string, Target> {
  const names = new Map<string, string>();
  for (const c of spec.columns) for (const n of [c.name, ...c.aliases]) names.set(normalizeHeader(n), c.name);
  const out = new Map<string, Target>();
  for (const part of text.split(",")) {
    if (part.trim() === "") continue;
    const eq = part.indexOf("=");
    const key = eq < 0 ? part.trim() : part.slice(0, eq).trim();
    const value = eq < 0 ? "" : part.slice(eq + 1).trim();
    const name = names.get(normalizeHeader(key));
    if (name === undefined) {
      problems.add({ line: null, column: null, message: `--map: ${JSON.stringify(key)} is not a ${spec.kind} column (columns: ${spec.columns.map((c) => c.name).join(", ")})` });
    } else if (value === "") {
      problems.add({ line: null, column: name, message: "--map: expected column=header, e.g. paper=Paper ID" });
    } else if (out.has(name)) {
      problems.add({ line: null, column: name, message: "--map: column mapped twice" });
    } else {
      out.set(name, /^\d+$/.test(value) ? { position: Number(value) } : { header: value });
    }
  }
  return out;
}

/** Validates the rows of one file, one CSV row at a time. */
export class ImportRowReader<K extends ImportKind> {
  readonly problems = new ProblemList();
  readonly ignoredColumns: string[] = [];
  headerless = false;
  /** A header or mapping problem: no row can be read; stop feeding. */
  dead = false;
  readonly #spec: KindSpec;
  readonly #kind: K;
  readonly #ctx: ParseContext;
  readonly #opts: ParseOptions;
  #width = 0;
  #indexOf = new Map<string, number>();
  #schema: ReturnType<typeof rowSchema<K>> | undefined;
  #seenFirst = false;

  constructor(kind: K, ctx: ParseContext, opts: ParseOptions = {}) {
    this.#kind = kind;
    this.#spec = KINDS[kind];
    this.#ctx = ctx;
    this.#opts = opts;
  }

  /** Feed one CSV row. Returns the validated row, or undefined (header, or a problem was recorded). */
  next(l: CsvLine): ParsedRow<ImportRowMap[K]> | undefined {
    if (this.dead) return undefined;
    if (!this.#seenFirst) {
      this.#seenFirst = true;
      this.#bind(l);
      if (this.dead || !this.headerless) return undefined;
    }
    return this.#row(l);
  }

  /** Call at the end of the input. */
  finish(): void {
    if (!this.#seenFirst && !this.dead) {
      this.problems.add({ line: null, column: null, message: "empty file (no header row)" });
      this.dead = true;
    }
  }

  #bind(first: CsvLine): void {
    const spec = this.#spec;
    const lookup = new Map<string, string>();
    for (const c of spec.columns) for (const n of [c.name, ...c.aliases]) lookup.set(normalizeHeader(n), c.name);
    const map = this.#opts.map !== undefined ? parseColumnMap(spec, this.#opts.map, this.problems) : new Map<string, Target>();
    if (this.problems.count > 0) {
      this.dead = true;
      return;
    }
    this.headerless =
      this.#opts.header === false ||
      (this.#opts.header === undefined &&
        map.size === 0 &&
        spec.sniffHeaderless !== undefined &&
        spec.sniffHeaderless(first.cells) &&
        first.cells.every((h) => !lookup.has(normalizeHeader(h))));
    const cells = first.cells;
    this.#width = cells.length;
    const line = this.headerless ? null : first.line;
    const used = new Map<number, string>();
    const bindTo = (name: string, i: number) => {
      const other = used.get(i);
      if (other !== undefined) {
        this.problems.add({ line, column: name, message: `--map: column ${i + 1} is already mapped to ${other}` });
        return;
      }
      used.set(i, name);
      this.#indexOf.set(name, i);
    };

    // 1. The mapping.
    for (const [name, t] of map) {
      if ("position" in t) {
        if (t.position < 1 || t.position > cells.length) {
          this.problems.add({ line, column: name, message: `--map: position ${t.position} is outside the ${cells.length} column(s) of the ${this.headerless ? "first row" : "header"}` });
        } else {
          bindTo(name, t.position - 1);
        }
      } else if (this.headerless) {
        this.problems.add({ line: null, column: name, message: "--map: a file without a header row needs column positions (e.g. paper=1)" });
      } else {
        const want = normalizeHeader(t.header);
        const hits = cells.flatMap((h, i) => (normalizeHeader(h) === want ? [i] : []));
        if (hits.length === 0) this.problems.add({ line, column: name, message: `--map: no header cell is named ${JSON.stringify(t.header)}` });
        else if (hits.length > 1) this.problems.add({ line, column: name, message: `--map: header cells ${hits.map((i) => i + 1).join(" and ")} are both named ${JSON.stringify(t.header)}` });
        else bindTo(name, hits[0]!);
      }
    }

    // 2./3. Everything else, by header name or by position.
    if (this.headerless) {
      if (map.size === 0) spec.columns.forEach((c, i) => i < cells.length && bindTo(c.name, i));
      for (let i = spec.columns.length; i < cells.length; i++) if (!used.has(i)) this.ignoredColumns.push(`column ${i + 1}`);
    } else {
      cells.forEach((h, i) => {
        if (used.has(i)) return;
        const name = lookup.get(normalizeHeader(h));
        if (name === undefined || map.has(name)) {
          if (h.trim() !== "") this.ignoredColumns.push(h.trim());
        } else if (this.#indexOf.has(name)) {
          this.problems.add({ line, column: name, message: `column given twice (header cells ${this.#indexOf.get(name)! + 1} and ${i + 1})` });
        } else {
          bindTo(name, i);
        }
      });
    }
    for (const c of spec.columns) {
      if (c.required && !this.#indexOf.has(c.name)) {
        const aka = c.aliases.length ? ` (or ${c.aliases.join(", ")})` : "";
        this.problems.add({ line: this.headerless ? null : first.line, column: c.name, message: `required column missing${aka}` });
      }
    }
    if (this.problems.count > 0) {
      this.dead = true;
      return;
    }
    const absent = new Set(spec.columns.map((c) => c.name).filter((n) => !this.#indexOf.has(n)));
    this.#schema = rowSchema(this.#kind, this.#ctx, absent);
  }

  #row({ line, cells }: CsvLine): ParsedRow<ImportRowMap[K]> | undefined {
    if (cells.length > this.#width) {
      this.problems.add({ line, column: null, message: `${cells.length} fields but the ${this.headerless ? "first row" : "header"} has ${this.#width}` });
      return undefined;
    }
    const rec: Record<string, string | undefined> = {};
    for (const [name, i] of this.#indexOf) rec[name] = cells[i];
    const r = this.#schema!.safeParse(rec);
    if (!r.success) {
      for (const iss of r.error.issues) {
        const column = typeof iss.path[0] === "string" ? iss.path[0] : null;
        this.problems.add({ line, column, message: iss.message });
      }
      return undefined;
    }
    return { line, row: r.data };
  }
}

/** A CSV syntax error as a problem ("line 7: unterminated quoted field"). */
export function csvProblem(e: CsvError): ImportProblem {
  const m = /^line (\d+): (.*)$/.exec(e.message);
  return { line: m ? Number(m[1]) : null, column: null, message: m ? m[2]! : e.message };
}

/** Validate a whole CSV text in memory (small files; see store.ts for streaming). */
export function parseImport<K extends ImportKind>(kind: K, text: string, ctx: ParseContext, opts: ParseOptions = {}): ParseResult<K> {
  const spec = KINDS[kind];
  const reader = new ImportRowReader(kind, ctx, opts);
  const rows: ParsedRow<ImportRowMap[K]>[] = [];
  const seen = new Map<string, number>();
  const parser = new CsvStreamParser((l) => {
    const p = reader.next(l);
    if (!p) return;
    const key = rowKey(kind, p.row);
    const first = seen.get(key);
    if (first !== undefined) {
      reader.problems.add({ line: p.line, column: spec.key.join("+"), message: `duplicate key (first at line ${first})` });
      return;
    }
    seen.set(key, p.line);
    rows.push(p);
  });
  try {
    parser.push(text);
    parser.end();
  } catch (e) {
    if (!(e instanceof CsvError)) throw e;
    reader.problems.add(csvProblem(e));
  }
  reader.finish();
  const { problems } = reader;
  return problems.count > 0
    ? { ok: false, problems: problems.items, problemCount: problems.count }
    : { ok: true, rows, ignoredColumns: reader.ignoredColumns, headerless: reader.headerless };
}

/** "line 7, column pid: not an integer" */
export function formatProblem(p: ImportProblem): string {
  const where = [p.line === null ? "file" : `line ${p.line}`, p.column ? `column ${p.column}` : null].filter(Boolean);
  return `${where.join(", ")}: ${p.message}`;
}
