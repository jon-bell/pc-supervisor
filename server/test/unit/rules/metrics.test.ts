// Per-AC and per-reviewer metrics, outliers, and the burndown.
import { describe, expect, it } from "vitest";
import { computeAcMetrics, dayBuckets } from "../../../src/rules/ac-metrics.js";
import { computeBurndown } from "../../../src/rules/burndown.js";
import { evaluateAll } from "../../../src/rules/evaluate.js";
import { median, percentile } from "../../../src/rules/facts.js";
import type { SnapshotView } from "../../../src/rules/model.js";
import { DAY_MS } from "../../../src/rules/phase.js";
import { computeOutliers, computeReviewerMetrics } from "../../../src/rules/reviewer-metrics.js";
import { at, comment, contextAt, day, DISCUSSION_OPEN, paper, review } from "../../fixtures/builder.js";
import { E, GOLDEN_NOW, goldenSnapshot } from "../../fixtures/golden.js";

const AC = "ac@example.org";
const A = "ra@example.org";
const B = "rb@example.org";
const MID = contextAt(GOLDEN_NOW);

function snap(over: Partial<SnapshotView>): SnapshotView {
  return {
    papers: [paper(1)],
    people: [
      { email: AC, name: "Ace Chair", tier: "senior", roles: ["pc"] },
      { email: A, name: "Ria A", tier: "junior", roles: ["pc"] },
      { email: B, name: "Rob B", tier: "senior", roles: ["pc"] },
    ],
    acs: [{ pid: 1, email: AC }],
    reviews: [review({ rid: 1, pid: 1, email: A }), review({ rid: 2, pid: 1, email: B })],
    comments: [],
    ...over,
  };
}

describe("stats helpers", () => {
  it("median and nearest-rank percentile", () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(percentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 10)).toBe(10);
    expect(percentile([5], 10)).toBe(5);
  });
  it("dayBuckets", () => {
    expect(dayBuckets(0, 0)).toBe(0);
    expect(dayBuckets(0, 1)).toBe(1);
    expect(dayBuckets(0, DAY_MS)).toBe(1);
    expect(dayBuckets(0, DAY_MS + 1)).toBe(2);
  });
});

describe("AC metrics", () => {
  it("golden AC-busy: time to first post, nudges, sparkline", () => {
    const ev = evaluateAll(goldenSnapshot(), MID);
    const busy = computeAcMetrics(ev, MID).find((a) => a.email === E.acBusy)!;
    // Day +1 at 09:00 on every paper; the clock starts at DISCUSSION_OPEN.
    expect(busy.timeToFirstPost).toEqual({ medianDays: 1.375, posted: 6, waiting: 0 });
    // 7 comments: all day +1 posts precede any reviewer comment (proxy), plus the day +3 @mention.
    expect(busy.nudges).toEqual({ total: 7, mentions: 1, proxy: 6 });
    expect(busy.activity.daily).toHaveLength(15);
    expect(busy.activity.daily[1]).toBe(6);
    expect(busy.activity.daily[3]).toBe(1);
    expect(busy.metareview).toMatchObject({ byStatus: { complete: 1, empty: 5 }, submitted: 1, of: 6 });
    expect(busy.stale).toBe(0);
  });

  it("golden AC-idle / AC-normal stale counts", () => {
    const ev = evaluateAll(goldenSnapshot(), MID);
    const acs = computeAcMetrics(ev, MID);
    expect(acs.map((a) => a.email)).toEqual([E.acBusy, E.acIdle, E.acNormal]);
    expect(acs.find((a) => a.email === E.acIdle)!.stalePids).toEqual([5]);
    expect(acs.find((a) => a.email === E.acNormal)!.stalePids).toEqual([6]);
  });

  it("time to first post starts at the last review landing when that is later", () => {
    const late = review({ rid: 2, pid: 1, email: B, submittedAt: day(4) });
    const s = snap({ reviews: [review({ rid: 1, pid: 1, email: A }), late], comments: [comment({ cid: 1, pid: 1, email: AC, time: day(6) })] });
    const m = computeAcMetrics(evaluateAll(s, MID), MID)[0]!;
    expect(m.timeToFirstPost.medianDays).toBe(2);
  });

  it("a comment after every reviewer has spoken is not a nudge", () => {
    const cs = [
      comment({ cid: 1, pid: 1, email: A, time: day(1) }),
      comment({ cid: 2, pid: 1, email: B, time: day(2) }),
      comment({ cid: 3, pid: 1, email: AC, time: day(3) }),
      comment({ cid: 4, pid: 1, email: AC, time: day(4), mentions: [B] }),
    ];
    const m = computeAcMetrics(evaluateAll(snap({ comments: cs }), MID), MID)[0]!;
    expect(m.nudges).toEqual({ total: 1, mentions: 1, proxy: 0 });
  });

  it("before discussion: no coverage share, empty sparkline", () => {
    const ctx = contextAt("2030-02-05T12:00");
    const m = computeAcMetrics(evaluateAll(snap({}), ctx), ctx)[0]!;
    expect(m.coverage.share).toBeNull();
    expect(m.activity.daily).toEqual([]);
    expect(m.timeToFirstPost.waiting).toBe(0);
  });
});

describe("reviewer metrics", () => {
  it("ping episodes: answered delay, merged pings, unanswered age threshold", () => {
    const cs = [
      comment({ cid: 1, pid: 1, email: AC, time: day(1) }), // ping A and B
      comment({ cid: 2, pid: 1, email: A, time: day(3) }), // A answers after 2 days
      comment({ cid: 3, pid: 1, email: AC, time: day(5), mentions: [A] }), // pings again
      comment({ cid: 4, pid: 1, email: A, time: day(6) }), // answered after 1 day
    ];
    const ev = evaluateAll(snap({ comments: cs }), MID);
    const ms = computeReviewerMetrics(ev, MID);
    const a = ms.find((m) => m.email === A)!;
    expect(a.responsiveness).toEqual({ medianDays: 1.5, answered: 2, unanswered: [], open: [] });
    const b = ms.find((m) => m.email === B)!;
    // B: one episode from day +1 (both AC comments merge), never answered.
    expect(b.responsiveness.unanswered).toEqual([
      { pid: 1, since: day(1), ageDays: 13, pings: 2, mentionedAt: null },
    ]);
    expect(b.responsiveness.open).toEqual(b.responsiveness.unanswered);
  });

  it("boundary: a ping exactly PING_DAYS old is not yet unanswered", () => {
    const t = day(5);
    const s = snap({ comments: [comment({ cid: 1, pid: 1, email: AC, time: t, mentions: [A] })] });
    const at3 = contextAt(t + 3 * DAY_MS);
    const r3 = computeReviewerMetrics(evaluateAll(s, at3), at3).find((m) => m.email === A)!.responsiveness;
    expect(r3.unanswered).toEqual([]);
    // Still an open ping (the person page lists it), just not over the bar.
    expect(r3.open).toEqual([{ pid: 1, since: t, ageDays: 3, pings: 1, mentionedAt: t }]);
    const after = contextAt(t + 3 * DAY_MS + 1);
    expect(computeReviewerMetrics(evaluateAll(s, after), after).find((m) => m.email === A)!.responsiveness.unanswered).toHaveLength(1);
  });

  it("depth vs PC median, bottom decile, ratings; movement incl. expertise", () => {
    const rs = [
      review({ rid: 1, pid: 1, email: A, words: 100, ratings: { vague: 2, good: 1 }, moves: [{ at: day(2), expertise: 4 }] }),
      review({ rid: 2, pid: 1, email: B, words: 300 }),
      ...Array.from({ length: 10 }, (_, i) => review({ rid: 10 + i, pid: 2, email: `rx${i}@example.org`, words: 200 + i })),
    ];
    const s = snap({ papers: [paper(1), paper(2)], reviews: rs });
    const ms = computeReviewerMetrics(evaluateAll(s, MID), MID);
    const a = ms.find((m) => m.email === A)!;
    expect(a.depth).toEqual({
      medianWords: 100,
      pcMedianWords: 204.5,
      bottomDecile: 1,
      thin: 1,
      ratedThin: 1,
      flaggedPids: [1],
    });
    expect(a.ratings).toMatchObject({ received: { good: 1, vague: 2 }, negative: 2, good: 1, negativePids: [1], repeated: false });
    expect(a.movement).toEqual({ reviews: 1, pids: [1] });
    const out = computeOutliers(ms);
    expect(out.thin).toEqual({ junior: [expect.objectContaining({ email: A, count: 1, pids: [1] })] });
    expect(out.thin.junior![0]!.detail).toBe(
      "1 under the word minimum, 1 in the PC's bottom decile, 1 flagged short/vague; median 100 words vs PC 204.5",
    );
    expect(out.flagged).toEqual({});
  });

  it("repeatedly flagged: negative rating flags on >= PCS_THRESH_FLAGGED_PAPERS papers", () => {
    const rs = [
      review({ rid: 1, pid: 1, email: A, ratings: { short: 1 } }),
      review({ rid: 2, pid: 2, email: A, ratings: { disrespectful: 1, good: 1 } }),
      review({ rid: 3, pid: 3, email: A, ratings: { good: 2 } }),
      review({ rid: 4, pid: 1, email: B, ratings: { short: 1, vague: 1 } }),
    ];
    const s = snap({ papers: [paper(1), paper(2), paper(3)], reviews: rs });
    const ms = computeReviewerMetrics(evaluateAll(s, MID), MID);
    const a = ms.find((m) => m.email === A)!;
    expect(a.ratings).toMatchObject({ received: { good: 3, short: 1, disrespectful: 1 }, negative: 2, good: 3, negativePids: [1, 2], repeated: true });
    // B: two flags, one paper; under the bar.
    expect(ms.find((m) => m.email === B)!.ratings).toMatchObject({ negative: 2, negativePids: [1], repeated: false });
    const out = computeOutliers(ms);
    expect(out.flagged).toEqual({ junior: [expect.objectContaining({ email: A, count: 2, pids: [1, 2] })] });
    expect(out.flagged.junior![0]!.detail).toBe("negative rating flags on 2 papers: 1× short, 1× disrespectful; 3× good");
    // Boundary: the bar at 3 papers drops A.
    const ctx3 = contextAt(MID.now, { PCS_THRESH_FLAGGED_PAPERS: "3" });
    expect(computeOutliers(computeReviewerMetrics(evaluateAll(s, ctx3), ctx3)).flagged).toEqual({});
    // Ratings off: no rating summary, nobody listed.
    const off = computeReviewerMetrics(evaluateAll({ ...s, ratingsEnabled: false }, MID), MID);
    expect(off.every((m) => m.ratings === null)).toBe(true);
    expect(computeOutliers(off).flagged).toEqual({});
  });

  it("participation share and late reviews", () => {
    const rs = [review({ rid: 1, pid: 1, email: A }), review({ rid: 2, pid: 2, email: A, status: "draft" })];
    const s = snap({ papers: [paper(1), paper(2)], acs: [], reviews: rs, comments: [comment({ cid: 1, pid: 1, email: A, time: day(2) })] });
    const a = computeReviewerMetrics(evaluateAll(s, MID), MID)[0]!;
    expect(a.participation).toEqual({ papers: 2, commented: 1, share: 0.5 });
    expect(a.outstanding).toEqual([2]);
    expect(a.late).toBe(true);
    const before = contextAt("2030-01-30T12:00");
    expect(computeReviewerMetrics(evaluateAll(s, before), before)[0]!.late).toBe(false);
  });

  it("outlier lists only include people over the bar, grouped by tier", () => {
    const ms = computeReviewerMetrics(evaluateAll(goldenSnapshot(), MID), MID);
    const out = computeOutliers(ms);
    for (const tiers of Object.values(out)) {
      for (const [tier, entries] of Object.entries(tiers)) {
        for (const e of entries) {
          expect(e.count).toBeGreaterThanOrEqual(1);
          expect(e.tier).toBe(tier);
        }
      }
    }
    expect(out.thin.senior?.map((e) => e.email)).toEqual([E.hal]);
  });
});

describe("burndown", () => {
  it("golden: tracks splits and the pid 1 decision over time", () => {
    const ev = evaluateAll(goldenSnapshot(), MID);
    const pts = computeBurndown(ev.facts.values(), MID, { start: DISCUSSION_OPEN });
    expect(pts).toHaveLength(16); // days 0..14 + now
    expect(pts[0]).toEqual({ t: DISCUSSION_OPEN, undecided: 13, noConsensus: 3 });
    expect(pts[11]!.undecided).toBe(12); // decision seen day +10 12:00
    expect(pts.at(-1)).toEqual({ t: MID.now, undecided: 12, noConsensus: 3 });
  });

  it("reconstructs merits from version history", () => {
    // 2/4 at submission, then the low reviewer moves to 3 on day +4: no longer split.
    const rs = [
      review({ rid: 1, pid: 1, email: A, merit: 2, moves: [{ at: day(4), merit: 3 }] }),
      review({ rid: 2, pid: 1, email: B, merit: 4, submittedAt: at("2030-02-03T10:00") }),
    ];
    const s = snap({ reviews: rs });
    const ev = evaluateAll(s, MID);
    const pts = computeBurndown(ev.facts.values(), MID);
    const at0 = pts.find((p) => p.t === at("2030-02-01T23:59"))!;
    expect(at0.noConsensus).toBe(0); // only one review in yet
    expect(pts.find((p) => p.t === at("2030-02-03T23:59"))!.noConsensus).toBe(1);
    expect(pts.at(-1)!.noConsensus).toBe(0);
  });
});
