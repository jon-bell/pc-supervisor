// PLAN.md golden table, encoded against the in-memory fixture.
import { describe, expect, it } from "vitest";
import { analyze } from "../../../src/rules/index.js";
import { contextAt, day } from "../../fixtures/builder.js";
import { E, GOLDEN_EXPECTED, GOLDEN_NOW, GOLDEN_NOW_LATE, goldenSnapshot } from "../../fixtures/golden.js";

const ctx = contextAt(GOLDEN_NOW);
const a = analyze(goldenSnapshot(), ctx);
const fired = (pid: number) => a.evaluation.byPid.get(pid)!.fired.map((f) => f.rule).sort();
const reason = (pid: number, rule: string) => a.evaluation.byPid.get(pid)!.fired.find((f) => f.rule === rule)?.reason;

describe(`golden at ${GOLDEN_NOW}`, () => {
  it("is mid-discussion", () => {
    expect(a.phase).toBe("discussion");
  });

  for (const [pid, rules] of Object.entries(GOLDEN_EXPECTED)) {
    it(`pid ${pid} fires exactly ${rules.length ? rules.join(", ") : "nothing"}`, () => {
      expect(fired(Number(pid))).toEqual([...rules].sort());
    });
  }

  it("writes reasons with the actual numbers", () => {
    expect(reason(2, "MISSING_REVIEWS")).toBe(
      "2 of 3 required reviews complete; 1 assigned review not submitted; reviews were due 24.5 days ago",
    );
    expect(reason(3, "SPLIT")).toBe("merit 2/4/4 (range 2 >= 2; scores on both sides of 3)");
    expect(reason(4, "UNRESOLVED_SPLIT")).toBe(
      "scores 2/4/4; no movement since discussion opened 14.5 days ago (limit 5 days)",
    );
    expect(reason(5, "SILENT_DISCUSSION")).toBe("0 comments since discussion opened 14.5 days ago");
    expect(reason(5, "GONE_QUIET")).toMatch(/^no in-HotCRP activity for 14\.5 days since discussion opened \(limit 4 days\); last activity 3\d\.\d days ago$/);
    expect(reason(6, "GONE_QUIET")).toBe("no in-HotCRP activity for 12 days (limit 4 days); last activity 12 days ago");
    expect(reason(7, "AC_ABSENT")).toBe("no AC comment since discussion opened 14.5 days ago (1 AC)");
    expect(reason(8, "CHAMPION_MISSING")).toBe(
      "top merit 5 (1 reviewer); no comment from that reviewer since discussion opened",
    );
    expect(reason(9, "LOW_EXPERTISE")).toBe("expertise 2/2/1; none >= 3");
    expect(reason(10, "THIN_REVIEWS")).toBe("1 of 3 reviews thin (min 150 words): B: 35 words");
    expect(reason(11, "RESPONSE_UNADDRESSED")).toBe("author response posted 17 days ago; 0 reviewer comments since");
  });

  it("orders triage by severity, then pid", () => {
    const top = a.evaluation.results.slice(0, 4).map((r) => [r.pid, r.severity]);
    expect(top).toEqual([
      [5, 7],
      [4, 5],
      [2, 3],
      [3, 3],
    ]);
    expect(a.evaluation.results.at(-1)).toMatchObject({ pid: 1, severity: 0 });
  });
});

describe(`golden at ${GOLDEN_NOW_LATE}`, () => {
  const late = analyze(goldenSnapshot(), contextAt(GOLDEN_NOW_LATE));
  it("pid 12 includes DEADLINE_NO_CONSENSUS; pid 1 fires nothing", () => {
    const p12 = late.evaluation.byPid.get(12)!.fired.map((f) => f.rule);
    expect(p12).toContain("DEADLINE_NO_CONSENSUS");
    expect(late.evaluation.byPid.get(12)!.fired.find((f) => f.rule === "DEADLINE_NO_CONSENSUS")!.reason).toBe(
      "decisions due in 2.5 days (window 3 days); no decision; split (2/4/4)",
    );
    expect(late.evaluation.byPid.get(1)!.fired).toEqual([]);
  });
  it("no DEADLINE_NO_CONSENSUS at the primary instant", () => {
    expect(a.evaluation.results.flatMap((r) => r.fired).some((f) => f.rule === "DEADLINE_NO_CONSENSUS")).toBe(false);
  });
});

describe("golden people facts", () => {
  const rev = (email: string) => a.reviewers.find((r) => r.email === email)!;
  const ac = (email: string) => a.acs.find((x) => x.email === email)!;

  it("R-silent tops silent-on-split with 3 and is junior", () => {
    expect(rev(E.silent).silentOnSplit).toEqual([3, 4, 12]);
    expect(rev(E.silent).tier).toBe("junior");
    const all = Object.values(a.outliers.silentOnSplit).flat();
    expect(Math.max(...all.map((e) => e.count))).toBe(3);
    expect(all.filter((e) => e.count === 3).map((e) => e.email)).toEqual([E.silent]);
    expect(a.outliers.silentOnSplit.junior?.[0]).toMatchObject({ email: E.silent, count: 3 });
    expect(a.outliers.silentOnSplit.senior?.map((e) => e.email)).toEqual([E.pinged]);
  });

  it("R-pinged has an unanswered @mention ping of 11+ days on pid 4", () => {
    const u = rev(E.pinged).responsiveness.unanswered;
    expect(u).toHaveLength(1);
    const p = u[0]!;
    expect(p.pid).toBe(4);
    expect(p.mentionedAt).toBe(day(3, 9));
    expect((ctx.now - p.mentionedAt!) / 86_400_000).toBeGreaterThanOrEqual(11);
    expect(a.outliers.unansweredPings.senior?.some((e) => e.email === E.pinged)).toBe(true);
  });

  it("AC-busy: 6 papers, 5 flagged, commenting on all", () => {
    const b = ac(E.acBusy);
    expect(b.pids).toEqual([1, 3, 4, 8, 9, 10]);
    expect(b.load).toBe(6);
    expect(b.flagged).toBe(5);
    expect(b.flaggedPids).toEqual([3, 4, 8, 9, 10]);
    expect(b.coverage).toEqual({ covered: 6, of: 6, share: 1 });
    expect(b.discussionComments).toBe(7);
    expect(b.nudges.mentions).toBe(1);
  });

  it("AC-idle: 2 papers, 0 comments, both flagged", () => {
    const i = ac(E.acIdle);
    expect(i.pids).toEqual([5, 7]);
    expect(i.flagged).toBe(2);
    expect(i.discussionComments).toBe(0);
    expect(i.coverage).toEqual({ covered: 0, of: 2, share: 0 });
    expect(i.timeToFirstPost).toEqual({ medianDays: null, posted: 0, waiting: 2 });
    expect(i.activity.daily.every((n) => n === 0)).toBe(true);
    // Distinguishable from AC-busy by load, not just by flag count.
    expect(i.load).toBeLessThan(ac(E.acBusy).load);
  });

  it("AC-normal holds 2, 6, 11, 12", () => {
    expect(ac(E.acNormal).pids).toEqual([2, 6, 11, 12]);
  });

  it("the pid 2 laggard is reciprocal and late", () => {
    const r = rev(E.recip);
    expect(r.tier).toBe("reciprocal");
    expect(r.late).toBe(true);
    expect(r.outstanding).toEqual([2]);
    expect(a.outliers.late).toEqual({ reciprocal: [expect.objectContaining({ email: E.recip, count: 1 })] });
  });

  it("everyone else is senior", () => {
    const tiers = new Set(a.reviewers.filter((r) => r.email !== E.silent && r.email !== E.recip).map((r) => r.tier));
    expect([...tiers]).toEqual(["senior"]);
  });

  it("burndown: papers without consensus are 3, 4, 12 now", () => {
    const last = a.burndown.at(-1)!;
    expect(last.t).toBe(ctx.now);
    expect(last.undecided).toBe(11);
    expect(last.noConsensus).toBe(3);
  });
});
