// "What did the store know at instant t?" (flag-history reconstruction,
// spec §5c "Flag history"). Rewinds a SnapshotView to t using the same
// history the burndown uses (rules/burndown.ts):
//
// - a paper is decided at t when its decision was first seen at or before t
//   (unknown first-seen time = decided all along, as in the burndown);
// - a review's status, merit and expertise at t come from its latest
//   observed version at or before t (review_version); with no versions, the
//   current values once first_complete_seen_at <= t, else unsubmitted;
//   modified_at after t falls back to the latest version time <= t;
// - comments exist from their earliest known time (CommentView.time);
// - every review is kept: one not yet seen at t is assigned but unsubmitted.
//
// Not rewound (the store keeps no history for them): review word counts and
// ratings, AC assignments, tags, comment draft state, the people. Deleted
// reviews and comments are absent at every t.

import type { CommentView, Millis, PaperView, ReviewView, SnapshotView } from "../rules/model.js";

function reviewAt(r: ReviewView, t: Millis): ReviewView {
  const versions = r.versions.filter((v) => v.seenAt <= t);
  const firstComplete = r.firstCompleteSeenAt !== null && r.firstCompleteSeenAt <= t ? r.firstCompleteSeenAt : null;
  let status = r.status;
  let merit = r.merit;
  let expertise = r.expertise;
  if (r.versions.length > 0) {
    const cur = versions.at(-1);
    status = cur?.status ?? "empty";
    merit = cur?.merit ?? null;
    expertise = cur?.expertise ?? null;
  } else if (firstComplete === null && r.firstCompleteSeenAt !== null) {
    status = "empty";
    merit = null;
    expertise = null;
  }
  const modifiedAt = r.modifiedAt !== null && r.modifiedAt <= t ? r.modifiedAt : (versions.at(-1)?.seenAt ?? null);
  return { ...r, status, merit, expertise, modifiedAt, firstCompleteSeenAt: firstComplete, versions };
}

function paperAt(p: PaperView, t: Millis): PaperView {
  if (p.decision === null) return p;
  const decidedFrom = p.decisionSeenAt ?? -Infinity;
  return decidedFrom <= t ? p : { ...p, decision: null, decisionSeenAt: null };
}

export function snapshotAt(s: SnapshotView, t: Millis): SnapshotView {
  const comments: CommentView[] = s.comments.filter((c) => c.time <= t);
  return {
    ...s,
    papers: s.papers.map((p) => paperAt(p, t)),
    // Every review is kept: an assignment usually predates the first sync that
    // saw it, so a review not yet seen at t counts as assigned, unsubmitted.
    reviews: s.reviews.map((r) => reviewAt(r, t)),
    comments,
  };
}
