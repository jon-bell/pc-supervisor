// Process report (spec §10.4 G, PLAN M13): pure unit tests for every metric,
// over builder fixtures. Synthetic data only.
import { describe, expect, it } from "vitest";
import type { EarlyRejectReport } from "../../../src/modules/early-reject/types.js";
import {
  agreementByTier,
  binWords,
  cellOf,
  decisionSide,
  depthByTier,
  earlyRejectYield,
  meritRange,
  meritsByTier,
  ratingsByTier,
  reserveSection,
  reviewFacts,
  tierOrder,
  timelinessByTier,
  type ReviewFact,
} from "../../../src/modules/report/compute.js";
import { summarizeQuickReject } from "../../../src/modules/report/quick-reject.js";
import type { QuickRejectReport } from "../../../src/modules/quickreject/types.js";
import type { TierProgressReport } from "../../../src/modules/tier-progress/types.js";
import { indexSnapshot, type PersonView, type SnapshotView } from "../../../src/rules/index.js";
import { DAY_MS } from "../../../src/rules/phase.js";
import { at, contextAt, paper, review } from "../../fixtures/builder.js";

const DUE = at("2030-02-01T23:59");

/** A fact with defaults; override what a test is about. */
function fact(o: Partial<ReviewFact> & { email: string; tier: string }): ReviewFact {
  return {
    pid: 1,
    rid: 1,
    rtype: 2,
    submitted: true,
    merit: 3,
    expertise: 3,
    words: 300,
    ratings: {},
    submittedAt: DUE - DAY_MS,
    assignedAfterDue: false,
    daysVsDue: -1,
    late: false,
    paperMean: null,
    absDev: null,
    side: null,
    onSide: null,
    ...o,
  };
}
const people = (tier: string, n: number, prefix = tier) => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}@example.org`).map((email) => ({ email, tier }));

describe("small cells", () => {
  it("suppresses a group with fewer than PCS_REPORT_MIN_CELL people, shows one with exactly that many", () => {
    expect(cellOf(4, 5)).toEqual({ people: null, suppressed: true });
    expect(cellOf(5, 5)).toEqual({ people: 5, suppressed: false });
    expect(cellOf(0, 1)).toEqual({ people: null, suppressed: true });
  });

  it("every per-tier table withholds all numbers of a small tier and says why", () => {
    const facts = [...people("senior", 5), ...people("junior", 4)].map((p, i) => fact({ ...p, rid: i + 1, pid: i + 1 }));
    const tiers = ["senior", "junior"];
    const rows = [
      depthByTier(facts, tiers, 5, 150),
      timelinessByTier(facts, tiers, 5),
      meritsByTier(facts, tiers, 5),
      ratingsByTier(facts, tiers, 5).rows,
      agreementByTier(facts, tiers, 5, 3),
    ];
    for (const table of rows) {
      const [senior, junior] = table;
      expect(senior).toMatchObject({ tier: "senior", people: 5, suppressed: false });
      expect(junior).toMatchObject({ tier: "junior", people: null, suppressed: true });
      for (const [k, v] of Object.entries(junior!)) if (!["tier", "suppressed", "reason"].includes(k)) expect(v, k).toBeNull();
      expect(junior!.reason).toBe("fewer than PCS_REPORT_MIN_CELL=5 people; numbers withheld");
    }
  });
});

describe("review facts", () => {
  const P: PersonView[] = [
    { email: "ac@example.org", name: "Ac", tier: "senior", roles: ["pc"] },
    { email: "s1@example.org", name: "S1", tier: "senior", roles: ["pc"] },
    { email: "s2@example.org", name: "S2", tier: "senior", roles: ["pc"] },
    { email: "j1@example.org", name: "J1", tier: "junior", roles: ["pc"] },
  ];
  const s: SnapshotView = {
    papers: [paper(1, { decision: "Accepted" }), paper(2, { decision: "Rejected (desk)" }), paper(3)],
    people: P,
    acs: [1, 2, 3].map((pid) => ({ pid, email: "ac@example.org" })),
    reviews: [
      review({ rid: 10, pid: 1, email: "ac@example.org", rtype: 5 }),
      review({ rid: 11, pid: 1, email: "s1@example.org", merit: 4, words: 400, rtype: 4 }),
      review({ rid: 12, pid: 1, email: "s2@example.org", merit: 2, words: 120, submittedAt: DUE + 2 * DAY_MS }),
      review({ rid: 13, pid: 1, email: "j1@example.org", merit: 3, words: 90, ratings: { short: 2, vague: 1 } }),
      review({ rid: 21, pid: 2, email: "s1@example.org", merit: 1 }),
      review({ rid: 22, pid: 2, email: "j1@example.org", merit: 4 }),
      review({ rid: 31, pid: 3, email: "s2@example.org", merit: 2 }),
      review({ rid: 32, pid: 3, email: "j1@example.org", status: "empty" }),
    ],
    comments: [],
  };
  const ctx = contextAt("2030-03-10T12:00");
  const facts = reviewFacts(indexSnapshot(s), ctx, { approxRids: new Set(), acceptDecisions: ["accept"] });
  const f = (rid: number) => facts.find((x) => x.rid === rid)!;

  it("leaves out metareviews and the AC's own reviews; tiers from people", () => {
    expect(facts.map((x) => x.rid)).toEqual([11, 12, 13, 21, 22, 31, 32]);
    expect(f(13).tier).toBe("junior");
    expect(f(13).ratings).toEqual({ short: 2, vague: 1 });
  });

  it("paper mean and deviation over the paper's submitted reviewer merits (2+)", () => {
    expect(f(11)).toMatchObject({ paperMean: 3, absDev: 1 });
    expect(f(13)).toMatchObject({ paperMean: 3, absDev: 0 });
    expect(f(21)).toMatchObject({ paperMean: 2.5, absDev: 1.5 });
    // pid 3 has a single merit: no mean.
    expect(f(31)).toMatchObject({ paperMean: null, absDev: null });
  });

  it("decision side by name prefix; on-side vs PCS_MERIT_ACCEPT_MIN", () => {
    expect(decisionSide("Accepted", ["accept"])).toBe("accept");
    expect(decisionSide("  ACCEPT (poster)", ["accept"])).toBe("accept");
    expect(decisionSide("Rejected", ["accept"])).toBe("reject");
    expect(decisionSide(null, ["accept"])).toBeNull();
    expect([f(11).onSide, f(12).onSide, f(13).onSide]).toEqual([true, false, true]);
    expect([f(21).onSide, f(22).onSide]).toEqual([true, false]);
    expect(f(31)).toMatchObject({ side: null, onSide: null });
  });

  it("timeliness: first submission vs REVIEW_DUE in days", () => {
    expect(f(12)).toMatchObject({ late: true });
    expect(f(12).daysVsDue).toBeCloseTo(2, 5);
    expect(f(11).late).toBe(false);
    expect(f(32)).toMatchObject({ submitted: false, submittedAt: null, daysVsDue: null, late: false, merit: null });
  });

  it("a review first seen after the deadline is a replacement, never late; one from the first sync is", () => {
    const late = { ...s, reviews: [...s.reviews, { ...review({ rid: 40, pid: 3, email: "s1@example.org", submittedAt: DUE + DAY_MS }), firstSeenAt: DUE + 1000 }] };
    const r = reviewFacts(indexSnapshot(late), ctx, { approxRids: new Set(), acceptDecisions: ["accept"] }).find((x) => x.rid === 40)!;
    expect(r).toMatchObject({ assignedAfterDue: true, late: false });
    const r2 = reviewFacts(indexSnapshot(late), ctx, { approxRids: new Set([40]), acceptDecisions: ["accept"] }).find((x) => x.rid === 40)!;
    expect(r2).toMatchObject({ assignedAfterDue: false, late: true });
  });

  it("tier order: configured first, then any other seen", () => {
    expect(tierOrder(["senior", "reciprocal"], facts)).toEqual(["senior", "reciprocal", "junior"]);
  });
});

describe("depth", () => {
  it("median, quartiles, mean, bins, and reviews under the floor; unsubmitted reviews left out", () => {
    const words = [50, 120, 180, 250, 450, 800, 1200];
    const facts = [
      ...words.map((w, i) => fact({ email: `s${(i % 5) + 1}@example.org`, tier: "senior", words: w, rid: i + 1 })),
      fact({ email: "s1@example.org", tier: "senior", submitted: false, words: 0, rid: 99 }),
    ];
    const [row] = depthByTier(facts, ["senior"], 5, 150);
    expect(row).toMatchObject({ people: 5, reviews: 7, median: 250, p25: 120, p75: 800, mean: 435.7, underFloor: 2 });
    expect(row!.bins!.map((b) => [b.label, b.count])).toEqual([
      ["0–99", 1],
      ["100–199", 2],
      ["200–399", 1],
      ["400–699", 1],
      ["700–999", 1],
      ["1000+", 1],
    ]);
    expect(row!.reason).toBe("7 submitted reviews by 5 reviewers: median 250 words (p25 120, p75 800); 2 under PCS_THRESH_MIN_WORDS=150");
  });

  it("bins cover every count exactly once", () => {
    const ws = [0, 99, 100, 999, 1000, 5000];
    expect(binWords(ws).reduce((a, b) => a + b.count, 0)).toBe(ws.length);
  });
});

describe("timeliness", () => {
  it("on time, late, not submitted, replacements, and the median days vs due", () => {
    const S = (i: number, o: Partial<ReviewFact>) => fact({ email: `s${i}@example.org`, tier: "senior", rid: 100 + i, ...o });
    const facts = [
      S(1, { daysVsDue: -3 }),
      S(2, { daysVsDue: -1 }),
      S(3, { daysVsDue: 2, late: true }),
      S(4, { submitted: false, submittedAt: null, daysVsDue: null }),
      S(5, { daysVsDue: 5, assignedAfterDue: true }),
    ];
    const [row] = timelinessByTier(facts, ["senior"], 5);
    expect(row).toMatchObject({ assigned: 5, submitted: 4, onTime: 2, late: 1, assignedAfterDue: 1, notSubmitted: 1, onTimeShare: 0.5, medianDaysVsDue: -1 });
    expect(row!.reason).toBe("2 of 4 reviews due by the deadline submitted on time (50%), 1 late, 1 not submitted; 1 assigned after the deadline; median 1.0 days before the deadline");
  });
});

describe("merit distribution", () => {
  it("one bin per merit value over the range seen in any tier; mean", () => {
    const facts = [
      ...[1, 2, 2, 4, 4].map((m, i) => fact({ email: `s${i + 1}@example.org`, tier: "senior", merit: m, rid: i + 1 })),
      ...[5, 3, 3, 3, 3].map((m, i) => fact({ email: `j${i + 1}@example.org`, tier: "junior", merit: m, rid: 10 + i })),
      fact({ email: "j1@example.org", tier: "junior", merit: null, submitted: false, rid: 20 }),
    ];
    expect(meritRange(facts)).toEqual([1, 2, 3, 4, 5]);
    const [s, j] = meritsByTier(facts, ["senior", "junior"], 5);
    expect(s!.bins!.map((b) => b.count)).toEqual([1, 2, 0, 2, 0]);
    expect(j!.bins!.map((b) => b.count)).toEqual([0, 0, 4, 0, 1]);
    expect([s!.reviews, s!.mean, j!.reviews, j!.mean]).toEqual([5, 2.6, 5, 3.4]);
    expect(s!.reason).toBe("5 merits: 1×1, 2×2, 3×0, 4×2, 5×0; mean 2.6");
  });
});

describe("review-rating flags", () => {
  const facts = [
    fact({ email: "s1@example.org", tier: "senior", ratings: { short: 2 }, rid: 1 }),
    fact({ email: "s2@example.org", tier: "senior", ratings: { short: 1, vague: 1 }, rid: 2 }),
    ...[3, 4, 5].map((i) => fact({ email: `s${i}@example.org`, tier: "senior", rid: i })),
    fact({ email: "s5@example.org", tier: "senior", ratings: { disrespectful: 1 }, submitted: false, rid: 6 }),
  ];
  it("sums flags received (the multiset counts) per tier, and per review", () => {
    const { enabled, names, rows } = ratingsByTier(facts, ["senior"], 5);
    expect(enabled).toBe(true);
    expect(names).toEqual(["short", "vague"]);
    expect(rows[0]).toMatchObject({ reviews: 5, rated: 2, counts: { short: 3, vague: 1 }, perReview: { short: 0.6, vague: 0.2 } });
    expect(rows[0]!.reason).toBe("2 of 5 submitted reviews rated; flags received: 3× short (0.6/review), 1× vague (0.2/review)");
  });
  it("shows nothing when ratings are off", () => {
    expect(ratingsByTier(facts, ["senior"], 5, false)).toEqual({ enabled: false, names: [], rows: [] });
  });
});

describe("score agreement", () => {
  it("mean absolute deviation, and the share on the decision's side", () => {
    const S = (i: number, o: Partial<ReviewFact>) => fact({ email: `s${i}@example.org`, tier: "senior", rid: i, ...o });
    const facts = [
      S(1, { absDev: 1, paperMean: 3, side: "accept", onSide: true }),
      S(2, { absDev: 0.5, paperMean: 2.5, side: "reject", onSide: false }),
      S(3, { absDev: 0, paperMean: 3, side: "accept", onSide: true }),
      S(4, { absDev: 1.5, paperMean: 2.5, side: null, onSide: null }),
      S(5, {}),
    ];
    const [row] = agreementByTier(facts, ["senior"], 5, 3);
    expect(row).toMatchObject({ reviews: 4, meanAbsDev: 0.75, decided: 3, onDecisionSide: 2 });
    expect(row!.share).toBeCloseTo(2 / 3);
    expect(row!.reason).toBe(
      "mean |merit − paper mean| 0.75 over 4 merits on papers with 2+ merits; 2 of 3 merits on decided papers on the decision's side (67%; accept side = merit ≥ PCS_MERIT_ACCEPT_MIN=3)",
    );
  });

  it("before any decision", () => {
    const facts = people("senior", 5).map((p, i) => fact({ ...p, rid: i, absDev: 0, paperMean: 3 }));
    expect(agreementByTier(facts, ["senior"], 5, 3)[0]!.reason).toMatch(/no decided papers yet$/);
  });
});

describe("reserve activation and dropout (from M12 tier-progress)", () => {
  const index = indexSnapshot({
    papers: [],
    acs: [],
    reviews: [],
    comments: [],
    people: [
      ...people("reciprocal", 6).map((p) => ({ ...p, name: p.email, roles: ["pc"] })),
      ...people("reserve-pool", 2, "pool").map((p) => ({ ...p, name: p.email, roles: [] })),
    ],
  });
  const tp = {
    tiers: [
      { tier: "senior", reviewers: 40, assigned: 100, submitted: 100, submittedLate: 0 },
      { tier: "reciprocal", reviewers: 6, assigned: 10, submitted: 7, submittedLate: 2 },
    ],
    dropout: { counts: { late: 1, pinged: 0, "replacement-needed": 1, replaced: 1 } },
  } as unknown as TierProgressReport;

  it("activation from the tiers when there is no invites import; dropout = (not submitted + late) / assigned", () => {
    const r = reserveSection(index, tp, { reserveTiers: ["reciprocal"], poolTier: "reserve-pool", minCell: 5, invites: null });
    expect(r).toMatchObject({ tiers: ["reciprocal", "reserve-pool"], people: 6, active: 6, pool: 2, activationRate: 0.75, assigned: 10, submitted: 7, notSubmitted: 3, submittedLate: 2, dropoutRate: 0.5 });
    expect(r.lateNow).toEqual({ late: 1, pinged: 0, "replacement-needed": 1, replaced: 1 });
    expect(r.reason).toBe("6 active of 8 designated (75%; no invites import); 3 of 10 reserve reviews not submitted and 2 submitted late (dropout 50%)");
  });

  it("activation from the invites import: activated among AC-approved candidates", () => {
    const inv = (e: string, ac: string, resp: string, act: number | null) => ({ candidate_email: e, ac_decision: ac, response: resp, activated_at: act });
    const r = reserveSection(index, tp, {
      reserveTiers: ["reciprocal"],
      poolTier: "reserve-pool",
      minCell: 5,
      invites: [inv("a@example.org", "approve", "accept", 1), inv("b@example.org", "approve", "decline", null), inv("c@example.org", "reject", "none", null), inv("d@example.org", "approve", "accept", 1)],
    });
    expect(r.invites).toEqual({ rows: 4, approved: 3, accepted: 2, declined: 1, activated: 2 });
    expect(r.activationRate).toBeCloseTo(2 / 3);
  });

  it("is suppressed with fewer than PCS_REPORT_MIN_CELL reserve reviewers", () => {
    const r = reserveSection(index, tp, { reserveTiers: ["reciprocal"], poolTier: "reserve-pool", minCell: 7, invites: null });
    expect(r).toMatchObject({ suppressed: true, people: null, active: null, dropoutRate: null, lateNow: null });
  });
});

describe("early-reject yield (from M12 early-reject)", () => {
  const index = indexSnapshot({
    papers: [paper(1, { decision: "Rejected" }), paper(2, { decision: "Accepted" }), paper(3), paper(4, { decision: "Rejected" })],
    people: [],
    acs: [],
    reviews: [],
    comments: [],
  });
  const er = (status: string, pids: number[], bumped: number[]) =>
    ({ status, policy: "reject_only", candidates: pids.map((pid) => ({ pid })), bumped, notBumped: pids.filter((p) => !bumped.includes(p)) }) as unknown as EarlyRejectReport;

  it("candidates, bumped, and how they ended (current decision)", () => {
    const y = earlyRejectYield(er("closed", [1, 2, 3], [2]), index, ["accept"]);
    expect(y).toMatchObject({ candidates: 3, bumped: 1, notBumped: 2, rejected: 1, accepted: 1, undecided: 1 });
    expect(y.yield).toBeCloseTo(1 / 3);
    expect(y.reason).toBe("3 candidates (reject_only); 1 bumped, 2 not bumped; 1 rejected in the end, 1 accepted, 1 undecided (yield 33%)");
  });

  it("unconfigured window", () => {
    const y = earlyRejectYield(er("unconfigured", [], []), index, ["accept"]);
    expect(y).toMatchObject({ candidates: 0, yield: null });
    expect(y.reason).toMatch(/not configured/);
  });
});

describe("quick/desk reject (from M11)", () => {
  it("summarizes the tracker's items and appeal states", () => {
    const item = (acDecision: string, chairAction: string) => ({ acDecision, chairAction });
    const r = {
      items: [item("reject", "desk-reject"), item("reject", "desk-reject"), item("reject", "none"), item("keep", "none"), item("reject", "keep"), item("none", "none")],
      counts: { byAppeal: { none: 3, requested: 1, upheld: 1, overturned: 1 }, qrReviews: 12, qrReviewsSubmitted: 10, overdueReviews: 2 },
    } as unknown as QuickRejectReport;
    const s = summarizeQuickReject(r);
    expect(s).toEqual({
      available: true,
      queued: 6,
      acReject: 4,
      deskRejected: 2,
      kept: 2,
      reviews: { assigned: 12, submitted: 10, overdue: 2 },
      appeals: { filed: 3, upheld: 1, overturned: 1, pending: 1 },
      reason:
        "6 papers in the quick-reject queue: 4 AC reject, 2 desk-rejected by the chair, 2 kept; 3 appeals (1 upheld, 1 overturned, 1 pending); 10 of 12 quick-reject reviews submitted, 2 overdue",
    });
  });
});
