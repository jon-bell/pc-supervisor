// Phase logic at several PCS_NOW values (PLAN M4).
import { describe, expect, it } from "vitest";
import { analyze } from "../../../src/rules/index.js";
import { daysSince, daysToDecisions, phaseAt, type PhaseTimes } from "../../../src/rules/phase.js";
import { at, contextAt } from "../../fixtures/builder.js";
import { goldenSnapshot } from "../../fixtures/golden.js";

const P = contextAt("2030-02-26T12:00").phases;

describe("phaseAt", () => {
  const cases: [string, string][] = [
    ["2030-01-15T12:00", "before-review-due"],
    ["2030-02-01T23:59", "before-review-due"], // the deadline instant itself
    ["2030-02-02T00:00", "reviewing-late"],
    ["2030-02-08T00:00", "response"],
    ["2030-02-11T23:59", "response"],
    ["2030-02-11T23:59:30", "reviewing-late"], // gap between response close and discussion
    ["2030-02-12T00:00", "discussion"],
    ["2030-02-26T12:00", "discussion"],
    ["2030-03-01T23:59", "discussion"],
    ["2030-03-02T00:00", "decisions"],
    ["2030-03-03T23:59", "decisions"],
    ["2030-03-04T00:00", "after-decisions"],
  ];
  for (const [now, phase] of cases) {
    it(`${now} -> ${phase}`, () => {
      expect(phaseAt(P, at(now))).toBe(phase);
    });
  }

  it("with no response window, the gap is reviewing-late", () => {
    const noResp: PhaseTimes = { ...P, responseOpen: null, responseClose: null };
    expect(phaseAt(noResp, at("2030-02-09T12:00"))).toBe("reviewing-late");
  });

  it("reads phase dates in PCS_TZ (DST-free February: -05:00)", () => {
    expect(new Date(P.discussionOpen).toISOString()).toBe("2030-02-12T05:00:00.000Z");
    expect(daysSince(P.discussionOpen, at("2030-02-26T12:00"))).toBe(14.5);
    expect(daysToDecisions(P, at("2030-03-01T23:59"))).toBe(2);
  });
});

describe("golden rules by phase", () => {
  const firing = (now: string) => {
    const a = analyze(goldenSnapshot(), contextAt(now));
    const m = new Map<number, string[]>();
    for (const r of a.evaluation.results) if (r.fired.length) m.set(r.pid, r.fired.map((f) => f.rule).sort());
    return { phase: a.phase, m };
  };

  it("before review-due: only phase-free rules (SPLIT, THIN_REVIEWS)", () => {
    const { phase, m } = firing("2030-01-31T12:00");
    expect(phase).toBe("before-review-due");
    const rules = new Set([...m.values()].flat());
    expect([...rules].sort()).toEqual(["SPLIT", "THIN_REVIEWS"]);
    expect([...m.keys()].sort((x, y) => x - y)).toEqual([3, 4, 10, 12]);
  });

  it("after review-due, before discussion: MISSING_REVIEWS and LOW_EXPERTISE switch on", () => {
    const { phase, m } = firing("2030-02-05T12:00");
    expect(phase).toBe("reviewing-late");
    expect(m.get(2)).toEqual(["MISSING_REVIEWS"]);
    expect(m.get(9)).toEqual(["LOW_EXPERTISE"]);
    expect(m.has(5)).toBe(false);
    expect(m.has(11)).toBe(false);
  });

  it("mid-discussion: the golden table (see golden.test.ts)", () => {
    const { phase, m } = firing("2030-02-26T12:00");
    expect(phase).toBe("discussion");
    expect(m.get(4)).toEqual(["SPLIT", "UNRESOLVED_SPLIT"]);
  });

  it("two days before decisions: DEADLINE_NO_CONSENSUS on split or silent papers only", () => {
    const { phase, m } = firing("2030-03-01T23:59");
    expect(phase).toBe("discussion");
    const deadline = [...m.entries()].filter(([, r]) => r.includes("DEADLINE_NO_CONSENSUS")).map(([pid]) => pid);
    expect(deadline.sort((x, y) => x - y)).toEqual([3, 4, 5, 12]);
    expect(m.has(1)).toBe(false);
  });
});
