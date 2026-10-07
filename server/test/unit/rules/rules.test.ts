// Per-rule positive, negative, and boundary tests (spec §5c).
import { describe, expect, it } from "vitest";
import type { RuleContext } from "../../../src/rules/context.js";
import { evaluatePaper } from "../../../src/rules/evaluate.js";
import { paperFacts, type PaperBundle } from "../../../src/rules/facts.js";
import type { CommentView, PaperView, ReviewView } from "../../../src/rules/model.js";
import { DAY_MS } from "../../../src/rules/phase.js";
import * as R from "../../../src/rules/rules.js";
import { at, comment, contextAt, day, DISCUSSION_OPEN, paper, review } from "../../fixtures/builder.js";

const AC = "ac@example.org";
const A = "ra@example.org";
const B = "rb@example.org";
const C = "rc@example.org";
const MID = contextAt("2030-02-26T12:00");

let nextCid = 1;
const cm = (email: string, time: number, extra: Partial<Parameters<typeof comment>[0]> = {}) =>
  comment({ cid: nextCid++, pid: 1, email, time, ...extra });

function three(merits: [number, number, number] = [3, 3, 4], over: Partial<Parameters<typeof review>[0]>[] = []) {
  return [A, B, C].map((email, i) =>
    review({ rid: i + 1, pid: 1, email, merit: merits[i]!, ordinal: "ABC"[i]!, ...over[i] }),
  );
}

function bundle(o: { reviews?: ReviewView[]; comments?: CommentView[]; acs?: string[]; paper?: Partial<PaperView> } = {}): PaperBundle {
  return {
    paper: paper(1, o.paper),
    acs: o.acs ?? [AC],
    reviews: o.reviews ?? three(),
    comments: [...(o.comments ?? [])].sort((x, y) => x.time - y.time),
  };
}

const run = (rule: R.Rule, b: PaperBundle, ctx: RuleContext = MID) => rule(paperFacts(b, ctx), ctx);
/** A healthy discussion: AC + every reviewer commented recently. */
const lively = () => [cm(AC, day(13)), cm(A, day(13)), cm(B, day(13)), cm(C, day(13))];

describe("MISSING_REVIEWS", () => {
  const two = () => [...three().slice(0, 2), review({ rid: 3, pid: 1, email: C, status: "draft" })];
  it("fires after the deadline with fewer than required", () => {
    expect(run(R.missingReviews, bundle({ reviews: two() }))).toMatch(/^2 of 3 required reviews complete; 1 assigned review not submitted/);
  });
  it("does not fire with all reviews in", () => {
    expect(run(R.missingReviews, bundle())).toBeNull();
  });
  it("boundary: not at REVIEW_DUE exactly, yes one ms later", () => {
    const due = at("2030-02-01T23:59");
    expect(run(R.missingReviews, bundle({ reviews: two() }), contextAt(due))).toBeNull();
    expect(run(R.missingReviews, bundle({ reviews: two() }), contextAt(due + 1))).not.toBeNull();
  });
  it("honors PCS_REVIEWS_REQUIRED", () => {
    expect(run(R.missingReviews, bundle({ reviews: two() }), contextAt(MID.now, { PCS_REVIEWS_REQUIRED: "2" }))).toBeNull();
  });
  it("delivered and approved count as submitted; AC reviews don't count", () => {
    const rs = [
      review({ rid: 1, pid: 1, email: A, status: "delivered" }),
      review({ rid: 2, pid: 1, email: B, status: "approved" }),
      review({ rid: 3, pid: 1, email: AC, rtype: 5 }),
    ];
    expect(run(R.missingReviews, bundle({ reviews: rs }))).toMatch(/^2 of 3 required reviews complete; no other reviewer assigned/);
  });
});

describe("SPLIT", () => {
  it("fires when scores straddle MERIT_ACCEPT_MIN", () => {
    expect(run(R.split, bundle({ reviews: three([2, 3, 3]) }))).toBe("merit 2/3/3 (scores on both sides of 3)");
  });
  it("does not fire on 5/3/3 (range 2 < 3, all accept side) or 2/2/2", () => {
    expect(run(R.split, bundle({ reviews: three([5, 3, 3]) }))).toBeNull();
    expect(run(R.split, bundle({ reviews: three([2, 2, 2]) }))).toBeNull();
  });
  it("boundary: range equal to PCS_THRESH_SPLIT_RANGE fires, one less doesn't", () => {
    const ctx = contextAt(MID.now, { PCS_MERIT_ACCEPT_MIN: "1" });
    expect(run(R.split, bundle({ reviews: three([2, 5, 4]) }), ctx)).toBe("merit 2/5/4 (range 3 >= 3)");
    expect(run(R.split, bundle({ reviews: three([2, 4, 4]) }), ctx)).toBeNull();
    const ctx2 = contextAt(MID.now, { PCS_THRESH_SPLIT_RANGE: "2" });
    expect(run(R.split, bundle({ reviews: three([5, 3, 3]) }), ctx2)).toBe("merit 5/3/3 (range 2 >= 2)");
  });
  it("needs two submitted merits", () => {
    const rs = [review({ rid: 1, pid: 1, email: A, merit: 1 }), review({ rid: 2, pid: 1, email: B, merit: 5, status: "draft" })];
    expect(run(R.split, bundle({ reviews: rs }))).toBeNull();
  });
});

describe("UNRESOLVED_SPLIT", () => {
  const splitPaper = (moves: { at: number; merit?: number; expertise?: number }[] = []) =>
    bundle({ reviews: three([2, 4, 4], [{ moves }]) });
  it("fires when split with no movement after the window", () => {
    expect(run(R.unresolvedSplit, splitPaper())).toBe(
      "scores 2/4/4; no movement since discussion opened 14.5 days ago (limit 5 days)",
    );
  });
  it("movement since DISCUSSION_OPEN suppresses it", () => {
    expect(run(R.unresolvedSplit, splitPaper([{ at: day(5), merit: 3 }, { at: day(6), merit: 2 }]))).toBeNull();
  });
  it("movement before DISCUSSION_OPEN, or expertise-only, does not count", () => {
    expect(run(R.unresolvedSplit, splitPaper([{ at: DISCUSSION_OPEN - 1, merit: 2 }]))).not.toBeNull();
    expect(run(R.unresolvedSplit, splitPaper([{ at: day(3), expertise: 4 }]))).not.toBeNull();
  });
  it("boundary: exactly UNRESOLVED_DAYS into discussion doesn't fire; just after does", () => {
    const edge = DISCUSSION_OPEN + 5 * DAY_MS;
    expect(run(R.unresolvedSplit, splitPaper(), contextAt(edge))).toBeNull();
    expect(run(R.unresolvedSplit, splitPaper(), contextAt(edge + 1))).not.toBeNull();
  });
  it("not without a split", () => {
    expect(run(R.unresolvedSplit, bundle())).toBeNull();
  });
});

describe("SILENT_DISCUSSION", () => {
  it("fires with no comments since discussion opened", () => {
    expect(run(R.silentDiscussion, bundle())).toBe("0 comments since discussion opened 14.5 days ago");
  });
  it("one AC comment is enough", () => {
    expect(run(R.silentDiscussion, bundle({ comments: [cm(AC, day(1))] }))).toBeNull();
  });
  it("drafts, author responses, and pre-discussion comments don't count", () => {
    const cs = [
      cm(A, day(2), { draft: true }),
      cm("author@example.org", day(2), { isResponse: true }),
      cm(B, DISCUSSION_OPEN - 1),
    ];
    expect(run(R.silentDiscussion, bundle({ comments: cs }))).not.toBeNull();
  });
  it("boundary: a comment exactly at DISCUSSION_OPEN counts; not before discussion", () => {
    expect(run(R.silentDiscussion, bundle({ comments: [cm(A, DISCUSSION_OPEN)] }))).toBeNull();
    expect(run(R.silentDiscussion, bundle(), contextAt(DISCUSSION_OPEN - 1))).toBeNull();
    expect(run(R.silentDiscussion, bundle(), contextAt(DISCUSSION_OPEN))).toBe("0 comments since discussion opened 0 days ago");
  });
});

describe("GONE_QUIET", () => {
  it("fires when the last activity is older than STALE_DAYS", () => {
    expect(run(R.goneQuiet, bundle({ comments: [cm(A, day(2))] }))).toBe(
      "no in-HotCRP activity for 12 days (limit 4 days); last activity 12 days ago",
    );
  });
  it("AC comments count as activity; author responses don't", () => {
    expect(run(R.goneQuiet, bundle({ comments: [cm(AC, day(13))] }))).toBeNull();
    const resp = cm("author@example.org", day(13), { isResponse: true });
    expect(run(R.goneQuiet, bundle({ comments: [cm(A, day(2)), resp] }))).not.toBeNull();
  });
  it("a review edit counts as activity", () => {
    expect(run(R.goneQuiet, bundle({ reviews: three([3, 3, 4], [{ moves: [{ at: day(12), merit: 4 }] }]) }))).toBeNull();
  });
  it("boundary: exactly STALE_DAYS quiet doesn't fire; one ms more does", () => {
    const last = day(10);
    const b = bundle({ comments: [cm(A, last)] });
    expect(run(R.goneQuiet, b, contextAt(last + 4 * DAY_MS))).toBeNull();
    expect(run(R.goneQuiet, b, contextAt(last + 4 * DAY_MS + 1))).not.toBeNull();
  });
  it("measures from DISCUSSION_OPEN at the latest", () => {
    expect(run(R.goneQuiet, bundle(), contextAt(DISCUSSION_OPEN + 3 * DAY_MS))).toBeNull();
    expect(run(R.goneQuiet, bundle(), contextAt(DISCUSSION_OPEN + 5 * DAY_MS))).toMatch(
      /^no in-HotCRP activity for 5 days since discussion opened \(limit 4 days\); last activity 2\d\.\d days ago$/,
    );
  });
  it("honors PCS_THRESH_STALE_DAYS", () => {
    expect(run(R.goneQuiet, bundle({ comments: [cm(A, day(2))] }), contextAt(MID.now, { PCS_THRESH_STALE_DAYS: "12.5" }))).toBeNull();
  });
});

describe("AC_ABSENT", () => {
  it("fires when the AC hasn't commented since discussion opened", () => {
    const cs = [cm(A, day(3)), cm(AC, DISCUSSION_OPEN - DAY_MS)];
    expect(run(R.acAbsent, bundle({ comments: cs }))).toBe("no AC comment since discussion opened 14.5 days ago (1 AC)");
  });
  it("does not fire once the AC (or a co-AC) comments", () => {
    expect(run(R.acAbsent, bundle({ comments: [cm(AC, day(1))] }))).toBeNull();
    expect(run(R.acAbsent, bundle({ acs: [AC, "ac2@example.org"], comments: [cm("ac2@example.org", day(1))] }))).toBeNull();
  });
  it("reports a paper with no AC", () => {
    expect(run(R.acAbsent, bundle({ acs: [] }))).toBe("no area chair assigned; discussion opened 14.5 days ago");
  });
  it("boundary: not before discussion opens", () => {
    expect(run(R.acAbsent, bundle(), contextAt(DISCUSSION_OPEN - 1))).toBeNull();
    expect(run(R.acAbsent, bundle({ comments: [cm(AC, DISCUSSION_OPEN)] }), contextAt(DISCUSSION_OPEN))).toBeNull();
  });
});

describe("CHAMPION_MISSING", () => {
  it("fires when the standout top reviewer hasn't commented", () => {
    expect(run(R.championMissing, bundle({ reviews: three([5, 3, 3]), comments: [cm(B, day(2))] }))).toBe(
      "top merit 5 (1 reviewer, 2 above the lowest 3); no comment from that reviewer since discussion opened",
    );
  });
  it("does not fire once a top-merit holder comments", () => {
    expect(run(R.championMissing, bundle({ reviews: three([5, 3, 3]), comments: [cm(A, day(2))] }))).toBeNull();
    // 2/4/4: one of the two 4s commenting is enough.
    expect(run(R.championMissing, bundle({ reviews: three([2, 4, 4]), comments: [cm(C, day(2))] }))).toBeNull();
  });
  it("does not fire when the top merit is below MERIT_ACCEPT_MIN", () => {
    expect(run(R.championMissing, bundle({ reviews: three([1, 2, 2]) }))).toBeNull();
  });
  it("boundary: gap equal to PCS_THRESH_CHAMPION_GAP fires; one less doesn't", () => {
    expect(run(R.championMissing, bundle({ reviews: three([2, 4, 4]) }))).toMatch(/^top merit 4 \(2 reviewers, 2 above the lowest 2\); no comment from any of them/);
    expect(run(R.championMissing, bundle({ reviews: three([3, 3, 4]) }))).toBeNull();
    expect(run(R.championMissing, bundle({ reviews: three([3, 3, 4]) }), contextAt(MID.now, { PCS_THRESH_CHAMPION_GAP: "1" }))).not.toBeNull();
  });
  it("boundary: top merit exactly MERIT_ACCEPT_MIN qualifies", () => {
    expect(run(R.championMissing, bundle({ reviews: three([1, 3, 2]) }))).not.toBeNull();
  });
  it("a pre-discussion comment by the champion doesn't count", () => {
    expect(run(R.championMissing, bundle({ reviews: three([5, 3, 3]), comments: [cm(A, DISCUSSION_OPEN - 1)] }))).not.toBeNull();
  });
});

describe("LOW_EXPERTISE", () => {
  const exp = (xs: [number | null, number | null, number | null]) =>
    three([3, 3, 4], xs.map((expertise) => ({ expertise })));
  it("fires when no review is knowledgeable", () => {
    expect(run(R.lowExpertise, bundle({ reviews: exp([2, 2, 1]) }))).toBe("expertise 2/2/1; none >= 3");
  });
  it("boundary: one review at EXPERTISE_OK_MIN is enough", () => {
    expect(run(R.lowExpertise, bundle({ reviews: exp([2, 3, 1]) }))).toBeNull();
    expect(run(R.lowExpertise, bundle({ reviews: exp([2, 3, 1]) }), contextAt(MID.now, { PCS_EXPERTISE_OK_MIN: "4" }))).not.toBeNull();
  });
  it("needs at least one expertise score, and only after REVIEW_DUE", () => {
    expect(run(R.lowExpertise, bundle({ reviews: exp([null, null, null]) }))).toBeNull();
    expect(run(R.lowExpertise, bundle({ reviews: exp([2, 2, 1]) }), contextAt("2030-01-30T12:00"))).toBeNull();
  });
});

describe("THIN_REVIEWS", () => {
  it("fires below PCS_THRESH_MIN_WORDS", () => {
    expect(run(R.thinReviews, bundle({ reviews: three([3, 3, 4], [{}, { words: 35 }]) }))).toBe(
      "1 of 3 reviews thin (min 150 words): B: 35 words",
    );
  });
  it("boundary: 149 words fires, 150 doesn't", () => {
    expect(run(R.thinReviews, bundle({ reviews: three([3, 3, 4], [{ words: 149 }]) }))).not.toBeNull();
    expect(run(R.thinReviews, bundle({ reviews: three([3, 3, 4], [{ words: 150 }]) }))).toBeNull();
  });
  it("fires on short/vague ratings regardless of length", () => {
    expect(run(R.thinReviews, bundle({ reviews: three([3, 3, 4], [{ ratedVague: true }, { ratedShort: true }]) }))).toBe(
      "2 of 3 reviews thin (min 150 words): A: rated vague; B: rated short",
    );
  });
  it("ignores unsubmitted reviews", () => {
    expect(run(R.thinReviews, bundle({ reviews: three([3, 3, 4], [{ status: "draft", words: 10 }]) }))).toBeNull();
  });
});

describe("RESPONSE_UNADDRESSED", () => {
  const resp = (t: number) => cm("author@example.org", t, { isResponse: true });
  it("fires with a response and no reviewer comment after it", () => {
    expect(run(R.responseUnaddressed, bundle({ comments: [resp(at("2030-02-09T12:00")), cm(AC, day(12))] }))).toBe(
      "author response posted 17 days ago; 0 reviewer comments since",
    );
  });
  it("a reviewer comment after the response addresses it", () => {
    expect(run(R.responseUnaddressed, bundle({ comments: [resp(day(1)), cm(B, day(2))] }))).toBeNull();
  });
  it("boundary: a reviewer comment at the same instant as the response doesn't count", () => {
    expect(run(R.responseUnaddressed, bundle({ comments: [resp(day(1)), cm(B, day(1))] }))).not.toBeNull();
  });
  it("uses the latest response; draft responses don't count", () => {
    expect(run(R.responseUnaddressed, bundle({ comments: [resp(day(1)), cm(B, day(2)), resp(day(3))] }))).not.toBeNull();
    expect(run(R.responseUnaddressed, bundle({ comments: [cm("author@example.org", day(1), { isResponse: true, draft: true })] }))).toBeNull();
  });
  it("not before discussion opens", () => {
    expect(run(R.responseUnaddressed, bundle({ comments: [resp(at("2030-02-09T12:00"))] }), contextAt("2030-02-11T12:00"))).toBeNull();
  });
});

describe("DEADLINE_NO_CONSENSUS", () => {
  const due = at("2030-03-03T23:59");
  const splitB = () => bundle({ reviews: three([2, 4, 4]), comments: lively() });
  it("fires inside the window when split", () => {
    expect(run(R.deadlineNoConsensus, splitB(), contextAt(due - 2 * DAY_MS))).toBe(
      "decisions due in 2 days (window 3 days); no decision; split (2/4/4)",
    );
  });
  it("fires inside the window when silent", () => {
    expect(run(R.deadlineNoConsensus, bundle(), contextAt(due - DAY_MS))).toMatch(/no discussion comments$/);
  });
  it("not for a quiet consensus paper with comments", () => {
    expect(run(R.deadlineNoConsensus, bundle({ comments: lively() }), contextAt(due - DAY_MS))).toBeNull();
  });
  it("boundary: exactly DEADLINE_DAYS out doesn't fire; one ms closer does", () => {
    expect(run(R.deadlineNoConsensus, splitB(), contextAt(due - 3 * DAY_MS))).toBeNull();
    expect(run(R.deadlineNoConsensus, splitB(), contextAt(due - 3 * DAY_MS + 1))).not.toBeNull();
  });
  it("keeps firing once overdue", () => {
    expect(run(R.deadlineNoConsensus, splitB(), contextAt(due + DAY_MS))).toMatch(/^decisions were due 1 day ago/);
  });
});

describe("evaluator", () => {
  const messy = () =>
    bundle({ reviews: three([2, 4, 4], [{}, { words: 20 }]) }); // split, unresolved, silent, quiet, AC absent, thin, champion
  it("sums weights into severity", () => {
    const r = evaluatePaper(messy(), MID);
    expect(r.fired.map((f) => f.rule)).toEqual([
      "SPLIT",
      "UNRESOLVED_SPLIT",
      "SILENT_DISCUSSION",
      "GONE_QUIET",
      "AC_ABSENT",
      "CHAMPION_MISSING",
      "THIN_REVIEWS",
    ]);
    expect(r.severity).toBe(3 + 2 + 3 + 2 + 2 + 1 + 1);
  });
  it("weights come from env; 0 disables a rule", () => {
    const ctx = contextAt(MID.now, { PCS_RULE_SPLIT_WEIGHT: "10", PCS_RULE_THIN_REVIEWS_WEIGHT: "0" });
    const r = evaluatePaper(messy(), ctx);
    expect(r.fired.some((f) => f.rule === "THIN_REVIEWS")).toBe(false);
    expect(r.fired.find((f) => f.rule === "SPLIT")!.weight).toBe(10);
    expect(r.severity).toBe(10 + 2 + 3 + 2 + 2 + 1);
  });
  it("a decided paper fires nothing", () => {
    const r = evaluatePaper({ ...messy(), paper: paper(1, { decision: "Reject", decisionSeenAt: day(1) }) }, MID);
    expect(r).toMatchObject({ severity: 0, fired: [] });
  });
});
