// Reviewing progress by tier (spec §10.4 D, PLAN M12): pure unit tests over
// builder fixtures. Synthetic data only.
import { describe, expect, it } from "vitest";
import { DEFAULT_TIER_PROGRESS_POLICY, loadConfig, type TierProgressPolicy } from "../../../src/config.js";
import { computeTierProgress, hotcrpReviewPath, type TierProgressReport } from "../../../src/modules/tier-progress/index.js";
import { analyze, indexSnapshot, type PersonView, type ReviewView, type SnapshotView } from "../../../src/rules/index.js";
import { DAY_MS } from "../../../src/rules/phase.js";
import { RULES_ENV, at, comment, contextAt, paper, review } from "../../fixtures/builder.js";

const DUE = at("2030-02-01T23:59");
const person = (email: string, tier = "senior", roles: string[] = ["pc"]): PersonView => ({ email, name: email.split("@")[0]!, tier, roles });
const P = {
  ac: "ac@example.org",
  chair: "chair@example.org",
  s1: "s1@example.org",
  s2: "s2@example.org",
  j1: "j1@example.org",
  r1: "r1@example.org",
  r2: "r2@example.org",
};
const people = [
  person(P.ac),
  person(P.chair, "senior", ["pc", "chair"]),
  person(P.s1),
  person(P.s2),
  person(P.j1, "junior"),
  person(P.r1, "reserve-active"),
  person(P.r2, "reserve-active"),
];
const empty = (rid: number, pid: number, email: string, firstSeenAt?: number): ReviewView => {
  const r = review({ rid, pid, email, status: "empty" });
  return firstSeenAt === undefined ? r : { ...r, firstSeenAt, versions: [{ ...r.versions[0]!, seenAt: firstSeenAt }] };
};

function world(over: Partial<SnapshotView> = {}): SnapshotView {
  return {
    papers: [paper(1), paper(2), paper(3)],
    people,
    acs: [1, 2, 3].map((pid) => ({ pid, email: P.ac })),
    reviews: [
      review({ rid: 10, pid: 1, email: P.ac, rtype: 5, status: "empty" }),
      review({ rid: 11, pid: 1, email: P.s1 }),
      review({ rid: 12, pid: 1, email: P.j1, words: 90, ordinal: "B" }),
      empty(13, 1, P.r1),
      review({ rid: 21, pid: 2, email: P.s2, ratedVague: true }),
      review({ rid: 22, pid: 2, email: P.j1, ratedShort: true, ordinal: "C" }),
      empty(23, 2, P.r2),
      review({ rid: 31, pid: 3, email: P.s1 }),
      review({ rid: 32, pid: 3, email: P.r1, words: 60, submittedAt: DUE + DAY_MS }),
    ],
    comments: [],
    ...over,
  };
}

function report(s: SnapshotView, now: string, policy: Partial<TierProgressPolicy> = {}, approx: number[] = []): TierProgressReport {
  const ctx = contextAt(now, { PCS_TIER_TAGS: "junior=junior,reserve-active=reserveactive" });
  const a = analyze(s, ctx);
  return computeTierProgress(
    {
      index: indexSnapshot(s),
      authored: new Map([
        [P.r1, [3]],
        [P.r2, [2, 9]],
      ]),
      approxRids: new Set(approx),
      reviewers: a.reviewers,
      tierOrder: ["senior", "junior", "reserve-active"],
    },
    ctx,
    { ...DEFAULT_TIER_PROGRESS_POLICY, reserveTiers: ["reserve-active"], ...policy },
  );
}
const state = (r: TierProgressReport) => Object.fromEntries(r.dropout.rows.map((d) => [`${d.person.email}@${d.pid}`, d.state]));

describe("outstanding and late by tier", () => {
  it("before the deadline nothing is late", () => {
    const r = report(world(), "2030-02-01T12:00");
    expect(r.deadlinePassed).toBe(false);
    expect(r.tiers.map((t) => [t.tier, t.outstanding, t.late])).toEqual([
      ["senior", 0, 0],
      ["junior", 0, 0],
      ["reserve-active", 2, 0],
    ]);
    expect(r.dropout.rows).toEqual([]);
    expect(r.tiers[2]!.reason).toMatch(/deadline not passed yet/);
  });

  it("after the deadline: late per tier, submitted-late, ACs left out, numbers in the reason", () => {
    const r = report(world(), "2030-02-03T12:00");
    const ra = r.tiers.find((t) => t.tier === "reserve-active")!;
    expect(ra).toMatchObject({ reviewers: 2, assigned: 3, submitted: 1, outstanding: 2, late: 2, latePeople: 2, submittedLate: 1 });
    expect(r.tiers.find((t) => t.tier === "senior")).toMatchObject({ reviewers: 2, assigned: 3, late: 0 });
    expect(ra.reason).toBe("1 of 3 submitted; 2 outstanding; 2 late (2 reviewers, deadline passed 1.5 days ago); 1 submitted after the deadline");
    expect(r.late.map((l) => [l.pid, l.person.email])).toEqual([
      [1, P.r1],
      [2, P.r2],
    ]);
  });

  it("a decided paper's outstanding review is not counted", () => {
    const s = world({ papers: [paper(1, { decision: "Rejected" }), paper(2), paper(3)] });
    expect(report(s, "2030-02-03T12:00").late.map((l) => l.pid)).toEqual([2]);
  });

  it("a review first seen after the deadline (not at the first sync) is outstanding but not late", () => {
    const s = world({ reviews: [...world().reviews, empty(14, 1, P.s2, DUE + DAY_MS)] });
    const r = report(s, "2030-02-04T12:00");
    expect(r.tiers[0]).toMatchObject({ outstanding: 1, late: 0, assignedAfterDue: 1 });
    // The same review present at the first sync (approximate first_seen_at) is late.
    const r2 = report(s, "2030-02-04T12:00", {}, [14]);
    expect(r2.tiers[0]).toMatchObject({ outstanding: 1, late: 1, assignedAfterDue: 0 });
  });
});

describe("reserve dropout escalation", () => {
  const mention = (cid: number, pid: number, email: string, time: number, who: string) => comment({ cid, pid, email, time, mentions: [who] });

  it("late, then pinged by an AC or chair @mention since the deadline", () => {
    expect(state(report(world(), "2030-02-03T12:00"))).toEqual({ [`${P.r1}@1`]: "late", [`${P.r2}@2`]: "late" });
    const s = world({
      comments: [
        mention(1, 1, P.ac, at("2030-02-02T10:00"), P.r1), // AC, after the deadline: a ping
        mention(2, 2, P.ac, at("2030-02-01T10:00"), P.r2), // before the deadline: not one
        mention(3, 2, P.s2, at("2030-02-02T11:00"), P.r2), // a reviewer, not an AC or chair: not one
      ],
    });
    const r = report(s, "2030-02-03T12:00");
    expect(state(r)).toEqual({ [`${P.r1}@1`]: "pinged", [`${P.r2}@2`]: "late" });
    expect(r.dropout.rows[0]).toMatchObject({ pingedBy: P.ac, pingedAt: at("2030-02-02T10:00") });
    expect(r.dropout.rows[0]!.reason).toMatch(/@mentioned by ac@example.org 1\.1 days ago/);
    const byChair = world({ comments: [mention(4, 2, P.chair, at("2030-02-02T11:00"), P.r2)] });
    expect(state(report(byChair, "2030-02-03T12:00"))[`${P.r2}@2`]).toBe("pinged");
  });

  it("replacement-needed strictly after PCS_RESERVE_DROPOUT_DAYS", () => {
    expect(state(report(world(), "2030-02-04T23:59"))[`${P.r1}@1`]).toBe("late"); // exactly 3.0 days
    expect(state(report(world(), "2030-02-05T00:00"))[`${P.r1}@1`]).toBe("replacement-needed");
    expect(state(report(world(), "2030-02-03T00:00", { dropoutDays: 1 }))[`${P.r1}@1`]).toBe("replacement-needed");
  });

  it("replaced once another reviewer is added on the paper after the deadline", () => {
    const s = world({ reviews: [...world().reviews, empty(15, 1, P.s2, at("2030-02-04T09:00"))] });
    const r = report(s, "2030-02-06T12:00");
    expect(state(r)[`${P.r1}@1`]).toBe("replaced");
    expect(r.dropout.rows.find((d) => d.pid === 1)!.replacedBy).toEqual([P.s2]);
    // Not before the replacement was seen, and not if it was there at the first sync.
    expect(state(report(s, "2030-02-04T08:00"))[`${P.r1}@1`]).toBe("late");
    expect(state(report(s, "2030-02-06T12:00", {}, [15]))[`${P.r1}@1`]).toBe("replacement-needed");
    expect(r.dropout.counts).toEqual({ late: 0, pinged: 0, "replacement-needed": 1, replaced: 1 });
  });
});

describe("reserve accountability, coaching, withholding", () => {
  it("accountability: own papers next to late, thin, and rated counts, as evidence", () => {
    const r = report(world(), "2030-02-03T12:00");
    expect(r.accountability.note).toMatch(/Evidence for a human decision/);
    const r1 = r.accountability.rows.find((a) => a.person.email === P.r1)!;
    expect(r1).toMatchObject({ ownPapers: [{ pid: 3 }], assigned: 2, submitted: 1, lateOutstanding: 1, submittedLate: 1, thin: 1, latePids: [1, 3], thinPids: [3] });
    expect(r1.summary).toBe(
      "authors #3; reviews: 1 of 2 submitted, 1 late and outstanding, 1 submitted after the deadline, 1 under 150 words, 0 rated short, 0 rated vague",
    );
    // #9 is not a live paper: it is not listed.
    expect(r.accountability.rows.find((a) => a.person.email === P.r2)!.ownPapers.map((p) => p.pid)).toEqual([2]);
    expect(r.accountability.rows.map((a) => a.person.email)).toEqual([P.r1, P.r2]);
  });

  it("coaching queue: junior reviews under the floor or rated short/vague, with HotCRP paths", () => {
    const r = report(world(), "2030-02-03T12:00");
    expect(r.coaching.rows.map((c) => [c.pid, c.person.email, c.reason, c.hotcrpPath])).toEqual([
      [1, P.j1, "90 words, under the coaching floor of 150", "/review/1B"],
      [2, P.j1, "250 words; rated short", "/review/2C"],
    ]);
    expect(report(world(), "2030-02-03T12:00", { coachMinWords: 80 }).coaching.rows.map((c) => c.pid)).toEqual([2]);
    expect(hotcrpReviewPath({ pid: 4, rid: 77, ordinal: null })).toBe("/review?p=4&r=77");
  });

  it("PCS_COACH_MIN_WORDS falls back to PCS_THRESH_MIN_WORDS", () => {
    expect(loadConfig({ ...RULES_ENV, PCS_THRESH_MIN_WORDS: "120" }).tierProgress!.coachMinWords).toBe(120);
    expect(loadConfig({ ...RULES_ENV, PCS_THRESH_MIN_WORDS: "120", PCS_COACH_MIN_WORDS: "200" }).tierProgress!.coachMinWords).toBe(200);
  });

  it("withhold draft only with the policy on, as a tag CSV of the late reserves' own undecided papers", () => {
    const off = report(world(), "2030-02-03T12:00");
    expect(off.withhold).toMatchObject({ enabled: false, rows: [], csv: "" });
    const on = report(world(), "2030-02-03T12:00", { withholdReviews: true, withholdTag: "held" });
    expect(on.withhold.rows.map((w) => [w.person.email, w.latePids, w.withheldPids])).toEqual([
      [P.r1, [1], [3]],
      [P.r2, [2], [2]],
    ]);
    expect(on.withhold.csv).toBe("paper,action,tag\n2,tag,held\n3,tag,held\n");
    expect(on.withhold.search).toBe("2 3");
    expect(on.withhold.note).toMatch(/never applies/);
  });
});

describe("participation by tier", () => {
  it("counts reviewers' comments on their own papers, and M4's discussion participation once it opens", () => {
    const s = world({
      comments: [
        comment({ cid: 1, pid: 1, email: P.j1, time: at("2030-02-03T10:00") }),
        comment({ cid: 2, pid: 1, email: P.ac, time: at("2030-02-03T11:00") }), // the AC: not a reviewer
        comment({ cid: 3, pid: 2, email: P.j1, time: at("2030-02-13T10:00") }),
        comment({ cid: 4, pid: 3, email: P.s1, time: at("2030-02-13T10:00"), draft: true }),
      ],
    });
    const early = report(s, "2030-02-05T12:00");
    expect(early.participation.discussionOpened).toBe(false);
    expect(early.participation.rows.map((p) => [p.tier, p.commenters, p.comments, p.share])).toEqual([
      ["senior", 0, 0, null],
      ["junior", 1, 1, null],
      ["reserve-active", 0, 0, null],
    ]);
    const later = report(s, "2030-02-20T12:00").participation.rows.find((p) => p.tier === "junior")!;
    expect(later).toMatchObject({ commenters: 1, comments: 2, discussionPapers: 2, discussionCommented: 1, share: 0.5 });
    expect(later.reason).toBe("1 of 1 reviewers have commented (2 comments on papers they review); since discussion opened, a comment on 1 of 2 papers");
  });
});
