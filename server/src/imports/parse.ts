// CSV text -> validated rows for one import kind, or a row-level error report.
// All-or-nothing: if any row has any problem, no rows are returned.

import { CsvError, parseCsvLines } from "../hotcrp/csv.js";
import {
  KINDS,
  normalizeHeader,
  rowKey,
  rowSchema,
  type ImportKind,
  type ImportRowMap,
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

export type ParseResult<K extends ImportKind> =
  | { ok: true; rows: ParsedRow<ImportRowMap[K]>[]; ignoredColumns: string[] }
  | { ok: false; problems: ImportProblem[] };

export function parseImport<K extends ImportKind>(kind: K, text: string, ctx: ParseContext): ParseResult<K> {
  const spec = KINDS[kind];
  let lines;
  try {
    lines = parseCsvLines(text);
  } catch (e) {
    if (e instanceof CsvError) {
      const m = /^line (\d+): (.*)$/.exec(e.message);
      return { ok: false, problems: [{ line: m ? Number(m[1]) : null, column: null, message: m ? m[2]! : e.message }] };
    }
    throw e;
  }
  const [header, ...body] = lines;
  if (!header) return { ok: false, problems: [{ line: null, column: null, message: "empty file (no header row)" }] };

  // Map each header cell to a canonical column (or ignore it).
  const lookup = new Map<string, string>();
  for (const c of spec.columns) for (const n of [c.name, ...c.aliases]) lookup.set(normalizeHeader(n), c.name);
  const problems: ImportProblem[] = [];
  const indexOf = new Map<string, number>();
  const ignoredColumns: string[] = [];
  header.cells.forEach((h, i) => {
    const name = lookup.get(normalizeHeader(h));
    if (name === undefined) {
      if (h.trim() !== "") ignoredColumns.push(h.trim());
    } else if (indexOf.has(name)) {
      problems.push({ line: header.line, column: name, message: `column given twice (header cells ${indexOf.get(name)! + 1} and ${i + 1})` });
    } else {
      indexOf.set(name, i);
    }
  });
  for (const c of spec.columns) {
    if (c.required && !indexOf.has(c.name)) {
      const aka = c.aliases.length ? ` (or ${c.aliases.join(", ")})` : "";
      problems.push({ line: header.line, column: c.name, message: `required column missing${aka}` });
    }
  }
  if (problems.length > 0) return { ok: false, problems };

  const schema = rowSchema(kind, ctx);
  const rows: ParsedRow<ImportRowMap[K]>[] = [];
  const seen = new Map<string, number>();
  for (const { line, cells } of body) {
    if (cells.length > header.cells.length) {
      problems.push({ line, column: null, message: `${cells.length} fields but the header has ${header.cells.length}` });
      continue;
    }
    const rec: Record<string, string | undefined> = {};
    for (const [name, i] of indexOf) rec[name] = cells[i];
    const r = schema.safeParse(rec);
    if (!r.success) {
      for (const iss of r.error.issues) {
        const column = typeof iss.path[0] === "string" ? iss.path[0] : null;
        problems.push({ line, column, message: iss.message });
      }
      continue;
    }
    const key = rowKey(kind, r.data);
    const first = seen.get(key);
    if (first !== undefined) {
      problems.push({ line, column: spec.key.join("+"), message: `duplicate key (first at line ${first})` });
      continue;
    }
    seen.set(key, line);
    rows.push({ line, row: r.data });
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, rows, ignoredColumns };
}

/** "line 7, column pid: not an integer" */
export function formatProblem(p: ImportProblem): string {
  const where = [p.line === null ? "file" : `line ${p.line}`, p.column ? `column ${p.column}` : null].filter(Boolean);
  return `${where.join(", ")}: ${p.message}`;
}
