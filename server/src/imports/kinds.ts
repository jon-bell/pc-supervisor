// Import kinds for `pcs import <kind> <file>` (spec §10.3, PLAN M9): the
// expected CSV columns of each kind and a Zod row schema that turns one CSV
// record (header name -> cell text) into a typed row.
//
// Headers are matched case-insensitively after trimming and turning runs of
// spaces and hyphens into "_" ("Candidate Email" = candidate_email). Each
// column also accepts the aliases listed with it. Column order doesn't matter
// and extra columns are ignored. A cell that is empty or only whitespace is
// "unset": optional columns become null (or their default).
//
// Error messages name the problem, never the cell's value: these files hold
// reviewer identities, and the report may end up in a terminal log.

import { z } from "zod";
import { parseIsoLocal, zonedTimeToInstant } from "../tz.js";

export const IMPORT_KINDS = ["invites", "tpms-assignments", "tpms-registrations", "refcheck", "do-not-invite"] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

export function isImportKind(s: string): s is ImportKind {
  return (IMPORT_KINDS as readonly string[]).includes(s);
}

/** What a cell parser needs besides the text. */
export interface ParseContext {
  /** PCS_TZ, for dates without an explicit offset. */
  tz: string;
}

type SqlType = "integer" | "real" | "text" | "bool";

export interface ColumnSpec {
  /** Canonical (snake_case) name: the header to use, the row key, and the SQL column. */
  name: string;
  aliases: readonly string[];
  required: boolean;
  /** One line for docs and `pcs import --help`. */
  doc: string;
  sql: SqlType;
  cell: (ctx: ParseContext) => z.ZodType<unknown, string | undefined>;
}

// ---------------------------------------------------------------------------
// Cell parsers. Input: the raw cell, or undefined if the column is absent or
// the row is short. Output: the typed value.

type Cell = string | undefined;
const cellIn = z.string().optional();

function blank(v: Cell): v is undefined {
  return v === undefined || v.trim() === "";
}

function issue(ctx: z.RefinementCtx, message: string): typeof z.NEVER {
  ctx.addIssue({ code: "custom", message });
  return z.NEVER;
}

// Deliberately loose: one @, something on both sides, a dot in the domain, no
// spaces or commas. HotCRP accounts are the real check (M10/M11 join on them).
const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

function emailCell(required: boolean) {
  return cellIn.transform((v, ctx): string | null => {
    if (blank(v)) return required ? issue(ctx, "required (an email address)") : null;
    const s = v.trim().toLowerCase();
    return EMAIL_RE.test(s) ? s : issue(ctx, "not an email address");
  });
}

function intCell(opts: { required: boolean; min: number }) {
  return cellIn.transform((v, ctx): number | null => {
    if (blank(v)) return opts.required ? issue(ctx, "required (an integer)") : null;
    const s = v.trim();
    const n = /^[+-]?\d+$/.test(s) ? Number(s) : NaN;
    if (!Number.isSafeInteger(n)) return issue(ctx, "not an integer");
    return n < opts.min ? issue(ctx, `must be at least ${opts.min}`) : n;
  });
}

function numberCell() {
  return cellIn.transform((v, ctx): number | null => {
    if (blank(v)) return null;
    const s = v.trim();
    const n = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s) ? Number(s) : NaN;
    return Number.isFinite(n) ? n : issue(ctx, "not a number");
  });
}

function textCell() {
  return cellIn.transform((v): string | null => (blank(v) ? null : v.trim()));
}

function enumCell<const T extends string>(values: readonly T[], dflt: T) {
  return cellIn.transform((v, ctx): T => {
    if (blank(v)) return dflt;
    const s = v.trim().toLowerCase();
    return (values as readonly string[]).includes(s) ? (s as T) : issue(ctx, `expected one of ${values.join(", ")}`);
  });
}

const TRUE = new Set(["1", "true", "yes", "y"]);
const FALSE = new Set(["0", "false", "no", "n"]);

function boolCell(required: boolean) {
  return cellIn.transform((v, ctx): boolean | null => {
    if (blank(v)) return required ? issue(ctx, "required (yes or no)") : null;
    const s = v.trim().toLowerCase();
    if (TRUE.has(s)) return true;
    if (FALSE.has(s)) return false;
    return issue(ctx, "expected yes/no, true/false, or 1/0");
  });
}

/**
 * Dates: YYYY-MM-DD (midnight in PCS_TZ) or YYYY-MM-DD[T ]HH:MM[:SS] (in
 * PCS_TZ unless it carries Z or an offset). Stored as epoch seconds.
 */
function dateCell(ctx0: ParseContext) {
  return cellIn.transform((v, ctx): number | null => {
    if (blank(v)) return null;
    let s = v.trim().replace(" ", "T");
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += "T00:00";
    const t = parseIsoLocal(s);
    if (!t) return issue(ctx, "expected a date like 2030-01-20 or 2030-01-20T14:00");
    return Math.floor(zonedTimeToInstant(t, ctx0.tz).getTime() / 1000);
  });
}

// ---------------------------------------------------------------------------
// Kinds

function col(
  name: string,
  sql: SqlType,
  cell: ColumnSpec["cell"],
  doc: string,
  opts: { required?: boolean; aliases?: readonly string[] } = {},
): ColumnSpec {
  return { name, sql, cell, doc, required: opts.required ?? false, aliases: opts.aliases ?? [] };
}

const PID_ALIASES = ["paper", "paper_id", "paperid", "submission", "submission_id"];

export interface KindSpec {
  kind: ImportKind;
  /** SQL table holding this kind's rows, one set per import_run. */
  table: string;
  summary: string;
  /** Columns that identify a row (unique within one file; the diff key). */
  key: readonly string[];
  columns: readonly ColumnSpec[];
}

export const KINDS: Readonly<Record<ImportKind, KindSpec>> = {
  invites: {
    kind: "invites",
    table: "import_invite",
    summary: "Reserve-reviewer invitation sheet (source of truth for AC approval and invitations)",
    key: ["pid", "candidate_email"],
    columns: [
      col("pid", "integer", () => intCell({ required: true, min: 1 }), "HotCRP paper id", {
        required: true,
        aliases: PID_ALIASES,
      }),
      col("candidate_email", "text", () => emailCell(true), "reserve candidate's HotCRP email", {
        required: true,
        aliases: ["email", "candidate"],
      }),
      col("tpms_score", "real", () => numberCell(), "TPMS affinity score (number)", { aliases: ["score"] }),
      col("seniority_note", "text", () => textCell(), "free text", { aliases: ["seniority"] }),
      col("ac_email", "text", () => emailCell(false), "the paper's AC", { aliases: ["ac"] }),
      col("ac_decision", "text", () => enumCell(["approve", "reject", "pending"], "pending"), "approve | reject | pending (empty = pending)"),
      col("invited_at", "integer", (c) => dateCell(c), "date or date-time, PCS_TZ (empty = not invited)"),
      col("response", "text", () => enumCell(["accept", "decline", "none"], "none"), "accept | decline | none (empty = none)"),
      col("activated_at", "integer", (c) => dateCell(c), "date or date-time, PCS_TZ (empty = not activated)"),
    ],
  },
  "tpms-assignments": {
    kind: "tpms-assignments",
    table: "import_tpms_assignment",
    summary: "TPMS assignment output (one row per proposed paper-reviewer pair)",
    key: ["pid", "email"],
    columns: [
      col("pid", "integer", () => intCell({ required: true, min: 1 }), "HotCRP paper id", {
        required: true,
        aliases: PID_ALIASES,
      }),
      col("email", "text", () => emailCell(true), "reviewer's HotCRP email", {
        required: true,
        aliases: ["reviewer", "reviewer_email"],
      }),
      col("score", "real", () => numberCell(), "TPMS affinity score (number)", { aliases: ["tpms_score", "affinity"] }),
    ],
  },
  "tpms-registrations": {
    kind: "tpms-registrations",
    table: "import_tpms_registration",
    summary: "TPMS reviewer registration status, keyed by HotCRP email",
    key: ["email"],
    columns: [
      col("email", "text", () => emailCell(true), "reviewer's HotCRP email (as registered with TPMS)", {
        required: true,
        aliases: ["reviewer", "reviewer_email"],
      }),
      col("registered", "bool", () => boolCell(true), "yes | no (also true/false, 1/0)", { required: true }),
      col("papers_uploaded", "integer", () => intCell({ required: false, min: 0 }), "number of papers uploaded to TPMS", {
        aliases: ["papers", "num_papers"],
      }),
    ],
  },
  refcheck: {
    kind: "refcheck",
    table: "import_refcheck",
    summary: "External reference-checker output, one row per paper",
    key: ["pid"],
    columns: [
      col("pid", "integer", () => intCell({ required: true, min: 1 }), "HotCRP paper id", {
        required: true,
        aliases: PID_ALIASES,
      }),
      col("total_refs", "integer", () => intCell({ required: false, min: 0 }), "references checked", { aliases: ["refs", "references"] }),
      col("hallucinated_refs", "integer", () => intCell({ required: true, min: 0 }), "references that could not be found", {
        required: true,
        aliases: ["hallucinated", "unresolved_refs"],
      }),
      col("in_field_refs", "integer", () => intCell({ required: true, min: 0 }), "references to in-field venues (0 = flag)", {
        required: true,
        aliases: ["in_field"],
      }),
      col("note", "text", () => textCell(), "free text from the checker", { aliases: ["notes", "comment"] }),
    ],
  },
  "do-not-invite": {
    kind: "do-not-invite",
    table: "import_do_not_invite",
    summary: "Chair-to-chair do-not-invite list (kept only in the encrypted DB)",
    key: ["email"],
    columns: [
      col("email", "text", () => emailCell(true), "the person's email", { required: true }),
      col("reason", "text", () => textCell(), "free text", { aliases: ["note"] }),
      col("source", "text", () => textCell(), "where the entry came from (e.g. a past conference)"),
    ],
  },
};

// Row types (keys = canonical column names).
export interface InviteRow {
  pid: number;
  candidate_email: string;
  tpms_score: number | null;
  seniority_note: string | null;
  ac_email: string | null;
  ac_decision: "approve" | "reject" | "pending";
  /** Epoch seconds. */
  invited_at: number | null;
  response: "accept" | "decline" | "none";
  /** Epoch seconds. */
  activated_at: number | null;
}
export interface TpmsAssignmentRow {
  pid: number;
  email: string;
  score: number | null;
}
export interface TpmsRegistrationRow {
  email: string;
  registered: boolean;
  papers_uploaded: number | null;
}
export interface RefcheckRow {
  pid: number;
  total_refs: number | null;
  hallucinated_refs: number;
  in_field_refs: number;
  note: string | null;
}
export interface DoNotInviteRow {
  email: string;
  reason: string | null;
  source: string | null;
}

export interface ImportRowMap {
  invites: InviteRow;
  "tpms-assignments": TpmsAssignmentRow;
  "tpms-registrations": TpmsRegistrationRow;
  refcheck: RefcheckRow;
  "do-not-invite": DoNotInviteRow;
}
export type ImportRow = ImportRowMap[ImportKind];

/** The Zod schema for one record of `kind` (record keys = canonical column names). */
export function rowSchema<K extends ImportKind>(
  kind: K,
  ctx: ParseContext,
): z.ZodType<ImportRowMap[K], Record<string, string | undefined>> {
  const shape = Object.fromEntries(KINDS[kind].columns.map((c) => [c.name, c.cell(ctx)]));
  return z.object(shape) as unknown as z.ZodType<ImportRowMap[K], Record<string, string | undefined>>;
}

/** Normalize a header cell for matching: "Candidate Email " -> "candidate_email". */
export function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

/** The diff/uniqueness key of a row. */
export function rowKey(kind: ImportKind, row: ImportRow): string {
  const r = row as unknown as Record<string, unknown>;
  return KINDS[kind].key.map((k) => String(r[k])).join("\u0000");
}

/** Human-readable column list for `pcs import --help` and docs. */
export function describeKind(kind: ImportKind): string[] {
  const k = KINDS[kind];
  return [
    `${kind}: ${k.summary}; key ${k.key.join(" + ")}`,
    ...k.columns.map((c) => {
      const aka = c.aliases.length ? ` (also: ${c.aliases.join(", ")})` : "";
      return `    ${c.name}${c.required ? " *" : ""}  ${c.doc}${aka}`;
    }),
  ];
}
