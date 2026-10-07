// Scale budget: 2,400 papers / ~10k reviews / 20k comments, everything the
// overview needs (rules + AC + reviewer metrics + outliers + burndown), well
// under 1 s. Synthetic data from a fixed-seed RNG.
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { analyze } from "../../../src/rules/index.js";
import type { AcView, CommentView, PaperView, PersonView, ReviewView, SnapshotView } from "../../../src/rules/model.js";
import { DAY_MS } from "../../../src/rules/phase.js";
import { at, comment, contextAt, DISCUSSION_OPEN, paper, review } from "../../fixtures/builder.js";

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function scaleSnapshot(nPapers = 2400, nAcs = 40, nReviewers = 400, nComments = 20_000): SnapshotView {
  const r = rng(20300226);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
  const tiers = ["senior", "senior", "junior", "reciprocal"];
  const people: PersonView[] = [];
  const acEmails = Array.from({ length: nAcs }, (_, i) => `ac${i}@example.org`);
  const revEmails = Array.from({ length: nReviewers }, (_, i) => `rev${i}@example.org`);
  for (const e of acEmails) people.push({ email: e, name: e, tier: "senior", roles: ["pc"] });
  for (const e of revEmails) people.push({ email: e, name: e, tier: pick(tiers), roles: ["pc"] });

  const papers: PaperView[] = [];
  const acs: AcView[] = [];
  const reviews: ReviewView[] = [];
  const comments: CommentView[] = [];
  const reviewersOf: string[][] = [];
  let rid = 1;
  const subStart = at("2030-01-15T00:00");
  for (let pid = 1; pid <= nPapers; pid++) {
    papers.push(paper(pid, r() < 0.05 ? { decision: "Accept", decisionSeenAt: DISCUSSION_OPEN + 8 * DAY_MS } : {}));
    const ac = acEmails[pid % nAcs]!;
    acs.push({ pid, email: ac });
    reviews.push(review({ rid: rid++, pid, email: ac, rtype: 5, status: "empty", merit: null, expertise: null }));
    const rs = new Set<string>();
    while (rs.size < 3) rs.add(pick(revEmails));
    reviewersOf[pid] = [...rs];
    for (const email of rs) {
      const merit = 1 + Math.floor(r() * 5);
      const moved = r() < 0.15;
      reviews.push(
        review({
          rid: rid++,
          pid,
          email,
          merit,
          expertise: 1 + Math.floor(r() * 4),
          words: 50 + Math.floor(r() * 900),
          status: r() < 0.03 ? "draft" : "complete",
          submittedAt: subStart + Math.floor(r() * 16 * DAY_MS),
          moves: moved ? [{ at: DISCUSSION_OPEN + Math.floor(r() * 12 * DAY_MS), merit: Math.max(1, merit - 1) }] : [],
          ratedShort: r() < 0.02,
        }),
      );
    }
  }
  for (let cid = 1; cid <= nComments; cid++) {
    const pid = 1 + Math.floor(r() * nPapers);
    const who = r() < 0.25 ? acEmails[pid % nAcs]! : pick(reviewersOf[pid]!);
    const mentions = r() < 0.1 ? [pick(reviewersOf[pid]!)] : [];
    comments.push(
      comment({
        cid,
        pid,
        email: who,
        time: DISCUSSION_OPEN + Math.floor(r() * 14 * DAY_MS),
        mentions,
        isResponse: r() < 0.02,
      }),
    );
  }
  return { papers, people, acs, reviews, comments };
}

describe("scale", () => {
  it("analyzes 2,400 papers / ~10k reviews / 20k comments in well under 1 s", () => {
    const s = scaleSnapshot();
    expect(s.papers).toHaveLength(2400);
    expect(s.reviews.length).toBeGreaterThanOrEqual(9600);
    expect(s.comments).toHaveLength(20_000);
    const ctx = contextAt("2030-02-26T12:00");
    analyze(s, ctx); // warm-up (JIT)
    const t0 = performance.now();
    const a = analyze(s, ctx);
    const ms = performance.now() - t0;
    expect(a.evaluation.results).toHaveLength(2400);
    expect(a.acs).toHaveLength(40);
    expect(a.reviewers.length).toBeGreaterThan(300);
    expect(ms).toBeLessThan(600);
  });
});
