// PLAN M10b: the assignment network (spec §10.5). Property tests on random
// instances (composition met or reported, bands respected, no forbidden
// edge, pins kept, repairs leave no unreported cycle or institution clash),
// plus small hand-built cases for the tier gadget, pins, repairs, the CSV,
// and hard mode.

import { describe, expect, it } from "vitest";
import { DEFAULT_ASSIGNMENT_POLICY, DEFAULT_SOLVER_SETTINGS, type AssignmentPolicy, type SolverSettings } from "../../../src/config.js";
import { findCycles } from "../../../src/modules/assignment/cycles.js";
import type { PaperInfo, PersonInfo } from "../../../src/modules/assignment/types.js";
import { CLEARABLE_STATUSES, RESERVE_TIERS, normalizeAffiliation } from "../../../src/modules/assignment/validate.js";
import { hotcrpScore, matrixScores } from "../../../src/modules/solver/affinity.js";
import { solve } from "../../../src/modules/solver/solve.js";
import type { SolveReport, SolverInput } from "../../../src/modules/solver/types.js";
import { randomInstance, type Instance } from "../../support/solver-instances.js";

function checkProperties({ input, policy }: Instance, rep: SolveReport) {
  const problems: string[] = [];
  const people = input.people;
  const key = (pid: number, e: string) => `${pid}\t${e}`;
  const pinnedStarted = new Set(input.current.filter((c) => c.status !== null && !CLEARABLE_STATUSES.has(c.status)).map((c) => key(c.pid, c.email)));
  const assigned = new Set(rep.assignments.map((a) => key(a.pid, a.email)));
  const dni = new Set(input.doNotInvite?.rows.map((r) => r.email));
  const conflicts = new Set(input.conflicts.map((c) => key(c.pid, c.email)));
  for (const p of input.prefs ?? []) if (p.conflict) conflicts.add(key(p.pid, p.email));
  const approved = new Set(input.invites?.rows.filter((r) => r.ac_decision === "approve" && r.response !== "decline").map((r) => key(r.pid, r.candidate_email)));
  const blocked = new Set(input.blocked.map((b) => key(b.pid, b.email)));

  // Composition: met, or reported with a reason that carries numbers.
  const unmet = new Map(rep.unmet.map((u) => [`${u.pid}\t${u.slot}`, u]));
  for (const pid of input.papers.keys()) {
    const rows = rep.assignments.filter((a) => a.pid === pid);
    const s = rows.filter((a) => a.slot === "senior").length;
    const t = rows.length - s;
    if (s < policy.minSenior && !unmet.get(`${pid}\tsenior`)?.reason.match(/\d/)) problems.push(`#${pid}: ${s} seniors, not reported`);
    if (t < 1 && !unmet.get(`${pid}\tthird`)?.reason.match(/\d/)) problems.push(`#${pid}: no third slot, not reported`);
    if (unmet.has(`${pid}\tsenior`) && s >= policy.minSenior) problems.push(`#${pid}: senior reported unmet but met`);
    if (t > 1 && rows.filter((a) => a.slot === "third" && !a.pinned).length > 0 && policy.thirdSlot === "exactly1") problems.push(`#${pid}: ${t} third-slot reviewers`);
  }
  // Bands: never exceeded except by pins.
  const load = new Map<string, number>();
  const pinnedLoad = new Map<string, number>();
  for (const a of rep.assignments) {
    load.set(a.email, (load.get(a.email) ?? 0) + 1);
    if (a.pinned) pinnedLoad.set(a.email, (pinnedLoad.get(a.email) ?? 0) + 1);
  }
  for (const [e, n] of load) {
    const p = people.get(e)!;
    const band = policy.load[p.tier as keyof AssignmentPolicy["load"]];
    if (n > Math.max(band?.max ?? 0, pinnedLoad.get(e) ?? 0)) problems.push(`${e} (${p.tier}) has ${n} > band`);
  }
  // No forbidden edge (pins aside).
  for (const a of rep.assignments) {
    if (a.pinned) continue;
    const p = people.get(a.email)!;
    const paper = input.papers.get(a.pid)!;
    const k = key(a.pid, a.email);
    if (!p.isPc || p.exempt) problems.push(`${k}: not assignable`);
    if (paper.authors.some((x) => x.email === a.email)) problems.push(`${k}: author`);
    if (conflicts.has(k)) problems.push(`${k}: conflict`);
    if (blocked.has(k)) problems.push(`${k}: blocked`);
    if (dni.has(a.email)) problems.push(`${k}: do-not-invite`);
    if (RESERVE_TIERS.has(p.tier) && !approved.has(k)) problems.push(`${k}: unapproved reserve`);
    const ra = normalizeAffiliation(p.affiliation);
    if (policy.affiliationConflicts && ra !== "" && paper.authors.some((x) => normalizeAffiliation(x.affiliation) === ra)) problems.push(`${k}: same affiliation`);
  }
  // Pins kept.
  for (const k of pinnedStarted) if (!assigned.has(k)) problems.push(`started review ${k} dropped`);
  // Repairs: every remaining cycle / institution clash is reported as unresolved.
  const edges = rep.assignments.flatMap((a) =>
    input.papers.get(a.pid)!.authors.filter((x) => x.email && x.email !== a.email).map((x) => ({ from: x.email!, to: a.email, pid: a.pid })),
  );
  const unresolved = new Set(rep.unresolved.filter((u) => u.kind === "cycle").map((u) => u.emails.join(" ")));
  for (const c of findCycles(edges, policy.cycleMaxK, 10_000).cycles) {
    if (!unresolved.has(c.nodes.join(" "))) problems.push(`cycle ${c.nodes.join(" -> ")} left unreported`);
  }
  const instUnresolved = new Set(rep.unresolved.filter((u) => u.kind === "institution").flatMap((u) => u.pids));
  const byPaperAff = new Map<string, number>();
  for (const a of rep.assignments) {
    const n = normalizeAffiliation(people.get(a.email)!.affiliation);
    if (n === "") continue;
    const k = `${a.pid}\t${n}`;
    byPaperAff.set(k, (byPaperAff.get(k) ?? 0) + 1);
  }
  for (const [k, n] of byPaperAff) if (n > 1 && !instUnresolved.has(Number(k.split("\t")[0]))) problems.push(`#${k}: ${n} reviewers from one institution`);
  // CSV: one line per assignment plus clearreviews of current unstarted ones the solve dropped.
  const csvAssign = rep.lines.filter((l) => l.action !== "clearreview");
  if (csvAssign.length !== rep.assignments.length) problems.push("csv/assignment count mismatch");
  for (const l of rep.lines.filter((x) => x.action === "clearreview")) {
    const c = input.current.find((x) => x.pid === l.pid && x.email === l.email);
    if (!c || pinnedStarted.has(key(l.pid, l.email)) || assigned.has(key(l.pid, l.email))) problems.push(`bad clearreview ${l.pid} ${l.email}`);
  }
  for (const c of input.current) {
    if (!assigned.has(key(c.pid, c.email)) && !rep.lines.some((l) => l.action === "clearreview" && l.pid === c.pid && l.email === c.email)) {
      problems.push(`current ${c.pid} ${c.email} neither kept nor cleared`);
    }
  }
  return problems;
}

describe("solver properties on random instances", () => {
  const shapes = [
    { papers: 12, seniors: 10, juniors: 3, reserves: 3 },
    { papers: 30, seniors: 20, juniors: 6, reserves: 4, affiliations: 5 },
    { papers: 25, seniors: 8, juniors: 2, reserves: 2, scored: 0.2 },
    { papers: 40, seniors: 30, juniors: 8, reserves: 6, pcAuthors: 2, current: 0.6 },
  ];
  for (let seed = 1; seed <= 40; seed++) {
    const shape = shapes[seed % shapes.length]!;
    it(`seed ${seed}: ${shape.papers} papers, soft`, () => {
      const inst = randomInstance(seed, shape);
      const rep = solve(inst.input, inst.policy, inst.settings);
      expect(rep.feasible).toBe(true);
      expect(checkProperties(inst, rep)).toEqual([]);
      expect(rep.crossCheck.findings.filter((f) => f.explainedBy === null).map((f) => f.reason)).toEqual([]);
    });
  }
  for (let seed = 101; seed <= 115; seed++) {
    const shape = shapes[seed % shapes.length]!;
    it(`seed ${seed}: hard mode is feasible with every slot met, or reports what is unmet`, () => {
      const inst = randomInstance(seed, shape);
      const rep = solve(inst.input, inst.policy, inst.settings, { hard: true });
      if (rep.feasible) {
        expect(rep.unmet).toEqual([]);
        expect(checkProperties(inst, rep)).toEqual([]);
      } else {
        expect(rep.unmet.length).toBeGreaterThan(0);
        expect(rep.assignments).toEqual([]);
        expect(rep.lines).toEqual([]);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Hand-built cases

const person = (email: string, tier = "senior", affiliation: string | null = null, extra: Partial<PersonInfo> = {}): [string, PersonInfo] => [
  email,
  { email, tier, affiliation, isPc: true, exempt: false, ...extra },
];
const e = (n: string) => `${n}@example.org`;

function small(o: Partial<SolverInput> & { papers: Map<number, PaperInfo>; people: Map<string, PersonInfo> }): SolverInput {
  return { current: [], blocked: [], conflicts: [], invites: undefined, doNotInvite: undefined, scores: undefined, prefs: undefined, ...o };
}
const policy1: AssignmentPolicy = {
  ...DEFAULT_ASSIGNMENT_POLICY,
  minSenior: 1,
  load: { senior: { min: 0, max: 2 }, junior: { min: 0, max: 2 }, "reserve-active": { min: 0, max: 1 }, "reserve-pool": { min: 0, max: 0 } },
};
// MAX_SENIOR = MIN_SENIOR (the config default): no optional senior slots.
const settings: SolverSettings = { ...DEFAULT_SOLVER_SETTINGS, maxSenior: 1 };

describe("solver: tier gadget, pins, eligibility", () => {
  it("fills seniors from senior reviewers and the third slot from a junior, by affinity", () => {
    const people = new Map([person(e("s1")), person(e("s2")), person(e("s3")), person(e("j1"), "junior")]);
    const papers = new Map([[1, { pid: 1, authors: [{ email: e("x"), affiliation: null }] }]]);
    const scores = matrixScores([
      { pid: 1, email: e("s1"), score: 0.2 },
      { pid: 1, email: e("s2"), score: 0.9 },
      { pid: 1, email: e("s3"), score: 0.8 },
      { pid: 1, email: e("j1"), score: 0.1 },
    ]);
    const rep = solve(small({ papers, people, scores }), { ...policy1, minSenior: 2 }, settings);
    expect(rep.assignments.map((a) => [a.email, a.slot, a.action, a.affinity])).toEqual([
      [e("s2"), "senior", "primary", 900],
      [e("s3"), "senior", "primary", 800],
      [e("j1"), "third", "secondary", 100],
    ]);
    expect(rep.unmet).toEqual([]);
    expect(rep.csv).toBe(`paper,action,email,round\n1,primary,${e("s2")},\n1,primary,${e("s3")},\n1,secondary,${e("j1")},\n`);
    expect(rep.sources.tpmsRunId).toBeNull();
  });

  it("reports an unstaffable slot with the eligible count instead of failing (soft)", () => {
    const people = new Map([person(e("s1")), person(e("j1"), "junior")]);
    const papers = new Map([[1, { pid: 1, authors: [{ email: e("j1"), affiliation: null }] }]]);
    const rep = solve(small({ papers, people }), { ...policy1, minSenior: 2 }, settings);
    expect(rep.feasible).toBe(true);
    expect(rep.unmet.map((u) => [u.slot, u.have, u.need, u.eligible])).toEqual([
      ["senior", 1, 2, 1],
      ["third", 0, 1, 0],
    ]);
    expect(rep.unmet[0]!.reason).toContain("only 1 eligible candidate");
    expect(rep.crossCheck.unexplained).toBe(0);
    // Hard mode: the same instance is infeasible, and says where.
    const hard = solve(small({ papers, people }), { ...policy1, minSenior: 2 }, settings, { hard: true });
    expect(hard.feasible).toBe(false);
    expect(hard.unmet.map((u) => [u.pid, u.slot])).toEqual([
      [1, "senior"],
      [1, "third"],
    ]);
  });

  it("omits conflicted, author, same-affiliation, do-not-invite, blocked and unapproved-reserve edges", () => {
    const people = new Map([
      person(e("conf")),
      person(e("auth")),
      person(e("aff"), "senior", "Same U"),
      person(e("dni")),
      person(e("qr")),
      person(e("ok")),
      person(e("res"), "reserve-active"),
      person(e("resok"), "reserve-active"),
    ]);
    const papers = new Map([[1, { pid: 1, authors: [{ email: e("auth"), affiliation: "Same  U." }] }]]);
    const rep = solve(
      small({
        papers,
        people,
        conflicts: [{ pid: 1, email: e("conf") }],
        blocked: [{ pid: 1, email: e("qr") }],
        doNotInvite: { runId: 3, rows: [{ email: e("dni"), reason: null, source: null }] },
        invites: {
          runId: 4,
          rows: [
            { pid: 1, candidate_email: e("res"), tpms_score: null, seniority_note: null, ac_email: null, ac_decision: "pending", invited_at: null, response: "none", activated_at: null },
            { pid: 1, candidate_email: e("resok"), tpms_score: null, seniority_note: null, ac_email: null, ac_decision: "approve", invited_at: null, response: "none", activated_at: null },
          ],
        },
      }),
      { ...policy1, minSenior: 2 },
      settings,
    );
    expect(rep.assignments.map((a) => a.email)).toEqual([e("ok"), e("resok")]);
    expect(rep.unmet.map((u) => u.reason)).toEqual([expect.stringContaining("#1 has 1 of PCS_POLICY_MIN_SENIOR=2 senior reviewers: only 1 eligible candidate")]);
  });

  it("keeps started reviews (pinned, even over the band) and clears unstarted ones it drops", () => {
    const people = new Map([person(e("s1")), person(e("s2")), person(e("s3")), person(e("j1"), "junior")]);
    const papers = new Map([1, 2, 3].map((pid) => [pid, { pid, authors: [] }] as [number, PaperInfo]));
    const scores = matrixScores([1, 2, 3].flatMap((pid) => [{ pid, email: e("s2"), score: 0.9 }, { pid, email: e("s3"), score: 0.9 }]));
    const rep = solve(
      small({
        papers,
        people,
        scores,
        current: [
          { pid: 1, email: e("s1"), role: "pc", status: "complete" },
          { pid: 2, email: e("s1"), role: "secondary", status: "draft" },
          { pid: 3, email: e("s1"), role: "primary", status: "complete" },
          { pid: 3, email: e("j1"), role: "primary", status: "empty" },
          { pid: 2, email: e("s3"), role: "primary", status: null },
        ],
      }),
      policy1,
      { ...settings, loadMinBonus: 0 },
    );
    const s1 = rep.assignments.filter((a) => a.email === e("s1"));
    expect(s1.map((a) => [a.pid, a.pinned, a.action])).toEqual([
      [1, "started", "pcreview"],
      [2, "started", "secondary"],
      [3, "started", "primary"],
    ]);
    // j1 (junior, unstarted) stays on #3: the third slot needs it, and current assignments stay candidates.
    expect(rep.assignments.find((a) => a.pid === 3 && a.email === e("j1"))).toMatchObject({ current: true, action: "primary" });
    // s3 on #2 is unstarted and not needed (#2 has its senior pinned): cleared.
    expect(rep.cleared).toEqual([{ pid: 2, email: e("s3") }]);
    expect(rep.lines.filter((l) => l.action === "clearreview")).toEqual([{ pid: 2, action: "clearreview", email: e("s3"), round: "" }]);
    // s1 is over PCS_LOAD_SENIOR_MAX=2 only because of pins; the cross-check explains it.
    expect(rep.crossCheck.findings.find((f) => f.code === "LOAD_OVER")).toMatchObject({ explainedBy: "pinned reviews exceed the band" });
    expect(rep.crossCheck.unexplained).toBe(0);
  });

  it("pins AC-activated reserves, and reports activations it can't pin", () => {
    const people = new Map([person(e("s1")), person(e("res"), "reserve-active"), person(e("bad"), "reserve-active"), person(e("np"), "reserve-active", null, { isPc: false })]);
    const papers = new Map([[1, { pid: 1, authors: [] }], [2, { pid: 2, authors: [] }]] as [number, PaperInfo][]);
    const inv = (pid: number, email: string) => ({ pid, candidate_email: email, tpms_score: null, seniority_note: null, ac_email: null, ac_decision: "approve" as const, invited_at: null, response: "accept" as const, activated_at: 1_900_000_000 });
    const rep = solve(
      small({
        papers,
        people,
        invites: { runId: 9, rows: [inv(1, e("res")), inv(2, e("bad")), inv(2, e("np"))] },
        doNotInvite: { runId: 2, rows: [{ email: e("bad"), reason: null, source: null }] },
      }),
      policy1,
      settings,
    );
    expect(rep.assignments.filter((a) => a.pinned).map((a) => [a.pid, a.email, a.pinned])).toEqual([[1, e("res"), "reserve"]]);
    expect(rep.pinIssues.map((p) => [p.pid, p.email])).toEqual([
      [2, e("bad")],
      [2, e("np")],
    ]);
    expect(rep.pinIssues[0]!.reason).toContain("do-not-invite");
    expect(rep.pinIssues[1]!.reason).toContain("not a PC member yet");
  });
});

describe("solver: repair passes", () => {
  // a authors #1, b authors #2; each is the best reviewer of the other's paper.
  const people = new Map([person(e("a")), person(e("b")), person(e("c")), person(e("d")), person(e("j1"), "junior"), person(e("j2"), "junior")]);
  const papers = new Map([
    [1, { pid: 1, authors: [{ email: e("a"), affiliation: null }] }],
    [2, { pid: 2, authors: [{ email: e("b"), affiliation: null }] }],
  ] as [number, PaperInfo][]);
  const scores = matrixScores([
    { pid: 1, email: e("b"), score: 0.9 },
    { pid: 2, email: e("a"), score: 0.95 },
    { pid: 1, email: e("c"), score: 0.5 },
    { pid: 2, email: e("d"), score: 0.5 },
  ]);

  it("breaks a reciprocal 2-cycle by forbidding its lowest-affinity edge, and re-solves", () => {
    const rep = solve(small({ papers, people, scores }), policy1, settings);
    expect(rep.repairs).toHaveLength(1);
    expect(rep.repairs[0]).toMatchObject({ round: 1, kind: "cycle", removed: [{ pid: 1, email: e("b"), affinity: 900 }] });
    expect(rep.repairs[0]!.reason).toMatch(/reciprocal 2-cycle .*removed b@example.org from #1 \(affinity 900\)/);
    expect(rep.assignments.filter((a) => a.slot === "senior").map((a) => [a.pid, a.email])).toEqual([
      [1, e("c")],
      [2, e("a")],
    ]);
    expect(rep.unresolved).toEqual([]);
    // The full solve, the warm re-solve of #1, and the final full "polish" solve.
    expect(rep.counts.solves).toBe(3);
    expect(rep.crossCheck.findings.filter((f) => f.code === "RECIPROCAL_CYCLE")).toEqual([]);
  });

  it("reports a cycle made only of pinned (started) reviews as unresolved", () => {
    const rep = solve(
      small({
        papers,
        people,
        scores,
        current: [
          { pid: 1, email: e("b"), role: "primary", status: "complete" },
          { pid: 2, email: e("a"), role: "primary", status: "complete" },
        ],
      }),
      policy1,
      settings,
    );
    expect(rep.repairs).toEqual([]);
    expect(rep.unresolved).toEqual([{ kind: "cycle", pids: [1, 2], emails: [e("a"), e("b")], reason: expect.stringContaining("every assignment that could break it is pinned") }]);
    expect(rep.crossCheck.findings.find((f) => f.code === "RECIPROCAL_CYCLE")!.explainedBy).toBe("reported as unresolved by the repair pass");
  });

  it("stops at PCS_SOLVER_REPAIR_MAX and reports what is left", () => {
    const rep = solve(small({ papers, people, scores }), policy1, { ...settings, repairMax: 0 });
    expect(rep.repairs).toEqual([]);
    expect(rep.unresolved.map((u) => u.kind)).toEqual(["cycle"]);
    expect(rep.unresolved[0]!.reason).toContain("PCS_SOLVER_REPAIR_MAX=0");
  });

  it("keeps at most one reviewer per institution per paper (configurable)", () => {
    const ppl = new Map([person(e("u1"), "senior", "Uni A"), person(e("u2"), "senior", "uni a"), person(e("v1"), "senior", "Uni B"), person(e("j1"), "junior", "Uni A")]);
    const pp = new Map([[1, { pid: 1, authors: [] }]] as [number, PaperInfo][]);
    const sc = matrixScores([
      { pid: 1, email: e("u1"), score: 0.9 },
      { pid: 1, email: e("u2"), score: 0.8 },
      { pid: 1, email: e("v1"), score: 0.1 },
      { pid: 1, email: e("j1"), score: 0.5 },
    ]);
    const on = solve(small({ papers: pp, people: ppl, scores: sc }), { ...policy1, minSenior: 2 }, settings);
    expect(on.repairs.map((r) => [r.kind, r.removed.map((x) => x.email)])).toEqual([["institution", [e("u2"), e("j1")]]]);
    // Without a second Uni A, the third slot has no other candidate, so it is reported unmet.
    expect(on.assignments.map((a) => a.email)).toEqual([e("u1"), e("v1")]);
    expect(on.unmet.map((u) => u.slot)).toEqual(["third"]);
    expect(on.unmet[0]!.reason).toContain("repairs forbade");
    const off = solve(small({ papers: pp, people: ppl, scores: sc }), { ...policy1, minSenior: 2 }, { ...settings, onePerInstitution: false });
    expect(off.repairs).toEqual([]);
    expect(off.assignments.map((a) => a.email)).toEqual([e("u1"), e("u2"), e("j1")]);
  });
});

describe("solver: affinity normalization", () => {
  it("TPMS beats local beats HotCRP preferences, each weighted, on one integer scale", () => {
    const people = new Map([person(e("t")), person(e("l")), person(e("h")), person(e("n")), person(e("j"), "junior")]);
    const papers = new Map([[1, { pid: 1, authors: [] }]] as [number, PaperInfo][]);
    const scores = matrixScores([
      { pid: 1, email: e("t"), score: 0.5, source: "tpms" },
      { pid: 1, email: e("t"), score: 0.9, source: "local" },
      { pid: 1, email: e("l"), score: 0.5, source: "local" },
    ]);
    const prefs = [
      { pid: 1, email: e("h"), conflict: false, preference: 20, expertise: "X" as const, topicScore: 10 },
      { pid: 1, email: e("t"), conflict: false, preference: 20, expertise: null, topicScore: 0 },
    ];
    const rep = solve(small({ papers, people, scores, prefs }), { ...policy1, minSenior: 4 }, { ...settings, weights: { tpms: 2, local: 1, hotcrp: 0.5 } });
    const by = new Map(rep.assignments.map((a) => [a.email, [a.affinity, a.source]]));
    expect(by.get(e("t"))).toEqual([1000, "tpms"]);
    expect(by.get(e("l"))).toEqual([500, "local"]);
    expect(by.get(e("h"))).toEqual([500, "hotcrp"]);
    expect(by.get(e("n"))).toEqual([0, "none"]);
    expect(rep.sources.hotcrpPrefs).toBe(2);
    expect(rep.coverage.unscoredAssignments).toBe(2);
  });

  it("maps HotCRP preference, expertise and topic score into 0-1", () => {
    expect(hotcrpScore({ preference: 0, expertise: null, topicScore: 0 }, 20)).toBe(0.5);
    expect(hotcrpScore({ preference: 20, expertise: "X", topicScore: 10 }, 20)).toBe(1);
    expect(hotcrpScore({ preference: -100, expertise: "Z", topicScore: -10 }, 20)).toBeCloseTo(0, 10);
    expect(hotcrpScore({ preference: 10, expertise: "Y", topicScore: 0 }, 20)).toBeCloseTo(0.65, 10);
  });

  it("reports papers whose best eligible candidate is weak (PCS_SOLVER_WEAK_AFFINITY)", () => {
    const people = new Map([person(e("s1")), person(e("s2")), person(e("j1"), "junior")]);
    const papers = new Map([[1, { pid: 1, authors: [] }], [2, { pid: 2, authors: [] }]] as [number, PaperInfo][]);
    const scores = matrixScores([
      { pid: 1, email: e("s1"), score: 0.9 },
      { pid: 1, email: e("j1"), score: 0.8 },
      { pid: 2, email: e("s1"), score: 0.2 },
      { pid: 2, email: e("j1"), score: 0.8 },
    ]);
    const rep = solve(small({ papers, people, scores }), policy1, settings);
    expect(rep.coverage.weak.map((w) => [w.pid, w.bestSenior, w.bestThird])).toEqual([[2, 0.2, 0.8]]);
    expect(rep.coverage.weak[0]!.reason).toBe("#2: best senior candidate scores 0.20, best third-slot candidate scores 0.80 (PCS_SOLVER_WEAK_AFFINITY=0.3)");
  });
});

describe("solver: outputs", () => {
  it("writes PCS_SOLVER_ROUND on new assignments only, and a load histogram by tier", () => {
    const people = new Map([person(e("s1")), person(e("s2")), person(e("j1"), "junior"), person(e("j2"), "junior")]);
    const papers = new Map([[1, { pid: 1, authors: [] }]] as [number, PaperInfo][]);
    const rep = solve(
      small({ papers, people, current: [{ pid: 1, email: e("s1"), role: "secondary", status: "empty" }] }),
      policy1,
      { ...settings, round: "R1" },
    );
    const s1 = rep.lines.find((l) => l.email === e("s1"));
    expect(s1).toEqual({ pid: 1, action: "secondary", email: e("s1"), round: "" });
    expect(rep.lines.find((l) => l.action === "secondary" && l.email !== e("s1"))!.round).toBe("R1");
    expect(rep.load.map((l) => [l.tier, l.reviewers, l.histogram])).toEqual([
      ["senior", 2, [{ load: 0, reviewers: 1 }, { load: 1, reviewers: 1 }]],
      ["junior", 2, [{ load: 0, reviewers: 1 }, { load: 1, reviewers: 1 }]],
    ]);
    expect(rep.objective).toBeLessThan(0);
    expect(rep.counts).toMatchObject({ papers: 1, assignments: 2, kept: 1, added: 1, cleared: 0 });
  });
});
