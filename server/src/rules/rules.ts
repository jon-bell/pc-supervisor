// Paper-risk rules (spec §5c). One function per rule. Each takes the paper's
// facts (facts.ts) and the context, and returns a reason string with the
// actual numbers, or null when it doesn't fire. Weights live in the
// evaluator (evaluate.ts); a weight of 0 disables a rule.
//
// Precise semantics (threshold comparisons in brackets):
//
// Applies to all rules but REVIEW_FLAGGED: a paper with a decision fires
// nothing (evaluate.ts).
// Ratings (ratings.ts) are raters per flag. When the instance has ratings off
// (ctx.ratingsEnabled false), the rating clauses are skipped: hidden, not zero.
//
// MISSING_REVIEWS   after REVIEW_DUE [now > due], submitted reviewer
//                   reviews < PCS_REVIEWS_REQUIRED.
// SPLIT             >= 2 submitted merits, and either range (max - min)
//                   >= PCS_THRESH_SPLIT_RANGE, or some merit < MERIT_ACCEPT_MIN
//                   and some merit >= MERIT_ACCEPT_MIN. Any phase.
// UNRESOLVED_SPLIT  SPLIT, discussion open for > PCS_THRESH_UNRESOLVED_DAYS,
//                   and no reviewer merit change seen since DISCUSSION_OPEN.
// SILENT_DISCUSSION discussion opened [now >= open] and 0 published
//                   non-response comments (by anyone) since DISCUSSION_OPEN.
// GONE_QUIET        discussion opened, and now - max(last activity,
//                   DISCUSSION_OPEN) > PCS_THRESH_STALE_DAYS. Measuring from
//                   DISCUSSION_OPEN at the latest keeps every paper from going
//                   "quiet" the moment discussion opens just because its
//                   reviews landed weeks earlier. AC comments count.
// AC_ABSENT         discussion opened, and none of the paper's ACs has a
//                   published comment since DISCUSSION_OPEN (also fires,
//                   with its own reason, when the paper has no AC).
// CHAMPION_MISSING  discussion opened; top = max submitted merit is >=
//                   MERIT_ACCEPT_MIN, and NO reviewer holding the top merit
//                   has commented since DISCUSSION_OPEN.
// LOW_EXPERTISE     after REVIEW_DUE, >= 1 submitted review with an expertise
//                   score, and none >= EXPERTISE_OK_MIN.
// THIN_REVIEWS      some submitted reviewer review has wordCount <
//                   PCS_THRESH_MIN_WORDS, or its `short` count or its `vague`
//                   count is >= PCS_THRESH_RATING_RATERS (each flag on its
//                   own: 1 short + 1 vague is not enough). Any phase.
// RESPONSE_UNADDRESSED discussion opened, a published author response
//                   exists, and no reviewer (non-AC) has a published comment
//                   after the LATEST response. AC comments don't count.
// REVIEW_FLAGGED    some review on the paper (reviewer or AC, any status) has
//                   a `disrespectful` or `wrong` rating (count >= 1). Any
//                   phase, and decided papers too: a decision usually goes
//                   out WITH the reviews, so a decided paper is exactly where
//                   the chair must act before authors see it.
// DEADLINE_NO_CONSENSUS days to DECISIONS_DUE < PCS_THRESH_DEADLINE_DAYS
//                   (including overdue), and the paper is SPLIT or
//                   SILENT_DISCUSSION.

import type { RuleName } from "../config.js";
import { formatRatings, pickRatings, ratingTotal, SEVERE_FLAGS, type RatingCounts } from "../ratings.js";
import { ratingsOn, type RuleContext } from "./context.js";
import type { PaperFacts } from "./facts.js";
import { daysSince, daysToDecisions, discussionOpened, reviewsDuePassed } from "./phase.js";

export type Rule = (f: PaperFacts, ctx: RuleContext) => string | null;

/** "14.5 days", "1 day", "0.3 days": one decimal, trailing .0 dropped. */
export function fmtDays(d: number): string {
  const r = Math.round(d * 10) / 10;
  const s = Number.isInteger(r) ? String(r) : r.toFixed(1);
  return `${s} ${r === 1 ? "day" : "days"}`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export interface SplitInfo {
  range: number;
  bothSides: boolean;
}

/** Null unless the merits are split (see SPLIT above). */
export function splitOf(merits: readonly number[], ctx: RuleContext): SplitInfo | null {
  if (merits.length < 2) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (const m of merits) {
    if (m < lo) lo = m;
    if (m > hi) hi = m;
  }
  const range = hi - lo;
  const bothSides = lo < ctx.meritAcceptMin && hi >= ctx.meritAcceptMin;
  return range >= ctx.thresholds.SPLIT_RANGE || bothSides ? { range, bothSides } : null;
}

const scores = (f: PaperFacts) => f.merits.join("/");

export function missingReviews(f: PaperFacts, ctx: RuleContext): string | null {
  if (!reviewsDuePassed(ctx.phases, ctx.now)) return null;
  const done = f.submitted.length;
  if (done >= ctx.reviewsRequired) return null;
  const outstanding = f.reviewerReviews.length - done;
  return (
    `${done} of ${ctx.reviewsRequired} required reviews complete` +
    (outstanding > 0 ? `; ${plural(outstanding, "assigned review")} not submitted` : "; no other reviewer assigned") +
    `; reviews were due ${fmtDays(daysSince(ctx.phases.reviewDue, ctx.now))} ago`
  );
}

export function split(f: PaperFacts, ctx: RuleContext): string | null {
  const s = splitOf(f.merits, ctx);
  if (!s) return null;
  const why = [
    ...(s.range >= ctx.thresholds.SPLIT_RANGE ? [`range ${s.range} >= ${ctx.thresholds.SPLIT_RANGE}`] : []),
    ...(s.bothSides ? [`scores on both sides of ${ctx.meritAcceptMin}`] : []),
  ];
  return `merit ${scores(f)} (${why.join("; ")})`;
}

export function unresolvedSplit(f: PaperFacts, ctx: RuleContext): string | null {
  if (!discussionOpened(ctx.phases, ctx.now)) return null;
  if (!splitOf(f.merits, ctx)) return null;
  const open = daysSince(ctx.phases.discussionOpen, ctx.now);
  if (open <= ctx.thresholds.UNRESOLVED_DAYS) return null;
  if (f.moves.length > 0) return null;
  return `scores ${scores(f)}; no movement since discussion opened ${fmtDays(open)} ago (limit ${fmtDays(ctx.thresholds.UNRESOLVED_DAYS)})`;
}

export function silentDiscussion(f: PaperFacts, ctx: RuleContext): string | null {
  if (!discussionOpened(ctx.phases, ctx.now)) return null;
  if (f.discussionComments.length > 0) return null;
  return `0 comments since discussion opened ${fmtDays(daysSince(ctx.phases.discussionOpen, ctx.now))} ago`;
}

export function goneQuiet(f: PaperFacts, ctx: RuleContext): string | null {
  if (!discussionOpened(ctx.phases, ctx.now)) return null;
  const from = Math.max(f.lastActivity ?? -Infinity, ctx.phases.discussionOpen);
  const quiet = daysSince(from, ctx.now);
  if (quiet <= ctx.thresholds.STALE_DAYS) return null;
  const last =
    f.lastActivity === null ? "no activity recorded" : `last activity ${fmtDays(daysSince(f.lastActivity, ctx.now))} ago`;
  const since = f.lastActivity !== null && f.lastActivity >= ctx.phases.discussionOpen ? "" : " since discussion opened";
  return `no in-HotCRP activity for ${fmtDays(quiet)}${since} (limit ${fmtDays(ctx.thresholds.STALE_DAYS)}); ${last}`;
}

export function acAbsent(f: PaperFacts, ctx: RuleContext): string | null {
  if (!discussionOpened(ctx.phases, ctx.now)) return null;
  const open = fmtDays(daysSince(ctx.phases.discussionOpen, ctx.now));
  if (f.acSet.size === 0) return `no area chair assigned; discussion opened ${open} ago`;
  for (const c of f.discussionComments) if (f.acSet.has(c.email)) return null;
  return `no AC comment since discussion opened ${open} ago (${plural(f.acSet.size, "AC")})`;
}

export function championMissing(f: PaperFacts, ctx: RuleContext): string | null {
  if (!discussionOpened(ctx.phases, ctx.now) || f.merits.length === 0) return null;
  const top = Math.max(...f.merits);
  if (top < ctx.meritAcceptMin) return null;
  const champions = f.submitted.filter((r) => r.merit === top);
  if (champions.some((r) => f.discussionCommenters.has(r.email))) return null;
  return (
    `top merit ${top} (${plural(champions.length, "reviewer")}); ` +
    `no comment from ${champions.length === 1 ? "that reviewer" : "any of them"} since discussion opened`
  );
}

export function lowExpertise(f: PaperFacts, ctx: RuleContext): string | null {
  if (!reviewsDuePassed(ctx.phases, ctx.now)) return null;
  const xs: number[] = [];
  for (const r of f.submitted) if (r.expertise !== null) xs.push(r.expertise);
  if (xs.length === 0 || xs.some((x) => x >= ctx.expertiseOkMin)) return null;
  return `expertise ${xs.join("/")}; none >= ${ctx.expertiseOkMin}`;
}

/** "review B" (or "review #rid" before HotCRP assigns an ordinal). */
const reviewName = (r: { ordinal: string | null; rid: number }) => `review ${r.ordinal ?? `#${r.rid}`}`;

/** The short/vague flags that reach PCS_THRESH_RATING_RATERS (zeros dropped); {} when ratings are off. */
export function thinFlags(ratings: RatingCounts, ctx: RuleContext): RatingCounts {
  if (!ratingsOn(ctx)) return {};
  const min = ctx.thresholds.RATING_RATERS;
  return pickRatings(ratings, (["short", "vague"] as const).filter((x) => (ratings[x] ?? 0) >= min));
}

export function thinReviews(f: PaperFacts, ctx: RuleContext): string | null {
  const min = ctx.thresholds.MIN_WORDS;
  const parts: string[] = [];
  let n = 0;
  for (const r of f.submitted) {
    const why: string[] = [];
    if (r.wordCount < min) why.push(`${r.wordCount} words`);
    const flags = formatRatings(thinFlags(r.ratings, ctx));
    if (flags) why.push(flags);
    if (why.length > 0) {
      n++;
      parts.push(`${reviewName(r)}: ${why.join(", ")}`);
    }
  }
  if (n === 0) return null;
  const bar = ratingsOn(ctx) ? `min ${min} words, or short/vague from ${ctx.thresholds.RATING_RATERS}+ raters` : `min ${min} words`;
  return `${n} of ${plural(f.submitted.length, "review")} thin (${bar}): ${parts.join("; ")}`;
}

export function reviewFlagged(f: PaperFacts, ctx: RuleContext): string | null {
  if (!ratingsOn(ctx)) return null;
  const parts: string[] = [];
  for (const r of f.bundle.reviews) {
    if (ratingTotal(r.ratings, SEVERE_FLAGS) === 0) continue;
    // Quote the review's other flags too: "1× short" next to "1× disrespectful" is context.
    parts.push(`${reviewName(r)}${r.rtype === 5 || f.acSet.has(r.email) ? " (AC)" : ""}: ${formatRatings(r.ratings)}`);
  }
  if (parts.length === 0) return null;
  return `${plural(parts.length, "review")} rated disrespectful or wrong: ${parts.join("; ")}`;
}

export function responseUnaddressed(f: PaperFacts, ctx: RuleContext): string | null {
  if (!discussionOpened(ctx.phases, ctx.now) || f.responses.length === 0) return null;
  const last = f.responses[f.responses.length - 1]!.time;
  const reviewers = new Set(f.reviewerReviews.map((r) => r.email));
  for (const c of f.pcComments) if (c.time > last && reviewers.has(c.email)) return null;
  return `author response posted ${fmtDays(daysSince(last, ctx.now))} ago; 0 reviewer comments since`;
}

export function deadlineNoConsensus(f: PaperFacts, ctx: RuleContext): string | null {
  const left = daysToDecisions(ctx.phases, ctx.now);
  if (left >= ctx.thresholds.DEADLINE_DAYS) return null;
  const why: string[] = [];
  if (splitOf(f.merits, ctx)) why.push(`split (${scores(f)})`);
  if (silentDiscussion(f, ctx) !== null) why.push("no discussion comments");
  if (why.length === 0) return null;
  const when = left >= 0 ? `decisions due in ${fmtDays(left)}` : `decisions were due ${fmtDays(-left)} ago`;
  return `${when} (window ${fmtDays(ctx.thresholds.DEADLINE_DAYS)}); no decision; ${why.join(", ")}`;
}

/** Every rule, in spec §5c order (also the chip order in the UI). */
export const RULES: Readonly<Record<RuleName, Rule>> = {
  MISSING_REVIEWS: missingReviews,
  SPLIT: split,
  UNRESOLVED_SPLIT: unresolvedSplit,
  SILENT_DISCUSSION: silentDiscussion,
  GONE_QUIET: goneQuiet,
  AC_ABSENT: acAbsent,
  CHAMPION_MISSING: championMissing,
  LOW_EXPERTISE: lowExpertise,
  THIN_REVIEWS: thinReviews,
  RESPONSE_UNADDRESSED: responseUnaddressed,
  REVIEW_FLAGGED: reviewFlagged,
  DEADLINE_NO_CONSENSUS: deadlineNoConsensus,
};
