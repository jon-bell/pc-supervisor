// TPMS file exchange (spec §10.3): column-mapped tpms-assignments, the
// tpms-scores / affinity-local matrices and scoresAsOf, flexible
// tpms-registrations, SQL diff counts, the streaming CSV parser, migration 5,
// and the export bundle. Fixtures: seed/fixtures/imports/ (synthetic).
import { readFileSync } from "node:fs";
import Database from "better-sqlite3-multiple-ciphers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixedClock } from "../../src/clock.js";
import { DEFAULT_ASSIGNMENT_POLICY } from "../../src/config.js";
import { parseCsvLines, type CsvLine } from "../../src/hotcrp/csv.js";
import type { PcConflictRow } from "../../src/hotcrp/schemas.js";
import { CsvStreamParser } from "../../src/imports/csv-stream.js";
import { formatProblem, parseImport } from "../../src/imports/parse.js";
import { scoresAsOf } from "../../src/imports/scores.js";
import { diffCounts, diffCountsWithPrevious, diffRuns, importChunks, importCsv, listRuns, runRows } from "../../src/imports/store.js";
import type { ImportKind } from "../../src/imports/kinds.js";
import { buildTpmsBundle, tpmsExport } from "../../src/modules/tpms/index.js";
import { loadReserveInput } from "../../src/modules/reserve/load.js";
import { MEMORY, openDb, type Db } from "../../src/store/db.js";
import { MIGRATIONS, migrate } from "../../src/store/migrations.js";
import type { PersonRow, Store } from "../../src/store/store.js";
import { DEFAULT_RESERVE_POLICY } from "../../src/config.js";

const TZ = "America/New_York";
const fixture = (name: string) => readFileSync(new URL(`../../../seed/fixtures/imports/${name}`, import.meta.url));
const at = (iso: string) => new Date(`${iso}-05:00`);
const est = (iso: string) => Math.floor(Date.parse(`${iso}-05:00`) / 1000);

let db: Db;
beforeEach(() => {
  db = openDb(MEMORY, { key: undefined });
});
afterEach(() => db.close());

function imp(kind: ImportKind, file: string | Buffer, opts: { when?: string; map?: string; header?: boolean } = {}) {
  const bytes = typeof file === "string" ? fixture(file) : file;
  return importCsv(db, kind, bytes, {
    tz: TZ,
    clock: fixedClock(at(opts.when ?? "2030-01-25T09:00")),
    fileName: typeof file === "string" ? file : "inline.csv",
    map: opts.map,
    header: opts.header,
  });
}
const problems = (r: ReturnType<typeof imp>) => (r.ok ? [] : r.problems.map(formatProblem));

const MAP = 'paper=Submission #,email=Assigned Reviewer,score=Match Quality,round=Phase';

describe("tpms-assignments with --map", () => {
  it("reads the mapped columns, overriding header detection (the 'Paper' column is ignored)", () => {
    const r = imp("tpms-assignments", "tpms-assignments.mapped.csv", { map: MAP });
    if (!r.ok) throw new Error(problems(r).join("\n"));
    expect(r.ignoredColumns).toEqual(["Paper"]);
    expect(runRows(db, "tpms-assignments", r.run.id)).toEqual([
      { pid: 1, email: "rosa.quill@example.org", score: 0.91, round: "R1" },
      { pid: 2, email: "ines.marlow@example.org", score: 0.75, round: "R2" },
      { pid: 3, email: "olu.brandt@example.org", score: null, round: null },
    ]);
  });

  it("without --map the aliases apply: the unpublished layout fails on required columns", () => {
    const r = imp("tpms-assignments", "tpms-assignments.mapped.csv");
    expect(problems(r)).toEqual(["line 1, column email: required column missing (or reviewer, reviewer_email)"]);
  });

  it("maps by 1-based position too, and the round is stored", () => {
    const r = imp("tpms-assignments", "tpms-assignments.mapped.csv", { map: "paper=1,email=2,round=4" });
    if (!r.ok) throw new Error(problems(r).join("\n"));
    expect(runRows(db, "tpms-assignments", r.run.id).map((x) => [x.pid, x.score, x.round])).toEqual([
      [1, null, "R1"],
      [2, null, "R2"],
      [3, null, null],
    ]);
  });

  it("mapping errors are reported like row errors, and nothing is imported", () => {
    expect(problems(imp("tpms-assignments", "tpms-assignments.mapped.csv", { map: "paper=Submission #,reviewer_name=X,email" }))).toEqual([
      'file: --map: "reviewer_name" is not a tpms-assignments column (columns: pid, email, score, round)',
      "file, column email: --map: expected column=header, e.g. paper=Paper ID",
    ]);
    expect(problems(imp("tpms-assignments", "tpms-assignments.mapped.csv", { map: "paper=Nope,email=Assigned Reviewer,round=9" }))).toEqual([
      'line 1, column pid: --map: no header cell is named "Nope"',
      "line 1, column round: --map: position 9 is outside the 5 column(s) of the header",
      "line 1, column pid: required column missing (or paper, paper_id, paperid, submission, submission_id)",
    ]);
    expect(problems(imp("tpms-assignments", "tpms-assignments.mapped.csv", { map: "paper=1,email=1" }))).toEqual([
      "line 1, column email: --map: column 1 is already mapped to pid",
      "line 1, column email: required column missing (or reviewer, reviewer_email)",
    ]);
    expect(problems(imp("tpms-assignments", "tpms-assignments.mapped.csv", { map: "pid=1,paper=2" }))).toEqual(["file, column pid: --map: column mapped twice"]);
    expect(listRuns(db)).toEqual([]);
  });

  it("a malformed mapped file: row-level errors under the canonical names, nothing imported", () => {
    const r = imp("tpms-assignments", "tpms-assignments.mapped.malformed.csv", { map: MAP });
    expect(problems(r)).toEqual(["line 3, column pid: not an integer", "line 4, column email: not an email address"]);
    expect(listRuns(db)).toEqual([]);
  });
});

describe("tpms-scores and affinity-local", () => {
  it("rejects scores outside 0-1, non-numbers, blanks, bad pids/emails, and case-folded duplicates", () => {
    const r = imp("tpms-scores", "tpms-scores.malformed.csv");
    expect(problems(r)).toEqual([
      "line 2, column score: must be between 0 and 1",
      "line 3, column score: must be between 0 and 1",
      "line 4, column score: not a number",
      "line 5, column score: required (a number from 0 to 1)",
      "line 6, column pid: not an integer",
      // line 7 repeats line 2's key, but line 2 failed, so it claimed no key
      "line 8, column email: not an email address",
      "line 10, column pid+email: duplicate key (first at line 9)",
    ]);
    expect((db.prepare("select count(*) as n from import_score").get() as { n: number }).n).toBe(0);
    expect(listRuns(db)).toEqual([]);
  });

  it("affinity-local reads header-less openreview-expertise output as-is (sniffed)", () => {
    const r = imp("affinity-local", "affinity-local.csv");
    expect(r.ok && r.headerless).toBe(true);
    expect(problems(imp("affinity-local", "affinity-local.malformed.csv"))).toEqual([
      "line 2, column email: not an email address",
      "line 3, column score: must be between 0 and 1",
      "line 4: 4 fields but the first row has 3",
    ]);
  });

  it("--no-header with positions; a header-only file with --no-header is data, not a header", () => {
    const r = imp("tpms-scores", Buffer.from("x,0.5,ana.ruiz@example.org,7\n"), { header: false, map: "paper=4,email=3,score=2" });
    if (!r.ok) throw new Error(problems(r).join("\n"));
    expect(runRows(db, "tpms-scores", r.run.id)).toEqual([{ pid: 7, email: "ana.ruiz@example.org", score: 0.5 }]);
    expect(problems(imp("tpms-scores", Buffer.from("paper,email,score\n"), { header: false }))).toEqual(["line 1, column pid: not an integer", "line 1, column email: not an email address", "line 1, column score: not a number"]);
    expect(problems(imp("tpms-scores", Buffer.from("1,a@example.org,0.5\n"), { header: false, map: "paper=Paper" }))).toEqual([
      "file, column pid: --map: a file without a header row needs column positions (e.g. paper=1)",
      "file, column pid: required column missing (or paper, paper_id, paperid, submission, submission_id)",
      "file, column email: required column missing (or reviewer, reviewer_email, reviewer_id, user, user_email)",
      "file, column score: required column missing (or affinity, tpms_score, similarity)",
    ]);
  });

  it("the two kinds share a table but version separately", () => {
    const t = imp("tpms-scores", "tpms-scores.csv");
    const l = imp("affinity-local", "affinity-local.csv");
    if (!t.ok || !l.ok) throw new Error("fixture import failed");
    expect(runRows(db, "tpms-scores", t.run.id)).toHaveLength(7);
    expect(runRows(db, "affinity-local", l.run.id)).toHaveLength(4);
    expect(diffCountsWithPrevious(db, l.run)).toEqual({ added: 4, removed: 0, changed: 0, unchanged: 0, previousRunId: null });
  });
});

describe("scoresAsOf", () => {
  it("merges TPMS and local scores (TPMS wins, local fills cold-start pairs) as of an instant", () => {
    expect(scoresAsOf(db, at("2030-02-01T00:00")).pairs).toBe(0);
    imp("tpms-scores", "tpms-scores.csv", { when: "2030-01-25T09:00" });
    imp("affinity-local", "affinity-local.csv", { when: "2030-01-26T09:00" });
    const before = scoresAsOf(db, at("2030-01-25T12:00"));
    expect(before.runs.local).toBeUndefined();
    expect(before.score(1, "kenji.arlo@example.org")).toBeNull();

    const s = scoresAsOf(db, at("2030-02-01T00:00"));
    expect(s.pids).toEqual([1, 2, 3]);
    expect(s.emails).toEqual(["ines.marlow@example.org", "kenji.arlo@example.org", "olu.brandt@example.org", "rosa.quill@example.org", "tomas.vey@example.org"]);
    // 7 TPMS pairs + 3 local-only pairs (1/kenji, 2/olu; 1/tomas and 3/olu are TPMS-scored).
    expect(s.pairs).toBe(9);
    expect([s.score(1, "Tomas.Vey@example.org"), s.source(1, "tomas.vey@example.org")]).toEqual([0.4, "tpms"]);
    expect([s.score(1, "kenji.arlo@example.org"), s.source(1, "kenji.arlo@example.org")]).toEqual([0.52, "local"]);
    expect([s.score(3, "olu.brandt@example.org"), s.source(3, "olu.brandt@example.org")]).toEqual([0.6, "tpms"]);
    expect(s.score(1, "ines.marlow@example.org")).toBe(0);
    expect(s.score(9, "ines.marlow@example.org")).toBeNull();
    expect(s.source(3, "rosa.quill@example.org")).toBeNull();
    expect(s.topK(1, 3)).toEqual([
      { email: "rosa.quill@example.org", score: 0.91, source: "tpms" },
      { email: "kenji.arlo@example.org", score: 0.52, source: "local" },
      { email: "tomas.vey@example.org", score: 0.4, source: "tpms" },
    ]);
    expect(s.topK(1, 2, (e) => e.startsWith("rosa")).map((x) => x.email)).toEqual(["kenji.arlo@example.org", "tomas.vey@example.org"]);
    expect(s.topK(2, 10).map((x) => x.score)).toEqual([1, 0.775, 0.47, 0.25]);
    const row = s.row(2)!;
    expect(row).toHaveLength(5);
    expect(Number.isNaN(row[s.reviewerIndex("tomas.vey@example.org")]!)).toBe(true);
    expect(scoresAsOf(db, at("2030-02-01T00:00"), { sources: ["tpms"] }).pairs).toBe(7);
  });

  it("topK breaks ties by email", () => {
    imp("tpms-scores", Buffer.from("paper,email,score\n1,b@example.org,0.5\n1,a@example.org,0.5\n1,c@example.org,0.7\n"));
    expect(scoresAsOf(db, at("2030-02-01T00:00")).topK(1, 3).map((x) => x.email)).toEqual(["c@example.org", "a@example.org", "b@example.org"]);
  });
});

describe("tpms-registrations: flexible columns and degradation", () => {
  it("email, registered, n_papers, last_updated", () => {
    const r = imp("tpms-registrations", "tpms-registrations.full.csv");
    if (!r.ok) throw new Error(problems(r).join("\n"));
    expect(runRows(db, "tpms-registrations", r.run.id)).toEqual([
      { email: "rosa.quill@example.org", registered: true, papers_uploaded: 9, last_updated: est("2030-01-18T00:00") },
      { email: "tomas.vey@example.org", registered: false, papers_uploaded: 0, last_updated: null },
      { email: "ines.marlow@example.org", registered: true, papers_uploaded: 4, last_updated: est("2030-01-20T10:30") },
    ]);
  });

  it("a plain list of emails (no header) means every listed email is registered", () => {
    const r = imp("tpms-registrations", "tpms-registrations.list.csv");
    if (!r.ok) throw new Error(problems(r).join("\n"));
    expect(r.headerless).toBe(true);
    expect(runRows(db, "tpms-registrations", r.run.id)).toEqual(
      ["rosa.quill", "kenji.arlo", "olu.brandt"].map((n) => ({ email: `${n}@example.org`, registered: true, papers_uploaded: null, last_updated: null })),
    );
  });

  it("a single email column also means registered=yes; a present but blank registered cell is still an error", () => {
    const r = imp("tpms-registrations", "tpms-registrations.email-only.csv");
    expect(r.ok && r.headerless).toBe(false);
    expect(r.ok && runRows(db, "tpms-registrations", r.run.id).every((x) => x.registered)).toBe(true);
    expect(problems(imp("tpms-registrations", "tpms-registrations.malformed.csv"))).toContain("line 3, column registered: required (yes or no)");
  });

  it("a malformed plain list: row-level errors, nothing imported", () => {
    expect(problems(imp("tpms-registrations", "tpms-registrations.list.malformed.csv"))).toEqual([
      "line 2, column email: not an email address",
      "line 3, column email: duplicate key (first at line 1)",
    ]);
    expect(listRuns(db)).toEqual([]);
  });

  it("repeated imports are diffed; the reserve input carries the change (newly / no longer registered)", () => {
    imp("tpms-registrations", "tpms-registrations.csv", { when: "2030-01-20T09:00" });
    const b = imp("tpms-registrations", "tpms-registrations.list.csv", { when: "2030-01-22T09:00" });
    if (!b.ok) throw new Error("import failed");
    // before: rosa yes, tomas no, ines yes, kenji no; after: rosa, kenji, olu (all yes)
    const d = diffCountsWithPrevious(db, b.run);
    expect(d).toMatchObject({ added: 1, removed: 2, changed: 2, unchanged: 0 });
    const full = diffRuns(db, "tpms-registrations", d.previousRunId, b.run.id);
    expect([full.added.length, full.removed.length, full.changed.length, full.unchanged]).toEqual([d.added, d.removed, d.changed, d.unchanged]);
    const store = { db, people: () => [] } as unknown as Store;
    const input = loadReserveInput(store, DEFAULT_RESERVE_POLICY, at("2030-01-23T00:00"));
    expect(input.tpms?.change).toEqual({ previousRunId: d.previousRunId, added: 1, removed: 2, changed: 2, nowRegistered: 2, noLongerRegistered: 1 });
  });
});

describe("diffCounts (SQL) agrees with diffRuns", () => {
  it("for invites v1 -> v2 and scores", () => {
    const a = imp("invites", "invites.csv", { when: "2030-01-25T09:00" });
    const b = imp("invites", "invites.v2.csv", { when: "2030-01-28T09:00" });
    if (!a.ok || !b.ok) throw new Error("import failed");
    const d = diffRuns(db, "invites", a.run.id, b.run.id);
    expect(diffCounts(db, "invites", a.run.id, b.run.id)).toEqual({ added: d.added.length, removed: d.removed.length, changed: d.changed.length, unchanged: d.unchanged });
    const s1 = imp("tpms-scores", "tpms-scores.csv");
    const s2 = imp("tpms-scores", Buffer.from("paper,email,score\n1,rosa.quill@example.org,0.91\n1,tomas.vey@example.org,0.5\n9,new.person@example.org,0.1\n"));
    if (!s1.ok || !s2.ok) throw new Error("import failed");
    expect(diffCounts(db, "tpms-scores", s1.run.id, s2.run.id)).toEqual({ added: 1, removed: 5, changed: 1, unchanged: 1 });
  });
});

describe("streaming CSV parser", () => {
  const sample = '﻿a,b,c\r\n1,"x, ""y""\nz",3\r\n\r\n4,,6\n"7"\r8,9\n';
  it("matches parseCsvLines for any chunking", () => {
    const want = parseCsvLines(sample);
    for (const size of [1, 2, 3, 5, 7, sample.length]) {
      const got: CsvLine[] = [];
      const p = new CsvStreamParser((l) => got.push(l));
      for (let i = 0; i < sample.length; i += size) p.push(sample.slice(i, i + size));
      p.end();
      expect(got).toEqual(want);
    }
  });
  it("reports the same syntax errors", () => {
    for (const bad of ['a\n"x\ny', 'a,b"c\n', '"a"b\n']) {
      let msg = "";
      try {
        parseCsvLines(bad);
      } catch (e) {
        msg = (e as Error).message;
      }
      const p = new CsvStreamParser(() => {});
      expect(() => {
        for (const ch of bad) p.push(ch);
        p.end();
      }).toThrow(msg);
    }
  });
  it("parseImport and importCsv agree on a mapped file", () => {
    const text = fixture("tpms-assignments.mapped.csv").toString("utf8");
    const p = parseImport("tpms-assignments", text, { tz: TZ }, { map: MAP });
    const r = imp("tpms-assignments", "tpms-assignments.mapped.csv", { map: MAP });
    expect(p.ok && r.ok && p.rows.map((x) => x.row)).toEqual(r.ok && runRows(db, "tpms-assignments", r.run.id));
  });
});

describe("migration 5 (TPMS)", () => {
  it("rebuilds import_run (new kinds allowed) keeping runs, rows, and foreign keys", () => {
    const raw = new Database(":memory:");
    raw.pragma("foreign_keys = ON");
    for (const m of MIGRATIONS.slice(0, 4)) raw.exec(m);
    raw.pragma("user_version = 4");
    raw.prepare("insert into import_run values (1, 'tpms-registrations', 'abc', 'r.csv', 100, 1)").run();
    raw.prepare("insert into import_tpms_registration (run_id, line, email, registered, papers_uploaded) values (1, 2, 'a@example.org', 1, 3)").run();
    migrate(raw);
    expect(raw.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(raw.prepare("select * from import_tpms_registration").all()).toEqual([{ run_id: 1, line: 2, email: "a@example.org", registered: 1, papers_uploaded: 3, last_updated: null }]);
    raw.prepare("insert into import_run values (2, 'tpms-scores', 'def', 's.csv', 200, 0)").run();
    expect(() => raw.prepare("insert into import_score values (99, 2, 1, 'a@example.org', 0.5)").run()).toThrow(/FOREIGN KEY/);
    expect(() => raw.prepare("insert into import_run values (3, 'nonsense', 'x', null, 1, 0)").run()).toThrow(/CHECK/);
    expect(raw.pragma("foreign_key_check")).toEqual([]);
    raw.close();
  });
});

describe("large tpms-scores import (2,400 papers x 600 reviewers = 1.44M rows)", () => {
  it("streams and bulk-inserts in one transaction with bounded memory; scoresAsOf stays compact", { timeout: 300_000 }, () => {
    const P = 2400;
    const R = 600;
    const emails = Array.from({ length: R }, (_, i) => `rev${String(i).padStart(3, "0")}@example.org`);
    function* chunks(): Generator<Uint8Array> {
      yield Buffer.from("paper,email,score\n");
      for (let p = 1; p <= P; p++) {
        let s = "";
        for (let r = 0; r < R; r++) s += `${p},${emails[r]},${(((p * 7919 + r * 104729) % 10007) / 10007).toFixed(4)}\n`;
        yield Buffer.from(s);
      }
    }
    global.gc?.();
    const rss0 = process.memoryUsage().rss;
    const t0 = performance.now();
    const r = importChunks(db, "tpms-scores", chunks(), { tz: TZ, clock: fixedClock(at("2030-01-25T09:00")) });
    const importMs = performance.now() - t0;
    if (!r.ok) throw new Error(r.problems.map(formatProblem).join("\n"));
    expect(r.run.rowCount).toBe(P * R);
    const t1 = performance.now();
    const s = scoresAsOf(db, at("2030-02-01T00:00"));
    const loadMs = performance.now() - t1;
    expect(s.pairs).toBe(P * R);
    const top = s.topK(1200, 5);
    expect(top).toHaveLength(5);
    expect(top[0]!.score).toBeGreaterThanOrEqual(top[4]!.score);
    const t2 = performance.now();
    const d = diffCountsWithPrevious(db, r.run);
    const diffMs = performance.now() - t2;
    expect(d.added).toBe(P * R);
    const rssMb = (process.memoryUsage().rss - rss0) / 2 ** 20;
    console.log(`1.44M-row tpms-scores: import ${Math.round(importMs)} ms, scoresAsOf ${Math.round(loadMs)} ms, diff ${Math.round(diffMs)} ms, rss +${Math.round(rssMb)} MB (in-memory DB included)`);
    // Generous CI bounds: the import must not buffer the file or its rows as objects.
    expect(importMs).toBeLessThan(120_000);
    expect(rssMb).toBeLessThan(400);
  });
});

describe("pcs export tpms: the bundle", () => {
  const person = (email: string, tier: string, extra: Partial<PersonRow> = {}): PersonRow => ({
    email,
    name: email.split("@")[0]!.replace(".", " "),
    affiliation: "Example Institute",
    isPc: true,
    roles: ["pc"],
    tags: [],
    tier,
    firstSeenAt: 0,
    removedSeenAt: null,
    ...extra,
  });
  const people = [
    person("chair.one@example.org", "senior", { roles: ["pc", "chair"] }),
    person("ac.hollis@example.org", "senior"),
    person("sofia.lund@example.org", "senior"),
    person("omar.reyes@example.org", "senior", { affiliation: 'Lab "North", Inc' }),
    person("jun.tanaka@example.org", "junior"),
    person("nora.quist@example.org", "reserve-active"),
    person("zed.recip@example.org", "reciprocal"),
    person("gone.away@example.org", "senior", { removedSeenAt: 5 }),
    person("hana.kovac@example.org", "senior", { isPc: false }),
  ];
  const conflicts: PcConflictRow[] = [
    { pid: 2, title: "Mining, Flaky Tests", givenName: "Sofia", familyName: "Lund", email: "sofia.lund@example.org", conflictType: "Advisor/student" },
    { pid: 1, title: "Gradual Pipelines", givenName: "Omar", familyName: "Reyes", email: "omar.reyes@example.org", conflictType: "Author" },
  ];
  const policy = {
    ...DEFAULT_ASSIGNMENT_POLICY,
    load: { ...DEFAULT_ASSIGNMENT_POLICY.load, senior: { min: 1, max: 3 } },
  };
  const bundle = buildTpmsBundle({ people, acs: new Set(["ac.hollis@example.org"]), conflicts, policy });
  const file = (n: string) => bundle.files.find((f) => f.name === n)!.content;

  it("lists the files, with one load group per tier", () => {
    expect(bundle.files.map((f) => f.name)).toEqual([
      "pc.csv",
      "conflicts.csv",
      "load-senior.csv",
      "load-junior.csv",
      "load-reserve-active.csv",
      "load-reciprocal.csv",
      "reviews-per-paper.csv",
      "README.txt",
    ]);
    expect(bundle.counts).toEqual({ pc: 7, assignable: 5, exempt: 2, conflicts: 2, loadGroups: 4 });
  });

  it("pc.csv: current PC only, with tier, role, and load group (chairs/ACs get none)", () => {
    expect(file("pc.csv").split("\n")).toEqual([
      "email,name,affiliation,tier,role,load_group",
      "ac.hollis@example.org,ac hollis,Example Institute,senior,ac,",
      "chair.one@example.org,chair one,Example Institute,senior,chair,",
      "jun.tanaka@example.org,jun tanaka,Example Institute,junior,reviewer,load-junior.csv",
      "nora.quist@example.org,nora quist,Example Institute,reserve-active,reviewer,load-reserve-active.csv",
      'omar.reyes@example.org,omar reyes,"Lab ""North"", Inc",senior,reviewer,load-senior.csv',
      "sofia.lund@example.org,sofia lund,Example Institute,senior,reviewer,load-senior.csv",
      "zed.recip@example.org,zed recip,Example Institute,reciprocal,reviewer,load-reciprocal.csv",
      "",
    ]);
  });

  it("conflicts.csv keeps HotCRP's columns, sorted by paper", () => {
    expect(file("conflicts.csv")).toBe(
      "paper,title,given_name,family_name,email,conflicttype\n" +
        "1,Gradual Pipelines,Omar,Reyes,omar.reyes@example.org,Author\n" +
        '2,"Mining, Flaky Tests",Sofia,Lund,sofia.lund@example.org,Advisor/student\n',
    );
  });

  it("load groups carry the PCS_LOAD_* band; a tier without a band gets blank bounds", () => {
    expect(file("load-senior.csv")).toBe("email,min_papers,max_papers\nomar.reyes@example.org,1,3\nsofia.lund@example.org,1,3\n");
    expect(file("load-junior.csv")).toBe("email,min_papers,max_papers\njun.tanaka@example.org,2,8\n");
    expect(file("load-reciprocal.csv")).toBe("email,min_papers,max_papers\nzed.recip@example.org,,\n");
  });

  it("reviews-per-paper.csv: min senior + the third slot", () => {
    expect(file("reviews-per-paper.csv")).toBe(
      "reviews_per_paper,senior_min,third_slot_min,third_slot_max,third_slot_tiers\n3,2,1,1,junior;reserve-active;reciprocal\n",
    );
    const atleast = buildTpmsBundle({ people, acs: new Set(), conflicts: [], policy: { ...policy, minSenior: 3, thirdSlot: "atleast1" } });
    expect(atleast.files.find((f) => f.name === "reviews-per-paper.csv")!.content.split("\n")[1]).toBe("4,3,1,,junior;reserve-active;reciprocal");
  });

  it("README warns about emails, explains the PDFs; nothing in the bundle is review text", () => {
    const readme = file("README.txt");
    expect(readme).toContain("contain reviewer emails");
    expect(readme).toContain("Download > Documents: Submissions");
    expect(readme).toContain("They contain no reviews or comments");
  });

  it("tpmsExport reads people and ACs from the store and conflicts from HotCRP (submitted papers)", async () => {
    const calls: unknown[] = [];
    const store = {
      people: () => people,
      areaChairs: () => [{ pid: 1, email: "ac.hollis@example.org" }],
    } as unknown as Store;
    const b = await tpmsExport(store, { acRole: { kind: "meta" }, assignment: policy }, {
      pcConflicts: async (o) => {
        calls.push(o);
        return conflicts;
      },
    });
    expect(calls).toEqual([{ q: "all", t: "s" }]);
    expect(b).toEqual(bundle);
  });
});
