// Per discussion lead (HotCRP `lead`, chair feedback): the AC table's
// analogue grouped by each paper's discussion lead, whatever PCS_AC_ROLE is.
// Pure and O(rows): each led paper is visited once.
//
// Definitions (comments are published, non-response, up to now; see facts.ts):
// - papers / load:  papers they lead; `flagged` = severity > 0 there.
// - reviews:        submitted vs assigned reviewer reviews (non-AC) on those
//                   papers; `complete` counts papers with at least
//                   PCS_REVIEWS_REQUIRED submitted.
// - comments:       everyone's comments on those papers, in all and since
//                   DISCUSSION_OPEN.
// - lead comments:  the lead's own comments there, in all and since
//                   DISCUSSION_OPEN; `commented` lists the papers with at
//                   least one, `notYet` those with none ("no comments yet").
// - stale:          undecided led papers where the GONE_QUIET condition holds.
// - activity:       comments by anyone on their papers per 24 h bucket from
//                   DISCUSSION_OPEN to now (sparkline).

import { dayBuckets } from "./ac-metrics.js";
import type { RuleContext } from "./context.js";
import type { Evaluation } from "./evaluate.js";
import type { PaperFacts } from "./facts.js";
import type { CommentView, Millis } from "./model.js";
import { DAY_MS } from "./phase.js";
import { goneQuiet } from "./rules.js";

export interface LeadPaperMetrics {
  pid: number;
  reviews: { submitted: number; assigned: number };
  comments: { total: number; discussion: number };
  leadComments: { total: number; discussion: number };
  /** Time of the lead's latest comment on the paper; null if none yet. */
  leadLastComment: Millis | null;
  stale: boolean;
}

export interface LeadMetrics {
  email: string;
  pids: readonly number[];
  load: number;
  flagged: number;
  flaggedPids: readonly number[];
  reviews: { submitted: number; assigned: number; complete: number };
  comments: { total: number; discussion: number };
  leadComments: { total: number; discussion: number };
  commentedPids: readonly number[];
  notYetPids: readonly number[];
  stale: number;
  stalePids: readonly number[];
  activity: { start: Millis; daily: readonly number[] };
  papers: readonly LeadPaperMetrics[];
}

/** One paper's lead-view numbers. */
export function leadPaperMetrics(f: PaperFacts, lead: string, ctx: RuleContext): LeadPaperMetrics {
  const open = ctx.phases.discussionOpen;
  const upToNow: CommentView[] = f.pcComments.filter((c) => c.time <= ctx.now);
  const mine = upToNow.filter((c) => c.email === lead);
  return {
    pid: f.pid,
    reviews: { submitted: f.submitted.length, assigned: f.reviewerReviews.length },
    comments: { total: upToNow.length, discussion: upToNow.filter((c) => c.time >= open).length },
    leadComments: { total: mine.length, discussion: mine.filter((c) => c.time >= open).length },
    leadLastComment: mine.length ? mine[mine.length - 1]!.time : null,
    stale: !f.decided && goneQuiet(f, ctx) !== null,
  };
}

/**
 * Lead metrics for `leads` ({pid, email} rows, e.g. store.areaChairs({kind:
 * "lead"})). Rows for papers outside the evaluation are ignored. Sorted by
 * email: alphabetical, not a ranking (spec §7); the UI sorts by name.
 */
export function computeLeadMetrics(ev: Evaluation, ctx: RuleContext, leads: readonly { pid: number; email: string }[]): LeadMetrics[] {
  const open = ctx.phases.discussionOpen;
  const buckets = dayBuckets(open, ctx.now);
  const byLead = new Map<string, LeadPaperMetrics[]>();
  const daily = new Map<string, number[]>();
  for (const { pid, email } of leads) {
    const f = ev.facts.get(pid);
    if (!f) continue;
    let list = byLead.get(email);
    if (!list) {
      byLead.set(email, (list = []));
      daily.set(email, new Array<number>(buckets).fill(0));
    }
    list.push(leadPaperMetrics(f, email, ctx));
    const d = daily.get(email)!;
    for (const c of f.pcComments) {
      if (c.time < open || c.time > ctx.now) continue;
      const i = Math.floor((c.time - open) / DAY_MS);
      if (i >= 0 && i < buckets) d[i]!++;
    }
  }

  const out: LeadMetrics[] = [];
  for (const [email, papers] of byLead) {
    papers.sort((a, b) => a.pid - b.pid);
    const sum = (g: (p: LeadPaperMetrics) => number) => papers.reduce((n, p) => n + g(p), 0);
    const flaggedPids = papers.filter((p) => (ev.byPid.get(p.pid)?.severity ?? 0) > 0).map((p) => p.pid);
    const stalePids = papers.filter((p) => p.stale).map((p) => p.pid);
    out.push({
      email,
      pids: papers.map((p) => p.pid),
      load: papers.length,
      flagged: flaggedPids.length,
      flaggedPids,
      reviews: {
        submitted: sum((p) => p.reviews.submitted),
        assigned: sum((p) => p.reviews.assigned),
        complete: papers.filter((p) => p.reviews.submitted >= ctx.reviewsRequired).length,
      },
      comments: { total: sum((p) => p.comments.total), discussion: sum((p) => p.comments.discussion) },
      leadComments: { total: sum((p) => p.leadComments.total), discussion: sum((p) => p.leadComments.discussion) },
      commentedPids: papers.filter((p) => p.leadComments.total > 0).map((p) => p.pid),
      notYetPids: papers.filter((p) => p.leadComments.total === 0).map((p) => p.pid),
      stale: stalePids.length,
      stalePids,
      activity: { start: open, daily: daily.get(email)! },
      papers,
    });
  }
  return out.sort((x, y) => x.email.localeCompare(y.email));
}
