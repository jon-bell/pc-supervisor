// `pcs import` kinds, atomicity, and versioning (PLAN M9). Fixtures are the
// synthetic CSVs in seed/fixtures/imports/.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixedClock } from "../../src/clock.js";
import { IMPORT_KINDS, KINDS, describeKind, type ImportKind, type ImportRowMap } from "../../src/imports/kinds.js";
import { formatProblem, parseImport } from "../../src/imports/parse.js";
import {
  diffRuns,
  diffWithPrevious,
  importCsv,
  latestRun,
  listRuns,
  previousRun,
  rowsAsOf,
  runAsOf,
  runRows,
} from "../../src/imports/store.js";
import { MEMORY, openDb, type Db } from "../../src/store/db.js";

const TZ = "America/New_York";
const fixture = (name: string) => readFileSync(new URL(`../../../seed/fixtures/imports/${name}`, import.meta.url));
/** Epoch seconds of a wall-clock time in New York in January/February (EST, -05:00). */
const est = (iso: string) => Math.floor(Date.parse(`${iso}-05:00`) / 1000);
const at = (iso: string) => new Date(`${iso}-05:00`);

let db: Db;
beforeEach(() => {
  db = openDb(MEMORY, { key: undefined });
});
afterEach(() => db.close());

function imp<K extends ImportKind>(kind: K, file: string | Buffer, when = "2030-01-25T09:00") {
  const bytes = typeof file === "string" ? fixture(file) : file;
  return importCsv(db, kind, bytes, { tz: TZ, clock: fixedClock(at(when)), fileName: typeof file === "string" ? file : "inline.csv" });
}

function rowCount(kind: ImportKind): number {
  return (db.prepare(`select count(*) as n from ${KINDS[kind].table}`).get() as { n: number }).n;
}

const EXPECTED: { [K in ImportKind]: ImportRowMap[K][] } = {
  invites: [
    {
      pid: 1,
      candidate_email: "rosa.quill@example.org",
      tpms_score: 0.82,
      seniority_note: "PhD 2019, 9 papers at venue list",
      ac_email: "ac.amber@example.org",
      ac_decision: "approve",
      invited_at: est("2030-01-20T00:00"),
      response: "accept",
      activated_at: est("2030-01-22T09:30"),
    },
    {
      pid: 1,
      candidate_email: "tomas.vey@example.org",
      tpms_score: 0.77,
      seniority_note: "student",
      ac_email: "ac.amber@example.org",
      ac_decision: "reject",
      invited_at: null,
      response: "none",
      activated_at: null,
    },
    {
      pid: 2,
      candidate_email: "ines.marlow@example.org",
      tpms_score: 0.64,
      seniority_note: null,
      ac_email: "ac.birch@example.org",
      ac_decision: "pending",
      invited_at: null,
      response: "none",
      activated_at: null,
    },
    {
      pid: 3,
      candidate_email: "rosa.quill@example.org",
      tpms_score: null,
      seniority_note: "assistant prof, 2027",
      ac_email: "ac.birch@example.org",
      ac_decision: "pending",
      invited_at: est("2030-01-21T14:00"),
      response: "none",
      activated_at: null,
    },
    {
      pid: 4,
      candidate_email: "kenji.arlo@example.org",
      tpms_score: 0.9,
      seniority_note: "senior",
      ac_email: "ac.cedar@example.org",
      ac_decision: "approve",
      invited_at: est("2030-01-20T08:00"),
      response: "decline",
      activated_at: null,
    },
  ],
  "tpms-assignments": [
    { pid: 1, email: "rosa.quill@example.org", score: 0.91 },
    { pid: 1, email: "tomas.vey@example.org", score: 0.88 },
    { pid: 2, email: "ines.marlow@example.org", score: 0.75 },
    { pid: 2, email: "kenji.arlo@example.org", score: null },
    { pid: 3, email: "olu.brandt@example.org", score: 0.69 },
  ],
  "tpms-registrations": [
    { email: "rosa.quill@example.org", registered: true, papers_uploaded: 9 },
    { email: "tomas.vey@example.org", registered: false, papers_uploaded: 0 },
    { email: "ines.marlow@example.org", registered: true, papers_uploaded: null },
    { email: "kenji.arlo@example.org", registered: false, papers_uploaded: 3 },
  ],
  refcheck: [
    { pid: 1, total_refs: 42, hallucinated_refs: 0, in_field_refs: 17, note: null },
    { pid: 2, total_refs: 30, hallucinated_refs: 3, in_field_refs: 12, note: "3 references not found: titles do not resolve" },
    { pid: 3, total_refs: 25, hallucinated_refs: 0, in_field_refs: 0, note: "no references to in-field venues" },
    { pid: 4, total_refs: null, hallucinated_refs: 1, in_field_refs: 5, note: null },
  ],
  "do-not-invite": [
    { email: "mallory.stone@example.org", reason: "no-show on 4 of 4 reviews", source: "ConfX 2029" },
    { email: "victor.ash@example.org", reason: "abusive review language", source: "ConfY 2028" },
    { email: "peggy.lark@example.org", reason: null, source: null },
  ],
};

describe("every kind round-trips from its fixture CSV", () => {
  for (const kind of IMPORT_KINDS) {
    it(kind, () => {
      const r = imp(kind, `${kind}.csv`);
      if (!r.ok) throw new Error(r.problems.map(formatProblem).join("\n"));
      expect(r.run).toMatchObject({ kind, rowCount: EXPECTED[kind].length, fileName: `${kind}.csv` });
      expect(r.run.importedAt).toBe(est("2030-01-25T09:00"));
      expect(r.run.fileSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(runRows(db, kind, r.run.id)).toEqual(EXPECTED[kind]);
      expect(rowsAsOf(db, kind, at("2030-01-26T00:00")).rows).toEqual(EXPECTED[kind]);
    });
  }

  it("tolerates column order, header case/spacing, aliases, and extra columns", () => {
    const r = imp("invites", "invites.csv");
    expect(r.ok && r.ignoredColumns).toEqual(["Sheet Row Color"]);
    const t = imp("tpms-assignments", "tpms-assignments.csv");
    expect(t.ok && t.ignoredColumns).toEqual(["Round"]);
  });

  it("lowercases every email", () => {
    for (const kind of IMPORT_KINDS) imp(kind, `${kind}.csv`);
    const emails = [
      ...(db.prepare("select candidate_email as e from import_invite union all select ac_email from import_invite").all() as { e: string | null }[]),
      ...(db.prepare("select email as e from import_tpms_assignment union all select email from import_tpms_registration").all() as { e: string }[]),
      ...(db.prepare("select email as e from import_do_not_invite").all() as { e: string }[]),
    ].map((r) => r.e).filter((e): e is string => e !== null);
    expect(emails.length).toBeGreaterThan(15);
    for (const e of emails) expect(e).toBe(e.toLowerCase());
  });

  it("accepts a header-only file as an empty version", () => {
    const r = imp("do-not-invite", Buffer.from("email,reason\n"));
    expect(r.ok && r.run.rowCount).toBe(0);
  });
});

describe("malformed CSVs: row-level errors, nothing imported", () => {
  it("invites: one problem per bad cell or row, with line and column", () => {
    const r = imp("invites", "invites.malformed.csv");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems.map(formatProblem)).toEqual([
      "line 3, column pid: not an integer",
      "line 4, column candidate_email: not an email address",
      "line 4, column tpms_score: not a number",
      "line 4, column ac_decision: expected one of approve, reject, pending",
      "line 5, column invited_at: expected a date like 2030-01-20 or 2030-01-20T14:00",
      "line 6, column pid+candidate_email: duplicate key (first at line 2)",
      "line 7: 6 fields but the header has 5",
      "line 8, column pid: required (an integer)",
    ]);
  });

  it("never echoes cell values in the report", () => {
    const r = imp("invites", "invites.malformed.csv");
    const text = r.ok ? "" : r.problems.map(formatProblem).join("\n");
    for (const v of ["zero", "not-an-email", "maybe", "high", "20/01/2030", "ROSA", "extra", "olu.brandt"]) {
      expect(text).not.toContain(v);
    }
  });

  const cases: [ImportKind, string, string[]][] = [
    ["invites", "invites.bad-quote.csv", ["line 2: unterminated quoted field"]],
    [
      "tpms-assignments",
      "tpms-assignments.malformed.csv",
      ["line 1, column email: required column missing (or reviewer, reviewer_email)"],
    ],
    [
      "tpms-registrations",
      "tpms-registrations.malformed.csv",
      [
        "line 2, column registered: expected yes/no, true/false, or 1/0",
        "line 3, column registered: required (yes or no)",
        "line 4, column papers_uploaded: must be at least 0",
      ],
    ],
    [
      "refcheck",
      "refcheck.malformed.csv",
      [
        "line 3, column hallucinated_refs: required (an integer)",
        "line 4, column hallucinated_refs: not an integer",
        "line 5, column pid: duplicate key (first at line 2)",
      ],
    ],
    [
      "do-not-invite",
      "do-not-invite.malformed.csv",
      ["line 3, column email: not an email address", "line 4, column email: duplicate key (first at line 2)"],
    ],
  ];
  for (const [kind, file, expected] of cases) {
    it(`${file}: ${expected.length} problem(s), zero rows, no run`, () => {
      const r = imp(kind, file);
      expect(r.ok ? [] : r.problems.map(formatProblem)).toEqual(expected);
      expect(rowCount(kind)).toBe(0);
      expect(listRuns(db)).toEqual([]);
    });
  }

  it("a row that fails validation doesn't claim its key (no duplicate noise)", () => {
    const r = parseImport("refcheck", "pid,hallucinated_refs,in_field_refs\n2,x,1\n2,0,1\n", { tz: TZ });
    expect(r.ok).toBe(false);
    expect(r.ok ? [] : r.problems.map(formatProblem)).toEqual(["line 2, column hallucinated_refs: not an integer"]);
  });

  it("file-level problems: empty file, duplicate column, non-UTF-8", () => {
    const p = (kind: ImportKind, b: Buffer) => {
      const r = imp(kind, b);
      return r.ok ? [] : r.problems.map(formatProblem);
    };
    expect(p("refcheck", Buffer.from(""))).toEqual(["file: empty file (no header row)"]);
    expect(p("do-not-invite", Buffer.from("Email,email\nx@example.org,y@example.org\n"))).toEqual([
      "line 1, column email: column given twice (header cells 1 and 2)",
    ]);
    expect(p("do-not-invite", Buffer.from([0x65, 0x6d, 0x61, 0x69, 0x6c, 0x0a, 0xff, 0xfe, 0x0a]))).toEqual([
      "file: not UTF-8 text (export the sheet as CSV UTF-8)",
    ]);
    expect(listRuns(db)).toEqual([]);
  });

  it("a failure mid-write rolls back the run and every row", () => {
    // Force the second row insert to fail inside the transaction.
    db.exec(`create trigger boom before insert on import_do_not_invite when new.line = 3
             begin select raise(abort, 'boom'); end;`);
    expect(() => imp("do-not-invite", "do-not-invite.csv")).toThrow(/boom/);
    expect(rowCount("do-not-invite")).toBe(0);
    expect(listRuns(db)).toEqual([]);
  });
});

describe("versioning", () => {
  it("re-importing creates a new version; as-of queries pick the one in force", () => {
    const v1 = imp("invites", "invites.csv", "2030-01-25T09:00");
    const again = imp("invites", "invites.csv", "2030-01-26T09:00");
    const v2 = imp("invites", "invites.v2.csv", "2030-01-28T09:00");
    if (!v1.ok || !again.ok || !v2.ok) throw new Error("fixture import failed");
    expect(v1.sameAsRunId).toBeNull();
    expect(again.sameAsRunId).toBe(v1.run.id);
    expect(again.run.id).not.toBe(v1.run.id);
    expect(v2.sameAsRunId).toBeNull();
    expect(listRuns(db, "invites").map((r) => r.id)).toEqual([v1.run.id, again.run.id, v2.run.id]);

    expect(runAsOf(db, "invites", at("2030-01-25T08:59"))).toBeUndefined();
    expect(rowsAsOf(db, "invites", at("2030-01-25T08:59")).rows).toEqual([]);
    expect(runAsOf(db, "invites", at("2030-01-25T09:00"))?.id).toBe(v1.run.id); // inclusive
    expect(runAsOf(db, "invites", at("2030-01-27T12:00"))?.id).toBe(again.run.id);
    expect(runAsOf(db, "invites", at("2030-02-15T00:00"))?.id).toBe(v2.run.id);
    expect(latestRun(db, "invites")?.id).toBe(v2.run.id);
    expect(runAsOf(db, "refcheck", at("2030-02-15T00:00"))).toBeUndefined();

    // "What did the sheet say about paper 2 on Jan 27 vs. Feb 15?"
    const p2 = (iso: string) => rowsAsOf(db, "invites", at(iso)).rows.find((r) => r.pid === 2)?.ac_decision;
    expect(p2("2030-01-27T12:00")).toBe("pending");
    expect(p2("2030-02-15T00:00")).toBe("approve");
  });

  it("diffs consecutive runs by key", () => {
    imp("invites", "invites.csv", "2030-01-25T09:00");
    const again = imp("invites", "invites.csv", "2030-01-26T09:00");
    const v2 = imp("invites", "invites.v2.csv", "2030-01-28T09:00");
    if (!again.ok || !v2.ok) throw new Error("fixture import failed");

    const same = diffWithPrevious(db, again.run);
    expect([same.added, same.removed, same.changed, same.unchanged]).toEqual([[], [], [], 5]);

    const d = diffWithPrevious(db, v2.run);
    expect(previousRun(db, v2.run)?.id).toBe(again.run.id);
    expect(d.added.map((r) => [r.pid, r.candidate_email])).toEqual([[5, "olu.brandt@example.org"]]);
    expect(d.removed.map((r) => [r.pid, r.candidate_email])).toEqual([[3, "rosa.quill@example.org"]]);
    expect(d.changed.map((c) => [c.after.pid, c.before.ac_decision, c.after.ac_decision, c.after.invited_at])).toEqual([
      [2, "pending", "approve", est("2030-01-24T00:00")],
    ]);
    expect(d.unchanged).toBe(3);

    const first = diffRuns(db, "invites", null, v2.run.id);
    expect(first.added).toHaveLength(5);
  });

  it("orders same-instant imports (pinned PCS_NOW) by run id", () => {
    const a = imp("do-not-invite", "do-not-invite.csv", "2030-01-25T09:00");
    const b = imp("do-not-invite", Buffer.from("email\npeggy.lark@example.org\n"), "2030-01-25T09:00");
    if (!a.ok || !b.ok) throw new Error("import failed");
    expect(runAsOf(db, "do-not-invite", at("2030-01-25T09:00"))?.id).toBe(b.run.id);
    expect(previousRun(db, b.run)?.id).toBe(a.run.id);
    expect(diffWithPrevious(db, b.run).removed).toHaveLength(2);
  });
});

describe("describeKind", () => {
  it("documents every column, marking required ones", () => {
    const lines = describeKind("invites");
    expect(lines[0]).toMatch(/^invites: .*; key pid \+ candidate_email$/);
    expect(lines.some((l) => /^ {4}pid \* /.test(l))).toBe(true);
    expect(lines).toHaveLength(1 + KINDS.invites.columns.length);
  });
});
