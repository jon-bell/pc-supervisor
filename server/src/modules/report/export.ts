// Pseudonymous export (spec §10.4 G, PLAN M13): per-review and per-reviewer
// CSVs for a future cross-conference baseline.
//
// No emails, names, titles, or text can reach a file, by construction:
// - every column has a declared kind, and there is no free-text kind: a cell
//   is a pseudonym (hex, checked against its pattern), a number, a boolean
//   (0/1), or one of a fixed set of tokens (an enum);
// - the writer (toCsv) validates every cell against its column and throws on
//   anything else, so a coding mistake fails the export instead of leaking;
// - the tier enum holds only tier names that look like tag tokens
//   ([a-z0-9_-]); tiers with fewer than PCS_REPORT_MIN_CELL reviewers are
//   written as "other", so a pseudonym in a tiny tier can't be singled out.
//
// Times are days relative to REVIEW_DUE (1 decimal), never timestamps.

import { NEGATIVE_FLAGS, ratingTotal } from "../../ratings.js";
import type { ReviewFact } from "./compute.js";
import { PAPER_ID_RE, PSEUDONYM_RE, type Pseudonymizer } from "./pseudonym.js";

// 2: rating columns are flag counts (review ratings are a multiset, spec §1).
export const EXPORT_FORMAT = "pcs-baseline-2";
export const OTHER_TIER = "other";
const TOKEN_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export type ColumnKind =
  | { kind: "pseudonym" }
  | { kind: "paper" }
  | { kind: "int" }
  | { kind: "dec"; digits: number }
  | { kind: "bool" }
  | { kind: "enum"; values: readonly string[] };

export interface Column {
  name: string;
  type: ColumnKind;
  /** What the column means (the export's README). */
  doc: string;
}

export type CellValue = string | number | boolean | null;

export class ExportCellError extends Error {
  constructor(file: string, row: number, column: string, why: string) {
    // Never echo the value: it is the thing that must not leak.
    super(`export ${file}: row ${row}, column ${column}: ${why} (value not shown)`);
    this.name = "ExportCellError";
  }
}

/** One validated cell as CSV text. Only hex, digits, '-', '.', and enum tokens can come out. */
export function formatCell(c: Column, v: CellValue, where: { file: string; row: number }): string {
  const bad = (why: string) => new ExportCellError(where.file, where.row, c.name, why);
  if (v === null) return "";
  const t = c.type;
  switch (t.kind) {
    case "pseudonym":
      if (typeof v !== "string" || !PSEUDONYM_RE.test(v)) throw bad("not a 64-hex pseudonym");
      return v;
    case "paper":
      if (typeof v !== "string" || !PAPER_ID_RE.test(v)) throw bad("not a 16-hex paper id");
      return v;
    case "int":
      if (typeof v !== "number" || !Number.isInteger(v)) throw bad("not an integer");
      return String(v);
    case "dec":
      if (typeof v !== "number" || !Number.isFinite(v)) throw bad("not a finite number");
      return String(Math.round(v * 10 ** t.digits) / 10 ** t.digits);
    case "bool":
      if (typeof v !== "boolean") throw bad("not a boolean");
      return v ? "1" : "0";
    case "enum":
      if (typeof v !== "string" || !t.values.includes(v)) throw bad("not one of the column's tokens");
      return v;
  }
}

export function toCsv(file: string, columns: readonly Column[], rows: readonly (readonly CellValue[])[]): string {
  const lines = [columns.map((c) => c.name).join(",")];
  rows.forEach((r, i) => {
    if (r.length !== columns.length) throw new ExportCellError(file, i + 1, "*", `expected ${columns.length} cells, got ${r.length}`);
    lines.push(r.map((v, j) => formatCell(columns[j]!, v, { file, row: i + 1 })).join(","));
  });
  return `${lines.join("\n")}\n`;
}

const ROLE: Readonly<Record<number, string>> = { 1: "external", 2: "pc", 3: "secondary", 4: "primary" };
const ROLES = ["external", "pc", "secondary", "primary", "other"] as const;
const SIDES = ["accept", "reject", "undecided"] as const;

/**
 * The tiers the export may name: each tier with at least minCell reviewers
 * whose name is a plain token; everything else is written as "other".
 */
export function exportTiers(facts: readonly ReviewFact[], minCell: number): (tier: string) => string {
  const people = new Map<string, Set<string>>();
  for (const f of facts) {
    let s = people.get(f.tier);
    if (!s) people.set(f.tier, (s = new Set()));
    s.add(f.email);
  }
  const keep = new Set([...people].filter(([t, s]) => s.size >= minCell && TOKEN_RE.test(t) && t !== OTHER_TIER).map(([t]) => t));
  return (tier) => (keep.has(tier) ? tier : OTHER_TIER);
}

export interface ExportInput {
  facts: readonly ReviewFact[];
  /** Per reviewer: published non-response comments on papers they review, and those papers. */
  comments: ReadonlyMap<string, { comments: number; papers: number }>;
  /** pids that were early-reject candidates (M12). */
  earlyRejectPids: ReadonlySet<number>;
  minCell: number;
  /** Instant of the export (manifest), as a UTC date "YYYY-MM-DD". */
  generatedOn: string;
}

export interface ExportFiles {
  "reviews.csv": string;
  "reviewers.csv": string;
  "manifest.csv": string;
  "README.txt": string;
}

export const EXPORT_FILE_NAMES: readonly (keyof ExportFiles)[] = ["reviews.csv", "reviewers.csv", "manifest.csv", "README.txt"];

function reviewColumns(tiers: readonly string[]): Column[] {
  return [
    { name: "reviewer", type: { kind: "pseudonym" }, doc: "HMAC-SHA256(PCS_PSEUDONYM_KEY, normalized reviewer email), hex" },
    { name: "paper", type: { kind: "paper" }, doc: "HMAC of the paper number, 16 hex; unique within this export only" },
    { name: "tier", type: { kind: "enum", values: tiers }, doc: `reviewer tier; tiers with fewer than PCS_REPORT_MIN_CELL reviewers are "${OTHER_TIER}"` },
    { name: "role", type: { kind: "enum", values: ROLES }, doc: "HotCRP review type: primary, secondary, pc, external" },
    { name: "submitted", type: { kind: "bool" }, doc: "1 if delivered/approved/complete" },
    { name: "merit", type: { kind: "int" }, doc: "overall merit (PCS_FIELD_MERIT); empty if not submitted" },
    { name: "expertise", type: { kind: "int" }, doc: "reviewer expertise (PCS_FIELD_EXPERTISE)" },
    { name: "words", type: { kind: "int" }, doc: "words across the review's text fields" },
    { name: "rated_short", type: { kind: "int" }, doc: "raters who flagged it short (HotCRP review ratings)" },
    { name: "rated_vague", type: { kind: "int" }, doc: "raters who flagged it vague" },
    { name: "ratings", type: { kind: "int" }, doc: "rating flags on the review, all flags (each rater's flag counts once)" },
    { name: "flags_negative", type: { kind: "int" }, doc: "rating flags other than good" },
    { name: "days_vs_due", type: { kind: "dec", digits: 1 }, doc: "first submission minus REVIEW_DUE, days; negative = early" },
    { name: "submitted_late", type: { kind: "bool" }, doc: "first submitted after REVIEW_DUE (replacements excluded)" },
    { name: "assigned_after_due", type: { kind: "bool" }, doc: "first seen after REVIEW_DUE (a replacement)" },
    { name: "paper_mean_merit", type: { kind: "dec", digits: 2 }, doc: "mean of the paper's submitted reviewer merits (2+)" },
    { name: "abs_dev", type: { kind: "dec", digits: 2 }, doc: "|merit - paper_mean_merit|" },
    { name: "decision_side", type: { kind: "enum", values: SIDES }, doc: "accept / reject (PCS_REPORT_ACCEPT_DECISIONS) / undecided" },
    { name: "on_decision_side", type: { kind: "bool" }, doc: "merit on the decision's side (PCS_MERIT_ACCEPT_MIN)" },
    { name: "early_reject_candidate", type: { kind: "bool" }, doc: "the paper was an early-reject candidate" },
  ];
}

function reviewerColumns(tiers: readonly string[]): Column[] {
  return [
    { name: "reviewer", type: { kind: "pseudonym" }, doc: "as in reviews.csv" },
    { name: "tier", type: { kind: "enum", values: tiers }, doc: "as in reviews.csv" },
    { name: "assigned", type: { kind: "int" }, doc: "reviewer reviews assigned" },
    { name: "submitted", type: { kind: "int" }, doc: "of them submitted" },
    { name: "submitted_late", type: { kind: "int" }, doc: "submitted after REVIEW_DUE" },
    { name: "not_submitted", type: { kind: "int" }, doc: "never submitted" },
    { name: "median_words", type: { kind: "dec", digits: 1 }, doc: "median words over submitted reviews" },
    { name: "mean_abs_dev", type: { kind: "dec", digits: 2 }, doc: "mean abs_dev over their merits" },
    { name: "on_side_share", type: { kind: "dec", digits: 3 }, doc: "share of their merits on decided papers on the decision's side" },
    { name: "rated_short", type: { kind: "int" }, doc: "reviews flagged short by at least one rater" },
    { name: "rated_vague", type: { kind: "int" }, doc: "reviews flagged vague by at least one rater" },
    { name: "flags_negative", type: { kind: "int" }, doc: "rating flags other than good, over their reviews" },
    { name: "flags_good", type: { kind: "int" }, doc: "good flags, over their reviews" },
    { name: "comments", type: { kind: "int" }, doc: "published non-response comments on papers they review" },
    { name: "papers_commented", type: { kind: "int" }, doc: "papers they review with at least one such comment" },
  ];
}

const MANIFEST_COLUMNS: Column[] = [
  { name: "format", type: { kind: "enum", values: [EXPORT_FORMAT] }, doc: "export format version" },
  { name: "generated_on", type: { kind: "enum", values: [] }, doc: "UTC date of the export (PCS_NOW applies)" },
  { name: "key_id", type: { kind: "enum", values: [] }, doc: "public fingerprint of PCS_PSEUDONYM_KEY: equal ids = joinable pseudonyms" },
  { name: "min_cell", type: { kind: "int" }, doc: "PCS_REPORT_MIN_CELL" },
  { name: "reviews", type: { kind: "int" }, doc: "rows in reviews.csv" },
  { name: "reviewers", type: { kind: "int" }, doc: "rows in reviewers.csv" },
];

const medianOf = (xs: number[]) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Build every export file. Throws PseudonymKeyMissingError (via the pseudonymizer) or ExportCellError. */
export function buildExport(input: ExportInput, ps: Pseudonymizer): ExportFiles {
  const tierOf = exportTiers(input.facts, input.minCell);
  const tierValues = [...new Set([...input.facts.map((f) => tierOf(f.tier)), OTHER_TIER])].sort();

  const reviewRows = input.facts.map((f): CellValue[] => [
      ps.person(f.email),
      ps.paper(f.pid),
      tierOf(f.tier),
      ROLE[f.rtype] ?? "other",
      f.submitted,
      f.merit,
      f.expertise,
      f.submitted ? f.words : null,
      f.ratings.short ?? 0,
      f.ratings.vague ?? 0,
      ratingTotal(f.ratings),
      ratingTotal(f.ratings, NEGATIVE_FLAGS),
      f.daysVsDue,
      f.submitted ? f.late : null,
      f.assignedAfterDue,
      f.paperMean,
      f.absDev,
      f.side ?? "undecided",
      f.onSide,
      input.earlyRejectPids.has(f.pid),
  ]);
  // Ordered by pseudonyms, not by pid or email, so row order reveals nothing.
  reviewRows.sort((a, b) => String(a[1]).localeCompare(String(b[1])) || String(a[0]).localeCompare(String(b[0])));

  const byPerson = new Map<string, ReviewFact[]>();
  for (const f of input.facts) {
    let l = byPerson.get(f.email);
    if (!l) byPerson.set(f.email, (l = []));
    l.push(f);
  }
  const reviewerRows = [...byPerson]
    .map(([email, fs]): CellValue[] => {
      const sub = fs.filter((f) => f.submitted);
      const devs = fs.filter((f) => f.absDev !== null).map((f) => f.absDev!);
      const decided = fs.filter((f) => f.onSide !== null);
      const c = input.comments.get(email) ?? { comments: 0, papers: 0 };
      return [
        ps.person(email),
        tierOf(fs[0]!.tier),
        fs.length,
        sub.length,
        sub.filter((f) => f.late).length,
        fs.length - sub.length,
        medianOf(sub.map((f) => f.words)),
        devs.length ? devs.reduce((a, b) => a + b, 0) / devs.length : null,
        decided.length ? decided.filter((f) => f.onSide).length / decided.length : null,
        fs.filter((f) => (f.ratings.short ?? 0) > 0).length,
        fs.filter((f) => (f.ratings.vague ?? 0) > 0).length,
        fs.reduce((n, f) => n + ratingTotal(f.ratings, NEGATIVE_FLAGS), 0),
        fs.reduce((n, f) => n + (f.ratings.good ?? 0), 0),
        c.comments,
        c.papers,
      ];
    })
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));

  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.generatedOn)) throw new ExportCellError("manifest.csv", 1, "generated_on", "not a date");
  if (!/^[0-9a-f]{12}$/.test(ps.keyId)) throw new ExportCellError("manifest.csv", 1, "key_id", "not a key id");
  const manifestCols = MANIFEST_COLUMNS.map((c) =>
    c.name === "generated_on" ? { ...c, type: { kind: "enum" as const, values: [input.generatedOn] } } : c.name === "key_id" ? { ...c, type: { kind: "enum" as const, values: [ps.keyId] } } : c,
  );
  const rc = reviewColumns(tierValues);
  const pc = reviewerColumns(tierValues);
  return {
    "reviews.csv": toCsv("reviews.csv", rc, reviewRows),
    "reviewers.csv": toCsv("reviewers.csv", pc, reviewerRows),
    "manifest.csv": toCsv("manifest.csv", manifestCols, [[EXPORT_FORMAT, input.generatedOn, ps.keyId, input.minCell, reviewRows.length, reviewerRows.length]]),
    "README.txt": readme([
      ["reviews.csv", rc],
      ["reviewers.csv", pc],
      ["manifest.csv", manifestCols],
    ]),
  };
}

/** Static documentation: column names and their docs only (no data). */
function readme(files: [string, Column[]][]): string {
  const lines = [
    `PC Supervisor pseudonymous export (${EXPORT_FORMAT})`,
    "",
    "No emails, names, titles, or review/comment text. Every person is an HMAC-SHA256 pseudonym of their",
    "normalized email (trimmed, lowercased, NFC) keyed with the chair's PCS_PSEUDONYM_KEY; the same key",
    "gives the same pseudonyms in a later conference's export (compare key_id in manifest.csv).",
    "Only reviewer reviews are included (not metareviews, not reviews held by the paper's area chairs).",
    "",
  ];
  for (const [name, cols] of files) {
    lines.push(`${name}:`);
    for (const c of cols) lines.push(`  ${c.name}: ${c.doc}`);
    lines.push("");
  }
  return lines.join("\n");
}
