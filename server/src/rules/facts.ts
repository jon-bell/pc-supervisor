// Grouping and per-paper derived facts shared by rules and metrics.
//
// indexSnapshot() makes one pass over each row array (O(rows)); paperFacts()
// is O(rows of that paper). Nothing scans across papers, so evaluating 2,400
// papers is linear in the snapshot size.
//
// Shared definitions (also documented in spec §5c):
// - Reviewer: a review on the paper that is not a metareview (rtype 5) and
//   whose holder is not one of the paper's ACs. AC reviews are kept apart.
// - Submitted: status delivered | approved | complete (SUBMITTED_STATUSES).
// - Published comment: not a draft. "Discussion comment": published, not an
//   author response, posted at or after DISCUSSION_OPEN.
// - Last activity: the latest of (a) each review's modified_at, falling back
//   to first_complete_seen_at when HotCRP omits modified_at, over reviewer AND
//   AC reviews, and (b) each published non-response comment's time, AC
//   comments included. Author responses are not PC activity.
// - Movement: a merit change between consecutive observed versions of a
//   reviewer review where the later version was seen at or after
//   DISCUSSION_OPEN. Expertise-only changes are not movement for the rules
//   (the reviewer metric counts them separately).

import type { RuleContext } from "./context.js";
import {
  SUBMITTED_STATUSES,
  type AcView,
  type CommentView,
  type Millis,
  type PaperView,
  type PersonView,
  type ReviewView,
  type SnapshotView,
} from "./model.js";

/** One paper's rows. `comments` are sorted by time (then cid). */
export interface PaperBundle {
  paper: PaperView;
  acs: readonly string[];
  reviews: readonly ReviewView[];
  comments: readonly CommentView[];
}

export interface SnapshotIndex {
  /** One bundle per paper, in pid order. */
  bundles: readonly PaperBundle[];
  byPid: ReadonlyMap<number, PaperBundle>;
  people: ReadonlyMap<string, PersonView>;
  /** SnapshotView.ratingsEnabled (default true). */
  ratingsEnabled: boolean;
  /** SnapshotView.commentClassifier: which classifier labelled comment kinds, or null (none). */
  commentClassifier: "heuristic" | "model" | null;
}

function groupByPid<T extends { pid: number }>(rows: readonly T[]): Map<number, T[]> {
  const m = new Map<number, T[]>();
  for (const r of rows) {
    let a = m.get(r.pid);
    if (!a) m.set(r.pid, (a = []));
    a.push(r);
  }
  return m;
}

const byTime = (a: CommentView, b: CommentView): number => a.time - b.time || a.cid - b.cid;

/** Group a snapshot by paper. Rows for pids not in `papers` are ignored. */
export function indexSnapshot(s: SnapshotView): SnapshotIndex {
  const reviews = groupByPid(s.reviews);
  const comments = groupByPid(s.comments);
  const acs = groupByPid<AcView>(s.acs);
  const papers = [...s.papers].sort((a, b) => a.pid - b.pid);
  const bundles: PaperBundle[] = [];
  const byPid = new Map<number, PaperBundle>();
  for (const paper of papers) {
    const b: PaperBundle = {
      paper,
      acs: [...new Set((acs.get(paper.pid) ?? []).map((a) => a.email))],
      reviews: [...(reviews.get(paper.pid) ?? [])].sort((x, y) => x.rid - y.rid),
      comments: [...(comments.get(paper.pid) ?? [])].sort(byTime),
    };
    bundles.push(b);
    byPid.set(paper.pid, b);
  }
  return {
    bundles,
    byPid,
    people: new Map(s.people.map((p) => [p.email, p])),
    ratingsEnabled: s.ratingsEnabled !== false,
    commentClassifier: s.commentClassifier ?? null,
  };
}

export function isSubmitted(r: Pick<ReviewView, "status">): boolean {
  return SUBMITTED_STATUSES.has(r.status);
}

/** The time a review last showed activity, or null if none is known. */
export function reviewActivityTime(r: ReviewView): Millis | null {
  return r.modifiedAt ?? r.firstCompleteSeenAt;
}

export interface MeritMove {
  rid: number;
  email: string;
  from: number;
  to: number;
  at: Millis;
}

/** Merit (and optionally expertise) changes seen at or after `since`. */
export function movesSince(r: ReviewView, since: Millis, field: "merit" | "expertise" = "merit"): MeritMove[] {
  const out: MeritMove[] = [];
  const v = r.versions;
  for (let i = 1; i < v.length; i++) {
    const prev = v[i - 1]![field];
    const cur = v[i]![field];
    if (v[i]!.seenAt >= since && prev !== null && cur !== null && prev !== cur) {
      out.push({ rid: r.rid, email: r.email, from: prev, to: cur, at: v[i]!.seenAt });
    }
  }
  return out;
}

export interface PaperFacts {
  bundle: PaperBundle;
  pid: number;
  decided: boolean;
  acSet: ReadonlySet<string>;
  /** Reviewer (non-AC) reviews, rid order. */
  reviewerReviews: readonly ReviewView[];
  /** Submitted reviewer reviews, rid order. */
  submitted: readonly ReviewView[];
  /** Current merits of submitted reviewer reviews (nulls dropped), rid order. */
  merits: readonly number[];
  /** Published, non-response comments, time order. */
  pcComments: readonly CommentView[];
  /** pcComments at or after DISCUSSION_OPEN. */
  discussionComments: readonly CommentView[];
  /** Published author responses, time order. */
  responses: readonly CommentView[];
  /** Emails with at least one discussion comment. */
  discussionCommenters: ReadonlySet<string>;
  lastActivity: Millis | null;
  /** The review part of lastActivity alone (GONE_QUIET recomputes the comment part when it ignores comment types). */
  reviewActivity: Millis | null;
  /** Reviewer merit moves at or after DISCUSSION_OPEN. */
  moves: readonly MeritMove[];
}

export function paperFacts(b: PaperBundle, ctx: RuleContext): PaperFacts {
  const open = ctx.phases.discussionOpen;
  const acSet = new Set(b.acs);
  const reviewerReviews = b.reviews.filter((r) => r.rtype !== 5 && !acSet.has(r.email));
  const submitted = reviewerReviews.filter(isSubmitted);
  const merits: number[] = [];
  for (const r of submitted) if (r.merit !== null) merits.push(r.merit);

  const pcComments: CommentView[] = [];
  const responses: CommentView[] = [];
  for (const c of b.comments) {
    if (c.draft) continue;
    (c.isResponse ? responses : pcComments).push(c);
  }
  const discussionComments = pcComments.filter((c) => c.time >= open);

  let lastActivity: Millis | null = null;
  const bump = (t: Millis | null) => {
    if (t !== null && (lastActivity === null || t > lastActivity)) lastActivity = t;
  };
  for (const r of b.reviews) bump(reviewActivityTime(r));
  const reviewActivity: Millis | null = lastActivity;
  for (const c of pcComments) bump(c.time);

  const moves: MeritMove[] = [];
  for (const r of reviewerReviews) moves.push(...movesSince(r, open));

  return {
    bundle: b,
    pid: b.paper.pid,
    decided: b.paper.decision !== null,
    acSet,
    reviewerReviews,
    submitted,
    merits,
    pcComments,
    discussionComments,
    responses,
    discussionCommenters: new Set(discussionComments.map((c) => c.email)),
    lastActivity,
    reviewActivity,
    moves,
  };
}

/** Median of a list (mean of the middle two for even lengths); null if empty. */
export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Nearest-rank percentile (p in 0..100); null if empty. */
export function percentile(xs: readonly number[], p: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * s.length));
  return s[Math.min(rank, s.length) - 1]!;
}
