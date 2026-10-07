// Reviewing progress by tier (spec §10.4 D, PLAN M12): the report shape.
// It is also the JSON body of GET /api/tier-progress, so this file has no
// imports (the web app type-checks it without Node types).
//
// Times are epoch milliseconds; emails are lowercase. Nothing here carries
// review or comment text: only pids, emails, names, titles, and counts.

/**
 * Escalation state of one late reserve review (definitions in compute.ts and
 * spec §10.4 D). In precedence order: replaced > replacement-needed > pinged > late.
 */
export type DropoutState = "late" | "pinged" | "replacement-needed" | "replaced";

export const DROPOUT_STATES: readonly DropoutState[] = ["late", "pinged", "replacement-needed", "replaced"];

export interface TierPerson {
  email: string;
  name: string;
  tier: string;
}

/** Outstanding and late reviews for one tier. */
export interface TierRow {
  tier: string;
  /** Distinct reviewers of this tier with at least one reviewer review. */
  reviewers: number;
  assigned: number;
  submitted: number;
  /** Not submitted, on an undecided paper. */
  outstanding: number;
  /** Outstanding after REVIEW_DUE, excluding reviews assigned after it. */
  late: number;
  /** Distinct reviewers with a late review. */
  latePeople: number;
  /** Submitted, but after REVIEW_DUE. */
  submittedLate: number;
  /** Outstanding reviews first seen after REVIEW_DUE (replacements): not late. */
  assignedAfterDue: number;
  reason: string;
}

export interface LateReview {
  pid: number;
  rid: number;
  person: TierPerson;
  lateDays: number;
}

export interface DropoutRow {
  pid: number;
  rid: number;
  title: string;
  person: TierPerson;
  lateDays: number;
  state: DropoutState;
  /** First AC/chair comment @mentioning them since REVIEW_DUE. */
  pingedAt: number | null;
  pingedBy: string | null;
  /** Reviewers added on the paper after REVIEW_DUE (first seen by a sync after it). */
  replacedBy: string[];
  reason: string;
}

export interface OwnPaper {
  pid: number;
  title: string;
  decision: string | null;
}

export interface AccountabilityRow {
  person: TierPerson;
  /** Papers they author (paper_author, synced from GET /papers). */
  ownPapers: OwnPaper[];
  assigned: number;
  submitted: number;
  /** Late now (outstanding after REVIEW_DUE). */
  lateOutstanding: number;
  /** Submitted after REVIEW_DUE. */
  submittedLate: number;
  /** Submitted reviews under PCS_THRESH_MIN_WORDS. */
  thin: number;
  ratedShort: number;
  ratedVague: number;
  reviewPids: number[];
  latePids: number[];
  thinPids: number[];
  summary: string;
}

export interface CoachingRow {
  pid: number;
  rid: number;
  ordinal: string | null;
  person: TierPerson;
  words: number;
  underFloor: boolean;
  ratedShort: boolean;
  ratedVague: boolean;
  reason: string;
  /** Path under PCS_HOTCRP_URL: /review/{pid}{ordinal}, or /review?p=&r= when unsubmitted. */
  hotcrpPath: string;
}

export interface WithholdRow {
  person: TierPerson;
  latePids: number[];
  /** Their own undecided papers whose reviews would be withheld. */
  withheldPids: number[];
  reason: string;
}

export interface WithholdDraft {
  /** PCS_POLICY_WITHHOLD_REVIEWS. When false, rows is empty and nothing is drafted. */
  enabled: boolean;
  tag: string;
  rows: WithholdRow[];
  /** A HotCRP bulk-assignment CSV (paper,action,tag) that would tag the papers. Never applied by this tool. */
  csv: string;
  /** A HotCRP search for the same papers. */
  search: string;
  note: string;
}

export interface ParticipationRow {
  tier: string;
  reviewers: number;
  /** Reviewers of this tier with any published comment on a paper they review (up to now). */
  commenters: number;
  /** Published non-response comments by this tier on papers they review (up to now). */
  comments: number;
  /** From the reviewer metrics (spec §5a): papers in discussion, and those with a comment since DISCUSSION_OPEN. */
  discussionPapers: number;
  discussionCommented: number;
  share: number | null;
  reason: string;
}

export interface TierProgressReport {
  now: number;
  reviewDue: number;
  /** REVIEW_DUE has passed. */
  deadlinePassed: boolean;
  tiers: TierRow[];
  late: LateReview[];
  dropout: {
    reserveTiers: string[];
    dropoutDays: number;
    counts: Record<DropoutState, number>;
    rows: DropoutRow[];
  };
  accountability: { note: string; rows: AccountabilityRow[] };
  coaching: { tiers: string[]; minWords: number; rows: CoachingRow[] };
  withhold: WithholdDraft;
  participation: { discussionOpened: boolean; rows: ParticipationRow[] };
}
