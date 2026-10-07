// Overview burndown: papers without consensus over time (spec §5c, Views).
//
// A paper is "without consensus" at instant t when it is undecided at t and
// its merits as of t are split (rules.ts splitOf). State at t is rebuilt from
// history:
// - decided at t: decision !== null and decisionSeenAt <= t (or unknown);
// - a review's merit at t: the latest version seen at or before t, if that
//   version is submitted; with no version history, the current merit once
//   first_complete_seen_at <= t.
// Points are every 24 h from `start` (default REVIEW_DUE) while < `end`
// (default now), plus a final point at `end`. Cost: O(papers x points x
// reviews per paper), with a moving pointer into each review's versions.

import type { RuleContext } from "./context.js";
import { isSubmitted, type PaperFacts } from "./facts.js";
import type { Millis, ReviewView } from "./model.js";
import { DAY_MS } from "./phase.js";
import { splitOf } from "./rules.js";

export interface BurndownPoint {
  t: Millis;
  undecided: number;
  noConsensus: number;
}

export function burndownPoints(start: Millis, end: Millis): Millis[] {
  const ts: Millis[] = [];
  for (let t = start; t < end; t += DAY_MS) ts.push(t);
  if (end >= start) ts.push(end);
  return ts;
}

class MeritCursor {
  private i = -1;
  constructor(private readonly r: ReviewView) {}
  /** Merit at t; t must be non-decreasing across calls. */
  at(t: Millis): number | null {
    const v = this.r.versions;
    if (v.length === 0) {
      return isSubmitted(this.r) && this.r.firstCompleteSeenAt !== null && this.r.firstCompleteSeenAt <= t
        ? this.r.merit
        : null;
    }
    while (this.i + 1 < v.length && v[this.i + 1]!.seenAt <= t) this.i++;
    const cur = this.i >= 0 ? v[this.i]! : null;
    return cur && isSubmitted(cur) ? cur.merit : null;
  }
}

export function computeBurndown(
  facts: Iterable<PaperFacts>,
  ctx: RuleContext,
  opts: { start?: Millis; end?: Millis } = {},
): BurndownPoint[] {
  const ts = burndownPoints(opts.start ?? ctx.phases.reviewDue, opts.end ?? ctx.now);
  const points = ts.map((t) => ({ t, undecided: 0, noConsensus: 0 }));
  for (const f of facts) {
    const p = f.bundle.paper;
    const decidedFrom = p.decision === null ? Infinity : (p.decisionSeenAt ?? -Infinity);
    const cursors = f.reviewerReviews.map((r) => new MeritCursor(r));
    for (const pt of points) {
      if (pt.t >= decidedFrom) continue;
      pt.undecided++;
      const merits: number[] = [];
      for (const c of cursors) {
        const m = c.at(pt.t);
        if (m !== null) merits.push(m);
      }
      if (splitOf(merits, ctx)) pt.noConsensus++;
    }
  }
  return points;
}
