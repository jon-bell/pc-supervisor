// Per-AC activity (spec §5b). One row per person who is an AC on >= 1 paper.
// Pure and O(rows): each paper is visited once per co-AC.
//
// Definitions:
// - papers / load:   papers where they are an AC; `flagged` = those with
//                    severity > 0 in the evaluation. Shown side by side so a
//                    load problem reads differently from an engagement one.
// - coverage:        papers with a published comment by this AC since
//                    DISCUSSION_OPEN, over all their papers (null before
//                    discussion opens).
// - time to first post: per paper, from max(DISCUSSION_OPEN, last reviewer
//                    review landing) to the AC's first comment at or after
//                    DISCUSSION_OPEN (0 if they posted before the last review
//                    landed). Median over papers with a post; `waiting` counts
//                    papers whose clock has started but have no post yet.
// - nudges:          with the comment classifier active (spec §5e;
//                    snapshot commentClassifier set): `total` = `pings`, the
//                    AC's discussion comments whose type is ping (the chair's
//                    label, else the classifier's), and `source` names the
//                    classifier. Otherwise (`source` "proxy") the labeled
//                    proxy: the AC's discussion comments that @mention a
//                    reviewer of that paper (`mentions`), or that were posted
//                    while >= 1 reviewer had no discussion comment yet
//                    (`proxy`; we can't see email nudges), each comment once.
//                    The proxy counts are kept either way.
// - comments:        all published non-response comments by the AC on their
//                    papers, up to now, whenever posted. HotCRP allows
//                    discussion as soon as reviews are visible, so on a real
//                    PC many AC comments predate DISCUSSION_OPEN; counting
//                    only `discussionComments` showed 0 while the drawer
//                    listed them (chair feedback).
// - discussionComments: the subset at or after DISCUSSION_OPEN.
// - stale:           undecided papers where the GONE_QUIET condition holds
//                    (regardless of that rule's weight).
// - metareview:      their own AC reviews (rtype 5, or any review they hold
//                    on the paper under another PCS_AC_ROLE) by status;
//                    `submitted` counts SUBMITTED_STATUSES. Due at DECISIONS_DUE.
// - activity:        published comments by the AC per 24 h bucket, starting
//                    at DISCUSSION_OPEN and ending at now (sparkline). Empty
//                    before discussion opens.

import type { RuleContext } from "./context.js";
import type { Evaluation } from "./evaluate.js";
import { isSubmitted, median, reviewActivityTime, type PaperFacts } from "./facts.js";
import { DEFAULT_TIER, type Millis, type ReviewStatus, type Tier } from "./model.js";
import { DAY_MS, discussionOpened } from "./phase.js";
import { goneQuiet } from "./rules.js";

/** What AC nudges count: classified pings, or the @mention / silent-reviewer proxy. */
export type NudgeSource = "proxy" | "heuristic" | "model";

export interface AcMetrics {
  email: string;
  name: string;
  tier: Tier;
  pids: readonly number[];
  load: number;
  flagged: number;
  flaggedPids: readonly number[];
  coverage: { covered: number; of: number; share: number | null };
  timeToFirstPost: { medianDays: number | null; posted: number; waiting: number };
  nudges: { total: number; mentions: number; proxy: number; pings: number; source: NudgeSource };
  stale: number;
  stalePids: readonly number[];
  /** Published comments by this AC on their papers, any time up to now. */
  comments: number;
  /** Comments by this AC since DISCUSSION_OPEN, across their papers. */
  discussionComments: number;
  metareview: { byStatus: Partial<Record<ReviewStatus, number>>; submitted: number; of: number; due: Millis };
  activity: { start: Millis; daily: readonly number[] };
}

/** Number of whole-or-partial day buckets from `start` to `now`. */
export function dayBuckets(start: Millis, now: Millis): number {
  return now <= start ? 0 : Math.ceil((now - start) / DAY_MS);
}

function lastReviewLanded(f: PaperFacts): Millis | null {
  let t: Millis | null = null;
  for (const r of f.submitted) {
    const at = r.firstCompleteSeenAt ?? reviewActivityTime(r);
    if (at !== null && (t === null || at > t)) t = at;
  }
  return t;
}

interface Acc {
  pids: number[];
  flaggedPids: number[];
  covered: number;
  firstPostDays: number[];
  waiting: number;
  nudges: { total: number; mentions: number; proxy: number; pings: number };
  stalePids: number[];
  comments: number;
  discussionComments: number;
  byStatus: Partial<Record<ReviewStatus, number>>;
  metaSubmitted: number;
  metaOf: number;
  daily: number[];
}

export function computeAcMetrics(ev: Evaluation, ctx: RuleContext): AcMetrics[] {
  const open = ctx.phases.discussionOpen;
  const opened = discussionOpened(ctx.phases, ctx.now);
  const buckets = dayBuckets(open, ctx.now);
  const accs = new Map<string, Acc>();

  for (const f of ev.facts.values()) {
    if (f.acSet.size === 0) continue;
    const result = ev.byPid.get(f.pid);
    const reviewerEmails = new Set(f.reviewerReviews.map((r) => r.email));
    // First discussion comment per reviewer, for the "reviewer still silent" proxy.
    const firstReviewerComment = new Map<string, Millis>();
    for (const c of f.discussionComments) {
      if (reviewerEmails.has(c.email) && !firstReviewerComment.has(c.email)) firstReviewerComment.set(c.email, c.time);
    }
    const stale = !f.decided && goneQuiet(f, ctx) !== null;
    const landed = lastReviewLanded(f);
    const clockStart = Math.max(open, landed ?? open);

    for (const ac of f.acSet) {
      let a = accs.get(ac);
      if (!a) {
        a = {
          pids: [],
          flaggedPids: [],
          covered: 0,
          firstPostDays: [],
          waiting: 0,
          nudges: { total: 0, mentions: 0, proxy: 0, pings: 0 },
          stalePids: [],
          comments: 0,
          discussionComments: 0,
          byStatus: {},
          metaSubmitted: 0,
          metaOf: 0,
          daily: new Array<number>(buckets).fill(0),
        };
        accs.set(ac, a);
      }
      a.pids.push(f.pid);
      if (result && result.severity > 0) a.flaggedPids.push(f.pid);
      if (stale) a.stalePids.push(f.pid);

      let first: Millis | null = null;
      for (const c of f.discussionComments) {
        if (c.email !== ac) continue;
        a.discussionComments++;
        if (first === null) first = c.time;
        const mentions = c.mentions.some((m) => reviewerEmails.has(m));
        let silent = false;
        for (const e of reviewerEmails) {
          const t = firstReviewerComment.get(e);
          if (t === undefined || t > c.time) {
            silent = true;
            break;
          }
        }
        if (mentions) a.nudges.mentions++;
        else if (silent) a.nudges.proxy++;
        if (mentions || silent) a.nudges.total++;
        if (c.kind === "ping") a.nudges.pings++;
      }
      if (first !== null) {
        a.covered++;
        a.firstPostDays.push(Math.max(0, first - clockStart) / DAY_MS);
      } else if (opened && ctx.now >= clockStart) {
        a.waiting++;
      }
      for (const c of f.pcComments) {
        if (c.email !== ac || c.time > ctx.now) continue;
        a.comments++;
        if (c.time < open) continue;
        const i = Math.floor((c.time - open) / DAY_MS);
        if (i >= 0 && i < buckets) a.daily[i]!++;
      }
      for (const r of f.bundle.reviews) {
        if (r.email !== ac) continue;
        a.metaOf++;
        a.byStatus[r.status] = (a.byStatus[r.status] ?? 0) + 1;
        if (isSubmitted(r)) a.metaSubmitted++;
      }
    }
  }

  const classified = ev.index.commentClassifier;
  const out: AcMetrics[] = [];
  for (const [email, a] of accs) {
    const person = ev.index.people.get(email);
    out.push({
      email,
      name: person?.name ?? email,
      tier: person?.tier ?? DEFAULT_TIER,
      pids: a.pids,
      load: a.pids.length,
      flagged: a.flaggedPids.length,
      flaggedPids: a.flaggedPids,
      coverage: { covered: a.covered, of: a.pids.length, share: opened ? a.covered / a.pids.length : null },
      timeToFirstPost: { medianDays: median(a.firstPostDays), posted: a.firstPostDays.length, waiting: a.waiting },
      nudges: classified ? { ...a.nudges, total: a.nudges.pings, source: classified } : { ...a.nudges, source: "proxy" },
      stale: a.stalePids.length,
      stalePids: a.stalePids,
      comments: a.comments,
      discussionComments: a.discussionComments,
      metareview: { byStatus: a.byStatus, submitted: a.metaSubmitted, of: a.metaOf, due: ctx.phases.decisionsDue },
      activity: { start: open, daily: a.daily },
    });
  }
  // Alphabetical, not ranked (spec §2: no leaderboards). The UI may re-sort by column.
  return out.sort((x, y) => x.email.localeCompare(y.email));
}
