// The rules engine's input: a plain-data "snapshot view" of the local store
// (spec §3). The store -> view adapter (M5) builds it with a handful of SQL
// queries; nothing here knows about SQLite, HotCRP JSON, or text bodies.
//
// Conventions:
// - Every instant is epoch milliseconds (`Millis`). The adapter converts.
// - Emails are lower-cased by the adapter; all joins are by email.
// - Rows can arrive in any order. `indexSnapshot()` (facts.ts) groups them by
//   pid in one pass, so a view may hold one paper (drawer, per-paper reload) or
//   all 2,400 papers; the engine is O(rows) either way.
// - No review or comment text: only counts and flags derived from it.
//
// Column mapping from the store (spec §3):
//   PaperView    <- paper (+ decision first-seen time from snapshot diffs)
//   PersonView   <- person
//   AcView       <- the paper's area chairs per PCS_AC_ROLE (default `meta`:
//                   holders of an rtype 5 review on that paper)
//   ReviewView   <- review (+ review_version rows as `versions`, + ratings
//                   as counts per flag)
//   CommentView  <- comment (deleted comments are left out by the adapter)

import type { CommentKind } from "../classifier/kinds.js";
import type { RatingCounts } from "../ratings.js";

/** Epoch milliseconds. */
export type Millis = number;

/**
 * Reviewer tier from PCS_TIER_TAGS (e.g. "junior", "reciprocal"). Untagged
 * people are "senior". Tier names are configurable, so this is a string.
 */
export type Tier = string;
export const DEFAULT_TIER: Tier = "senior";

export interface PaperView {
  pid: number;
  title: string;
  /**
   * The decision label, or null while undecided. The adapter maps HotCRP's
   * "undecided" (decision 0 / empty) to null. A decided paper fires no rules.
   */
  decision: string | null;
  /** When the sync first saw the current decision; null if undecided or unknown. Used by the burndown. */
  decisionSeenAt: Millis | null;
  tags: readonly string[];
}

export interface PersonView {
  email: string;
  name: string;
  tier: Tier;
  /** HotCRP roles, e.g. ["chair"], ["pc"]. */
  roles: readonly string[];
}

/** One (paper, area chair) pair. A paper may have co-ACs or none. */
export interface AcView {
  pid: number;
  email: string;
}

/** HotCRP review status strings (spec §1). */
export type ReviewStatus = "empty" | "acknowledged" | "draft" | "delivered" | "approved" | "complete";

/** Statuses that count as a submitted ("complete") review. */
export const SUBMITTED_STATUSES: ReadonlySet<ReviewStatus> = new Set(["delivered", "approved", "complete"]);

export interface ReviewVersionView {
  /** When this version was first observed (snapshot) or recorded (history backfill). */
  seenAt: Millis;
  merit: number | null;
  expertise: number | null;
  status: ReviewStatus;
}

export interface ReviewView {
  rid: number;
  pid: number;
  email: string;
  /** 1 ext, 2 PC, 3 secondary, 4 primary, 5 metareview. */
  rtype: number;
  status: ReviewStatus;
  /** HotCRP review ordinal letter ("A"), or null if not yet submitted. */
  ordinal: string | null;
  /** Current value of PCS_FIELD_MERIT, or null if unset. */
  merit: number | null;
  /** Current value of PCS_FIELD_EXPERTISE, or null if unset. */
  expertise: number | null;
  /** Words across the review's text fields (current version). */
  wordCount: number;
  /**
   * HotCRP review ratings as raters per flag ({short: 2, vague: 1}; spec §1,
   * ratings.ts). Empty when unrated, and when ratings are off (then
   * SnapshotView.ratingsEnabled is false).
   */
  ratings: RatingCounts;
  /** HotCRP modified_at, or null when HotCRP omits it (spec §1). */
  modifiedAt: Millis | null;
  firstSeenAt: Millis;
  /** When the sync first saw this review in a submitted status; null if never. */
  firstCompleteSeenAt: Millis | null;
  /**
   * Every observed version, oldest first, the current one included (from
   * review_version). May be empty if history is unknown; rules then treat
   * the review as never having moved.
   */
  versions: readonly ReviewVersionView[];
}

export interface CommentView {
  cid: number;
  pid: number;
  /** Author email. For responses, whichever author posted it. */
  email: string;
  /** An author response (HotCRP `response`). */
  isResponse: boolean;
  draft: boolean;
  /** HotCRP visibility: "au" | "rev" | "pc" | "admin". Informational only. */
  visibility: string;
  wordCount: number;
  /** Emails resolved from @mentions in the text (spec §3). */
  mentions: readonly string[];
  /** Earliest known creation time: min(first_seen_at, modified_at at first sight). */
  time: Millis;
  /** True when `time` is a best guess (comment existed before the first sync). */
  approximate: boolean;
  /**
   * The comment's type (spec §5e): the chair's label, else the classifier's;
   * null/absent when unclassified or the classifier is off.
   */
  kind?: CommentKind | null;
}

export interface SnapshotView {
  papers: readonly PaperView[];
  people: readonly PersonView[];
  acs: readonly AcView[];
  reviews: readonly ReviewView[];
  comments: readonly CommentView[];
  /**
   * False when the instance has review ratings off (HotCRP `review_rating:
   * no`): the rating-based signals (THIN_REVIEWS' rating clause,
   * REVIEW_FLAGGED, reviewer rating flags) are then hidden, not zero.
   * Absent = enabled (HotCRP's default).
   */
  ratingsEnabled?: boolean;
  /**
   * Which classifier labelled the comments' `kind` (spec §5e), or absent/null
   * when PCS_COMMENT_CLASSIFIER is off. With it set, AC nudges count pings.
   */
  commentClassifier?: "heuristic" | "model" | null;
}
