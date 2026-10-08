// The scenario format (spec §9.3, PLAN M2). A scenario is plain typed data:
// people, papers, assignments, and one or more stages of timeline events.
// Every time is symbolic (`When`): a day offset from a named phase date. The
// driver resolves them against PCS_PHASE_* / PCS_TZ at seed time, so no date
// is ever hard-coded in a scenario.
//
// All names and emails are invented; emails are @example.org (AGENTS.md).

import type { RatingFlag } from "@pcs/server/ratings";

/** Phase dates a `When` can be relative to (config.ts Phases). */
export const PHASE_NAMES = [
  "reviewDue",
  "responseOpen",
  "responseClose",
  "discussionOpen",
  "discussionClose",
  "decisionsDue",
] as const;
export type PhaseName = (typeof PHASE_NAMES)[number];

/**
 * A point in time: the phase's local calendar date plus `day` days, at local
 * time `time` ("HH:MM", in PCS_TZ). Without `time`, the phase's own local
 * time of day is kept. `day` may be negative.
 */
export interface When {
  phase: PhaseName;
  day: number;
  time?: string;
}

/** Shorthand: at("discussionOpen", 3, "10:00"). */
export function at(phase: PhaseName, day: number, time?: string): When {
  return time === undefined ? { phase, day } : { phase, day, time };
}

export type Role = "pc" | "chair";

export interface Person {
  email: string;
  first: string;
  last: string;
  affiliation?: string;
  /**
   * PC roles. [] for a person who is not on the PC; such a person is saved as
   * a HotCRP user only if they have tags (e.g. a reserve-pool designee).
   * PC members may also be paper authors (reciprocal reviewers, PLAN M10).
   */
  roles: readonly Role[];
  /** HotCRP user tags, e.g. ["junior"]. */
  tags?: readonly string[];
}

export interface Author {
  email: string;
  first: string;
  last: string;
  affiliation?: string;
}

export interface Paper {
  pid: number;
  title: string;
  /** Default: generated filler. */
  abstract?: string;
  authors: readonly Author[];
  /** Submission-option values by SubmissionField name (phase 2), e.g. { "Reserve designee": "x@example.org" }. */
  options?: Readonly<Record<string, string>>;
  /** Paper tags (no leading #), set in stage 1 through batch/assign.php (PLAN M11), e.g. ["qr-flag"]. */
  tags?: readonly string[];
  /** Discussion lead (a PC member, not an author), set in stage 1 through batch/assign.php `lead`. */
  lead?: string;
}

/** HotCRP assignment actions (batch/assign.php). metareview = area chair. */
export type AssignRole = "metareview" | "primary" | "secondary" | "pcreview";

export interface Assignment {
  pid: number;
  email: string;
  role: AssignRole;
  /** When the review was requested. Default: DEFAULT_REQUESTED_AT. */
  requestedAt?: When;
  /** Review round name (one of Scenario.reviewRounds), e.g. QUICKREJECT_ROUND. Default: the unnamed round. */
  round?: string;
}

/** Score fields by review-form UID, e.g. { OveMer: 3, RevExp: 4 }. */
export type Scores = Readonly<Record<string, number>>;

/** A review is submitted. Text is generated filler of exactly `words` words. */
export interface ReviewEvent {
  type: "review";
  at: When;
  pid: number;
  email: string;
  scores: Scores;
  /** Total words across the review's text fields (PapSum + ComAut). */
  words: number;
}

/** An already-submitted review changes its scores (HotCRP keeps the old version in history). */
export interface ScoreChangeEvent {
  type: "scoreChange";
  at: When;
  pid: number;
  email: string;
  scores: Scores;
}

export type Visibility = "rev" | "pc" | "admin";

export interface CommentEvent {
  type: "comment";
  at: When;
  /** Scenario-unique id, so later events (edit/delete) can name this comment. */
  key: string;
  pid: number;
  email: string;
  /** Emails of people @mentioned (written as "@First Last" at the start of the text). */
  mentions?: readonly string[];
  /** Filler words after the mentions. Default 40. */
  words?: number;
  visibility?: Visibility;
}

export interface CommentEditEvent {
  type: "commentEdit";
  at: When;
  key: string;
  /** New filler word count; the edit keeps the original mentions. Default 50. */
  words?: number;
}

export interface CommentDeleteEvent {
  type: "commentDelete";
  at: When;
  key: string;
}

/** An author response (response round 1), posted as the author contact. */
export interface ResponseEvent {
  type: "response";
  at: When;
  key: string;
  pid: number;
  /** Must be one of the paper's authors. */
  email: string;
  words?: number;
}

/** Decision name from HotCRP's default set ("Accepted", "Rejected"). */
export interface DecisionEvent {
  type: "decision";
  at: When;
  pid: number;
  decision: string;
}

/** Remove a review assignment (batch/assign.php clearreview). Use on unsubmitted reviews. */
export interface UnassignEvent {
  type: "unassign";
  at: When;
  pid: number;
  email: string;
}

/**
 * Add a review assignment during a stage (batch/assign.php), e.g. a
 * replacement reviewer after the deadline (PLAN M12). `timeRequested` is
 * warped to `at`. The reviewer must be on the PC and not an author.
 */
export interface AssignEvent {
  type: "assign";
  at: When;
  pid: number;
  email: string;
  role: Exclude<AssignRole, "metareview">;
}

/**
 * A PC member rates a submitted review (HotCRP review ratings, spec §1):
 * POST /{p}/reviewrating?r=<rid>&actas=<rater>, form-encoded
 * `user_rating=<flags>`. The rater must be the paper's metareviewer or a
 * co-reviewer whose own review is already submitted, and never the review's
 * author. A later rate event by the same rater on the same review replaces
 * their flags. HotCRP keeps no rating timestamp: `at` only orders the event
 * (after the rater's submission), and the driver applies a stage's ratings
 * after its other events.
 */
export interface RateEvent {
  type: "rate";
  at: When;
  pid: number;
  /** The rated review's reviewer. */
  email: string;
  rater: string;
  /** One or more of RATING_FLAGS ("short", "vague", "disrespectful", ...). */
  flags: readonly RatingFlag[];
}

export type ScenarioEvent =
  | AssignEvent
  | RateEvent
  | ReviewEvent
  | ScoreChangeEvent
  | CommentEvent
  | CommentEditEvent
  | CommentDeleteEvent
  | ResponseEvent
  | DecisionEvent
  | UnassignEvent;

export interface Stage {
  name: string;
  /** The PCS_NOW this stage's state is meant to be observed at (informational; printed by the CLI). */
  now?: When;
  events: readonly ScenarioEvent[];
}

export interface Scenario {
  name: string;
  description: string;
  people: readonly Person[];
  papers: readonly Paper[];
  /** Created in stage 1, before any event. */
  assignments: readonly Assignment[];
  /** At least one. Multi-stage scenarios are seeded with --stage 1, then --stage 2, ... */
  stages: readonly Stage[];
  /** Score fields every review must carry (default ["OveMer", "RevExp"]). */
  scoreFields?: readonly string[];
  /** Submission options to define in HotCRP settings (`sf`), phase 2. */
  submissionFields?: readonly SubmissionField[];
  /** Named review rounds to define besides the unnamed one, e.g. [QUICKREJECT_ROUND]. */
  reviewRounds?: readonly string[];
}

// ---------------------------------------------------------------------------
// Phase-2 foundations (PLAN Phase 2 intro; M10-M12 scenarios).

/**
 * A custom submission option, defined through batch/settings.php (`sf`,
 * matched by name, so re-seeding is idempotent). Values are set per paper in
 * savepapers JSON under the option's name, and GET /papers returns them under
 * the same name.
 */
export interface SubmissionField {
  name: string;
  /** text = free text (an email for the designee); dropdown = one of `values`. */
  type: "text" | "dropdown";
  values?: readonly string[];
  /** Who sees it in HotCRP. Default "admin" (chairs only). */
  visibility?: "all" | "review" | "admin";
}

/** Each submission names a senior author as its reserve ("reciprocal") reviewer (spec §10). */
export const RESERVE_DESIGNEE_FIELD: SubmissionField = { name: "Reserve designee", type: "text" };

/** A claimed exemption from naming a designee. The value set is synthetic; M11 makes it configurable. */
export const RESERVE_EXEMPTION_FIELD: SubmissionField = {
  name: "Reserve exemption",
  type: "dropdown",
  values: ["no-eligible-author", "all-authors-on-pc", "other"],
};

/** The quick-reject review round (spec §10.4 B). */
export const QUICKREJECT_ROUND = "quickreject";

/**
 * The four tiers of spec §10.2 as HotCRP user tags. Untagged PC members are
 * senior. Map them with PCS_TIER_TAGS=TIER_TAGS_ENV.
 */
export const TIER_TAGS = { junior: "junior", "reserve-active": "reserveactive", "reserve-pool": "reservepool" } as const;
export const TIER_TAGS_ENV = Object.entries(TIER_TAGS)
  .map(([tier, tag]) => `${tier}=${tag}`)
  .join(",");

/** Review requests default to four weeks before the review deadline. */
export const DEFAULT_REQUESTED_AT: When = at("reviewDue", -28, "09:00");
/** Papers are marked submitted six weeks before the review deadline. */
export const PAPER_SUBMITTED_AT: When = at("reviewDue", -42, "12:00");

/** The text fields reviews are written into, and how words are split between them. */
export const REVIEW_TEXT_FIELDS = ["PapSum", "ComAut"] as const;

/** The object an event acts on; events on one object must be strictly ordered in time. */
export function objectKey(e: ScenarioEvent): string {
  switch (e.type) {
    case "assign":
    case "review":
    case "scoreChange":
    case "unassign":
      return `review:${e.pid}:${e.email.toLowerCase()}`;
    case "comment":
    case "commentEdit":
    case "commentDelete":
    case "response":
      return `comment:${e.key}`;
    case "decision":
      return `decision:${e.pid}`;
    case "rate":
      return `rating:${e.pid}:${e.email.toLowerCase()}:${e.rater.toLowerCase()}`;
  }
}
