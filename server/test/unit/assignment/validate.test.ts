// Unit tests of the assignment validator's checks (spec §10.4 C) on small,
// hand-built inputs. Synthetic people at example.org.

import { describe, expect, it } from "vitest";
import { DEFAULT_ASSIGNMENT_POLICY, type AssignmentPolicy } from "../../../src/config.js";
import { staticCoauthorship } from "../../../src/modules/assignment/dblp.js";
import type { CurrentAssignment, Finding, PaperInfo, PersonInfo, ProposedRow, ValidatorInput } from "../../../src/modules/assignment/types.js";
import { normalizeAffiliation, validate } from "../../../src/modules/assignment/validate.js";

const POLICY: AssignmentPolicy = {
  ...DEFAULT_ASSIGNMENT_POLICY,
  load: {
    senior: { min: 1, max: 2 },
    junior: { min: 1, max: 2 },
    "reserve-active": { min: 1, max: 1 },
    "reserve-pool": { min: 0, max: 0 },
  },
};

const e = (k: string) => `${k}@example.org`;

function person(k: string, tier = "senior", o: Partial<PersonInfo> = {}): PersonInfo {
  return { email: e(k), affiliation: `${k} University`, isPc: true, tier, exempt: false, ...o };
}

/** A clean world: 2 papers, 2 seniors + 1 junior each, no problems. */
function world(): {
  people: Map<string, PersonInfo>;
  papers: Map<number, PaperInfo>;
  rows: ProposedRow[];
} {
  const people = new Map(
    [person("s1"), person("s2"), person("s3"), person("s4"), person("j1", "junior"), person("j2", "junior"), person("ac", "senior", { exempt: true })].map((p) => [p.email, p]),
  );
  const papers = new Map([
    [1, { pid: 1, authors: [{ email: e("x1"), affiliation: "X Labs" }] }],
    [2, { pid: 2, authors: [{ email: e("x2"), affiliation: "Y Labs" }, { email: null, affiliation: "Z Labs" }] }],
  ]);
  const rows = [
    { pid: 1, email: e("s1"), score: 0.9 },
    { pid: 1, email: e("s2"), score: 0.8 },
    { pid: 1, email: e("j1"), score: 0.7 },
    { pid: 2, email: e("s3"), score: 0.9 },
    { pid: 2, email: e("s4"), score: 0.8 },
    { pid: 2, email: e("j2"), score: 0.7 },
  ];
  return { people, papers, rows };
}

function input(over: Partial<ValidatorInput> = {}): ValidatorInput {
  const w = world();
  return {
    source: "tpms",
    tpmsRunId: 7,
    papers: w.papers,
    people: w.people,
    proposal: w.rows,
    current: [],
    invites: { runId: 1, rows: [] },
    doNotInvite: { runId: 2, rows: [] },
    ...over,
  };
}

const codes = (fs: Finding[]) => fs.map((f) => `${f.code} ${f.pid ?? "-"} ${f.emails.join(" ")}`);

describe("validate: clean input", () => {
  it("has no findings, and the fix-up lists seniors by score then the third slot", () => {
    const r = validate(input(), POLICY);
    expect(r.findings).toEqual([]);
    expect(r.fixup.csv).toBe(
      ["paper,action,user", `1,primary,${e("s1")}`, `1,primary,${e("s2")}`, `1,secondary,${e("j1")}`, `2,primary,${e("s3")}`, `2,primary,${e("s4")}`, `2,secondary,${e("j2")}`].join("\n") + "\n",
    );
    expect(r.fixup.gaps).toEqual([]);
    expect(r.counts).toMatchObject({ papers: 2, rows: 6, rowsKept: 6, findings: 0, cycles: 0 });
  });
});

describe("composition", () => {
  it("flags all-junior, missing senior, missing and extra third slot, with the numbers", () => {
    const w = world();
    w.people.set(e("j3"), person("j3", "junior"));
    const r = validate(
      input({
        proposal: [
          { pid: 1, email: e("j1"), score: 1 },
          { pid: 1, email: e("j2"), score: 1 },
          { pid: 2, email: e("s3"), score: 1 },
        ],
        people: w.people,
      }),
      POLICY,
    );
    const comp = r.findings.filter((f) => f.check === "composition");
    expect(codes(comp)).toEqual([
      `ALL_JUNIOR_PANEL 1 ${e("j1")} ${e("j2")}`,
      `THIRD_SLOT_EXTRA 1 ${e("j1")} ${e("j2")}`,
      `SENIOR_MISSING 2 ${e("s3")}`,
      `THIRD_SLOT_MISSING 2 ${e("s3")}`,
    ]);
    expect(comp[0]!.reason).toBe("#1 has 0 senior and 2 junior/reserve reviewers; PCS_POLICY_MIN_SENIOR=2");
    expect(comp[1]!.reason).toBe("#1 has 2 junior/reserve reviewers; PCS_POLICY_THIRD_SLOT=exactly1 allows 1");
    expect(comp[2]!.reason).toBe("#2 has 1 senior reviewer; PCS_POLICY_MIN_SENIOR=2");
    // exactly1: the fix-up keeps one third-slot reviewer (best score, then email).
    expect(r.fixup.lines.filter((l) => l.pid === 1).map((l) => l.email)).toEqual([e("j1")]);
    expect(r.fixup.gaps).toEqual([
      { pid: 1, seniorsMissing: 2, thirdMissing: 0 },
      { pid: 2, seniorsMissing: 1, thirdMissing: 1 },
    ]);
  });

  it("atleast1 allows several third-slot reviewers; MIN_SENIOR is configurable", () => {
    const w = world();
    const rows = [...w.rows, { pid: 1, email: e("j2"), score: 0.1 }];
    const r = validate(input({ proposal: rows }), { ...POLICY, thirdSlot: "atleast1", load: { ...POLICY.load, junior: { min: 0, max: 5 } } });
    expect(r.findings).toEqual([]);
    expect(r.fixup.lines.filter((l) => l.pid === 1 && l.slot === "third")).toHaveLength(2);
    const r3 = validate(input(), { ...POLICY, minSenior: 3 });
    expect(codes(r3.findings.filter((f) => f.check === "composition"))).toHaveLength(2);
  });

  it("hotcrp mode judges every live paper, including unassigned ones", () => {
    const r = validate(input({ source: "hotcrp", proposal: world().rows.filter((x) => x.pid === 1) }), POLICY);
    expect(codes(r.findings.filter((f) => f.check === "composition"))).toEqual(["SENIOR_MISSING 2 ", "THIRD_SLOT_MISSING 2 "]);
  });
});

describe("load bands", () => {
  it("flags over and under per tier; ACs and chairs are exempt; tpms mode skips people it doesn't mention", () => {
    const w = world();
    w.people.set(e("idle"), person("idle"));
    const rows = [...w.rows, { pid: 2, email: e("s1"), score: 0.1 }, { pid: 1, email: e("ac"), score: 0.1 }];
    // s1 has 2 (= max), fine; push to 3:
    w.papers.set(3, { pid: 3, authors: [] });
    rows.push({ pid: 3, email: e("s1"), score: 0.5 });
    const tp = validate(input({ proposal: rows, people: w.people, papers: w.papers }), POLICY);
    expect(codes(tp.findings.filter((f) => f.check === "load"))).toEqual([`LOAD_OVER - ${e("s1")}`]);
    expect(tp.findings.find((f) => f.code === "LOAD_OVER")!.reason).toBe(`${e("s1")} (senior) has 3 review assignments; PCS_LOAD_SENIOR_MAX=2`);
    const hc = validate(input({ source: "hotcrp", proposal: rows, people: w.people, papers: w.papers }), POLICY);
    expect(codes(hc.findings.filter((f) => f.check === "load"))).toEqual([`LOAD_UNDER - ${e("idle")}`, `LOAD_OVER - ${e("s1")}`]);
    expect(hc.findings.find((f) => f.code === "LOAD_UNDER")!.reason).toBe(`${e("idle")} (senior) has 0 review assignments; PCS_LOAD_SENIOR_MIN=1`);
  });

  it("reserve-pool members should have no assignments (0-0)", () => {
    const w = world();
    w.people.set(e("p1"), person("p1", "reserve-pool"));
    const r = validate(input({ proposal: [...w.rows, { pid: 1, email: e("p1"), score: 0.1 }], people: w.people }), {
      ...POLICY,
      thirdSlot: "atleast1",
    });
    expect(r.findings.find((f) => f.code === "LOAD_OVER")!.reason).toBe(`${e("p1")} (reserve-pool) has 1 review assignment; PCS_LOAD_RESERVE_POOL_MAX=0`);
  });
});

describe("input rows", () => {
  it("drops duplicates, unknown papers, and non-PC reviewers before any other check", () => {
    const w = world();
    w.people.set(e("gone"), person("gone", "senior", { isPc: false }));
    const rows = [...w.rows, w.rows[0]!, { pid: 9, email: e("s1"), score: 1 }, { pid: 1, email: e("gone"), score: 1 }, { pid: 1, email: e("nobody"), score: 1 }];
    const r = validate(input({ proposal: rows, people: w.people }), POLICY);
    expect(codes(r.findings)).toEqual([
      `NOT_PC_MEMBER 1 ${e("gone")}`,
      `NOT_PC_MEMBER 1 ${e("nobody")}`,
      `DUPLICATE_ROW 1 ${e("s1")}`,
      `UNKNOWN_PAPER 9 ${e("s1")}`,
    ]);
    expect(r.findings.every((f) => f.dropped)).toBe(true);
    expect(r.findings[3]!.reason).toBe("TPMS row (import #7): paper #9 is not a live paper in the store (last sync)");
    expect(r.fixup.lines).toHaveLength(6);
  });
});

describe("conflict sanity", () => {
  it("flags an author reviewing their own paper and same-affiliation pairs, and drops them", () => {
    const w = world();
    w.people.set(e("x1"), person("x1"));
    w.people.get(e("s4"))!.affiliation = "  y LABS. ";
    const rows = [...w.rows, { pid: 1, email: e("x1"), score: 1 }];
    const r = validate(input({ proposal: rows, people: w.people }), POLICY);
    expect(codes(r.findings.filter((f) => f.check === "conflict"))).toEqual([`AUTHOR_IS_REVIEWER 1 ${e("x1")}`, `SAME_AFFILIATION 2 ${e("s4")} ${e("x2")}`]);
    expect(r.findings.find((f) => f.code === "SAME_AFFILIATION")!.reason).toBe(
      `reviewer ${e("s4")} and 1 author of #2 share affiliation "  y LABS. " (PCS_CONFLICT_AFFILIATION=true)`,
    );
    expect(r.fixup.lines.map((l) => l.email)).not.toContain(e("s4"));
    expect(r.fixup.gaps).toEqual([{ pid: 2, seniorsMissing: 1, thirdMissing: 0 }]);
    // Off switch.
    const off = validate(input({ proposal: rows, people: w.people }), { ...POLICY, affiliationConflicts: false });
    expect(off.findings.some((f) => f.code === "SAME_AFFILIATION")).toBe(false);
  });

  it("normalizes affiliations (case, accents, punctuation, spacing); empty never matches", () => {
    expect(normalizeAffiliation("Université  de Montréal.")).toBe(normalizeAffiliation("universite de montreal"));
    expect(normalizeAffiliation("  ")).toBe("");
  });

  it("uses a co-authorship source only when PCS_CONFLICT_DBLP is on; notes a missing source", () => {
    const co = staticCoauthorship("test cache", [[e("s1"), e("x1"), 2]]);
    const on = validate(input({ coauthors: co }), { ...POLICY, dblpConflicts: true });
    expect(on.findings.map((f) => f.reason)).toEqual([
      `reviewer ${e("s1")} co-authored 2 papers with ${e("x1")}, an author of #1 (test cache; a hint, not a verdict)`,
    ]);
    expect(validate(input({ coauthors: co }), POLICY).findings).toEqual([]);
    expect(validate(input(), { ...POLICY, dblpConflicts: true }).notes[0]).toMatch(/no co-authorship source/);
  });
});

describe("reserve candidates", () => {
  const withReserves = () => {
    const w = world();
    for (const k of ["ra", "rb", "rc", "rd"]) w.people.set(e(k), person(k, "reserve-active"));
    const rows = [
      ...w.rows.filter((r) => !r.email.startsWith("j")),
      { pid: 1, email: e("ra"), score: 0.5 },
      { pid: 2, email: e("rb"), score: 0.5 },
    ];
    return { w, rows };
  };
  const invite = (pid: number, k: string, ac_decision: "approve" | "reject" | "pending", response: "accept" | "decline" | "none" = "none") => ({
    pid,
    candidate_email: e(k),
    tpms_score: null,
    seniority_note: null,
    ac_email: null,
    ac_decision,
    invited_at: null,
    response,
    activated_at: null,
  });

  it("requires an approve row for the same paper, not declined, in the latest invites import", () => {
    const { w, rows } = withReserves();
    const r = validate(
      input({ people: w.people, proposal: [...rows, { pid: 1, email: e("rc"), score: 0.1 }], invites: { runId: 4, rows: [invite(1, "ra", "approve", "accept"), invite(1, "rb", "approve"), invite(1, "rc", "approve", "decline")] } }),
      { ...POLICY, thirdSlot: "atleast1" },
    );
    expect(r.findings.filter((f) => f.check === "reserve").map((f) => f.reason)).toEqual([
      `reserve candidate ${e("rc")} (reserve-active) on #1: invites import #4 says ac_decision=approve but response=decline for #1`,
      `reserve candidate ${e("rb")} (reserve-active) on #2: invites import #4 has no row for #2 and this candidate`,
    ]);
    expect(r.fixup.lines.map((l) => l.email)).toContain(e("ra"));
    expect(r.fixup.lines.map((l) => l.email)).not.toContain(e("rb"));
  });

  it("with no invites import, no reserve candidate is approved", () => {
    const { w, rows } = withReserves();
    const r = validate(input({ people: w.people, proposal: rows, invites: undefined }), POLICY);
    expect(r.findings.filter((f) => f.code === "RESERVE_NOT_APPROVED").map((f) => f.reason)).toEqual([
      `reserve candidate ${e("ra")} (reserve-active) on #1: no invites import yet (pcs import invites <file>)`,
      `reserve candidate ${e("rb")} (reserve-active) on #2: no invites import yet (pcs import invites <file>)`,
    ]);
    expect(r.imports.invitesRunId).toBeNull();
  });

  it("flags anyone on the do-not-invite list", () => {
    const r = validate(input({ doNotInvite: { runId: 5, rows: [{ email: e("j2"), reason: null, source: null }] } }), POLICY);
    expect(r.findings.map((f) => f.reason)).toEqual([`${e("j2")} (junior) on #2 is on the do-not-invite list (import #5)`]);
    expect(r.fixup.gaps).toEqual([{ pid: 2, seniorsMissing: 0, thirdMissing: 1 }]);
  });
});

describe("reciprocal cycles", () => {
  it("builds author -> reviewer edges over the panel and reports a 2-cycle with its papers", () => {
    const w = world();
    // s1 authors #2 (reviewed by s3); s3 authors #1 (reviewed by s1)? s3 doesn't review #1; make it so.
    w.papers.set(1, { pid: 1, authors: [{ email: e("s3"), affiliation: "s3 University 2" }] });
    w.papers.set(2, { pid: 2, authors: [{ email: e("s1"), affiliation: "s1 University 2" }] });
    const rows = w.rows.map((r) => (r.pid === 1 && r.email === e("s2") ? { ...r, email: e("s4") } : r));
    // #1: s1, s4, j1 (authored by s3); #2: s3, s4, j2 (authored by s1). s1 -> s3 (via #2), s3 -> s1 (via #1).
    const r = validate(input({ people: w.people, papers: w.papers, proposal: rows }), { ...POLICY, load: { ...POLICY.load, senior: { min: 0, max: 5 } } });
    const cyc = r.findings.filter((f) => f.code === "RECIPROCAL_CYCLE");
    expect(cyc).toHaveLength(1);
    expect(cyc[0]).toMatchObject({ pid: 1, emails: [e("s1"), e("s3")], cyclePids: [[2], [1]] });
    expect(cyc[0]!.reason).toBe(
      `reciprocal 2-cycle (PCS_CYCLE_MAX_K=3): ${e("s1")} authors #2, reviewed by ${e("s3")}; ${e("s3")} authors #1, reviewed by ${e("s1")}. For human review only`,
    );
    // Never auto-acted on: the fix-up still has both.
    expect(r.fixup.lines.filter((l) => l.email === e("s1") || l.email === e("s3"))).toHaveLength(2);
  });
});

describe("fix-up against the current HotCRP assignment", () => {
  it("clears dropped or replaced assignments only if their review is untouched, and keeps existing roles", () => {
    const current: CurrentAssignment[] = [
      { pid: 1, email: e("s1"), role: "secondary", status: "empty" },
      { pid: 1, email: e("s3"), role: "primary", status: "empty" }, // not in the proposal: cleared
      { pid: 2, email: e("s1"), role: "pc", status: "draft" }, // not in the proposal, started: kept
      { pid: 2, email: e("j2"), role: "pc", status: null },
    ];
    const r = validate(input({ current }), POLICY);
    expect(r.fixup.lines.filter((l) => l.pid === 1)).toEqual([
      { pid: 1, action: "clearreview", email: e("s3"), slot: "remove" },
      { pid: 1, action: "secondary", email: e("s1"), slot: "senior" },
      { pid: 1, action: "primary", email: e("s2"), slot: "senior" },
      { pid: 1, action: "secondary", email: e("j1"), slot: "third" },
    ]);
    expect(r.fixup.lines.find((l) => l.pid === 2 && l.email === e("j2"))!.action).toBe("pcreview");
    expect(r.fixup.keptStarted).toEqual([{ pid: 2, email: e("s1"), status: "draft" }]);
  });

  it("tpms mode leaves papers the proposal doesn't cover alone", () => {
    const current: CurrentAssignment[] = [{ pid: 3, email: e("s1"), role: "primary", status: "empty" }];
    const w = world();
    w.papers.set(3, { pid: 3, authors: [] });
    const r = validate(input({ current, papers: w.papers }), POLICY);
    expect(r.fixup.lines.some((l) => l.pid === 3)).toBe(false);
  });
});
