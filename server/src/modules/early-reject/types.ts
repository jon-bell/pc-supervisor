// Early reject (spec §10.4 E, PLAN M12): the report shape. It is also the JSON
// body of GET /api/early-reject, so this file has no imports.
//
// Times are epoch milliseconds; emails are lowercase. No review or comment
// text: pids, titles, emails, scores, and counts only.

export type EarlyRejectPolicyName = "reject_only" | "include_weak_reject";

/**
 * Where `now` is relative to the window:
 * - unconfigured: PCS_PHASE_EARLYREJECT_OPEN is unset.
 * - before: now < OPEN. Candidates are provisional (computed as of now).
 * - open: OPEN <= now <= CLOSE. Candidates as of OPEN; outcomes so far.
 * - closed: now > CLOSE. Candidates as of OPEN; outcomes as of CLOSE.
 */
export type WindowStatus = "unconfigured" | "before" | "open" | "closed";

export interface ErPerson {
  email: string;
  name: string;
  tier: string;
}

export interface CandidateReview {
  rid: number;
  person: ErPerson;
  /** Merit as of the candidate instant. */
  meritAtOpen: number;
  expertiseAtOpen: number | null;
  /** Merit as of the outcome instant (min(now, CLOSE)); null before the window. */
  meritNow: number | null;
  /** Merit raised during the window. */
  raised: boolean;
  /** Any merit change during the window (either direction). */
  changed: boolean;
  /** Published comments by this reviewer on the paper during the window. */
  windowComments: number;
  /** No merit change and no comment during the window (only once the window has opened). */
  noResponse: boolean;
}

export interface DiscussionSignals {
  /** Published non-response comments on the paper, up to the outcome instant. */
  comments: number;
  /** ... of them during the window. */
  windowComments: number;
  /** ... of them by the paper's ACs. */
  acComments: number;
  lastCommentAt: number | null;
  /** Reviewer reviews not submitted as of the candidate instant. */
  outstandingReviews: number;
  /** Reviewer reviews submitted during the window (no merit at open). */
  newReviewsInWindow: number;
}

export interface Candidate {
  pid: number;
  title: string;
  acs: string[];
  meritsAtOpen: number[];
  meritsNow: number[] | null;
  reviews: CandidateReview[];
  signals: DiscussionSignals;
  /** At least one merit raised during the window (spec §10.4 E "bumped"). */
  bumped: boolean;
  /** Every current merit is still in the band (informational). */
  stillInBand: boolean | null;
  /** Decided in HotCRP as of the outcome instant. */
  decision: string | null;
  reason: string;
}

export interface NoResponseRow {
  pid: number;
  rid: number;
  person: ErPerson;
  reason: string;
}

export interface MailDraft {
  /** A HotCRP search for the candidates: their pids, space-separated. */
  search: string;
  /** Path under PCS_HOTCRP_URL that opens the search. */
  searchPath: string;
  /** Path under PCS_HOTCRP_URL for the Mail tool with that search (reviewers of those papers). */
  mailPath: string;
  subject: string;
  body: string;
  hours: number;
}

export interface EarlyRejectReport {
  now: number;
  status: WindowStatus;
  open: number | null;
  close: number | null;
  /** How the close was set: the env var, or OPEN + PCS_EARLYREJECT_WINDOW_H. */
  closeSource: "env" | "window-hours" | null;
  /** The instant candidates are computed at (OPEN, or now before the window). */
  candidatesAt: number | null;
  /** The instant outcomes are computed at: min(now, CLOSE); null before the window. */
  outcomeAt: number | null;
  policy: EarlyRejectPolicyName;
  /** Highest merit in the band. */
  bandMax: number;
  minReviews: number;
  definition: string;
  candidates: Candidate[];
  bumped: number[];
  notBumped: number[];
  noResponse: NoResponseRow[];
  mail: MailDraft | null;
  /** The latest successful sync at or before OPEN, if any (candidates need one, or a backfill). */
  syncAtOpen: number | null;
  notes: string[];
}
