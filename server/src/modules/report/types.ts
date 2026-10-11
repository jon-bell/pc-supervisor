// Process report (spec §10.4 G, PLAN M13): the report shape. It is also the
// JSON body of GET /api/report, so this file has no imports (the web app
// type-checks it without Node types).
//
// Aggregates only: tiers, counts, rates, and distributions. No emails, names,
// titles, or review/comment text, so a screenshot of the Report page or the
// JSON identifies no one. Groups of people smaller than PCS_REPORT_MIN_CELL
// are suppressed: their numbers are null and `suppressed` is true.

/** A people group too small to show (fewer than PCS_REPORT_MIN_CELL people). */
export interface Cell {
  /** Distinct people in the group; null when suppressed. */
  people: number | null;
  suppressed: boolean;
}

export interface Bin {
  label: string;
  /** Inclusive lower bound (words, merit, or days). */
  from: number;
  count: number;
}

/** Junior vs senior depth: words in submitted reviewer reviews. */
export interface DepthRow extends Cell {
  tier: string;
  reviews: number | null;
  median: number | null;
  p25: number | null;
  p75: number | null;
  mean: number | null;
  /** Submitted reviews under PCS_THRESH_MIN_WORDS. */
  underFloor: number | null;
  bins: Bin[] | null;
  reason: string;
}

/** Timeliness: first submission vs REVIEW_DUE. */
export interface TimelinessRow extends Cell {
  tier: string;
  assigned: number | null;
  submitted: number | null;
  /** First submitted version at or before REVIEW_DUE. */
  onTime: number | null;
  /** After REVIEW_DUE (replacements assigned after the deadline are not late). */
  late: number | null;
  /** Assigned after REVIEW_DUE (replacements), submitted or not. */
  assignedAfterDue: number | null;
  notSubmitted: number | null;
  onTimeShare: number | null;
  /** Median of (first submission - REVIEW_DUE) in days; negative = early. */
  medianDaysVsDue: number | null;
  reason: string;
}

/** The merit distribution of submitted reviewer reviews. */
export interface MeritRow extends Cell {
  tier: string;
  reviews: number | null;
  /** One bin per merit value, over the range seen in any tier. */
  bins: Bin[] | null;
  mean: number | null;
  reason: string;
}

/** HotCRP review-rating flags received by submitted reviews (spec §10.4 G). */
export interface RatingRow extends Cell {
  tier: string;
  reviews: number | null;
  /** Reviews with at least one rating flag. */
  rated: number | null;
  /** Flag -> flags received (raters, summed over reviews). */
  counts: Record<string, number> | null;
  /** Flag -> flags per submitted review (2 decimals). */
  perReview: Record<string, number> | null;
  reason: string;
}

/** Score agreement. */
export interface AgreementRow extends Cell {
  tier: string;
  /** Merits on papers with at least 2 submitted reviewer merits. */
  reviews: number | null;
  /** Mean |merit - the paper's mean merit| (all its submitted reviewer merits). */
  meanAbsDev: number | null;
  /** Merits on papers with an accept- or reject-side decision. */
  decided: number | null;
  /** ... of them on the decision's side (merit >= PCS_MERIT_ACCEPT_MIN on accepted papers, below it on rejected). */
  onDecisionSide: number | null;
  share: number | null;
  reason: string;
}

export interface ReserveSection extends Cell {
  /** PCS_RESERVE_TIERS, plus "reserve-pool" (designated, not activated). */
  tiers: string[];
  /** People in a reserve tier: active ones (with the tiers counted as active) and the pool. */
  active: number | null;
  pool: number | null;
  /** active / (active + pool); null when nobody is designated. */
  activationRate: number | null;
  /** From the latest `invites` import, when there is one (rows, not people). */
  invites: { rows: number; approved: number; accepted: number; declined: number; activated: number } | null;
  /** Reserve reviewer reviews (from M12 tier-progress). */
  assigned: number | null;
  submitted: number | null;
  notSubmitted: number | null;
  submittedLate: number | null;
  /** (not submitted + submitted late) / assigned. */
  dropoutRate: number | null;
  /** M12 escalation states of reserve reviews that are late now (undecided papers only). */
  lateNow: Record<string, number> | null;
  reason: string;
}

export interface EarlyRejectYield {
  /** M12 window status: unconfigured | before | open | closed. */
  status: string;
  candidates: number;
  bumped: number;
  notBumped: number;
  /** Candidates whose current decision is on the reject side ("rejected in the end"). */
  rejected: number;
  accepted: number;
  undecided: number;
  /** rejected / candidates; null with no candidates. */
  yield: number | null;
  reason: string;
}

/**
 * Quick/desk-reject counts and appeals (spec §10.4 B), from the M11 tracker
 * (server/src/modules/quickreject). Paper counts, not people: not suppressed.
 * `available: false` only when no tracker is wired (numbers are never made up).
 */
export interface QuickRejectSummary {
  available: boolean;
  /** Papers in the tracker (any signal or quick-reject state tag). */
  queued: number | null;
  /** AC decided reject (the quick-reject verdict). */
  acReject: number | null;
  /** The chair desk-rejected. */
  deskRejected: number | null;
  /** The chair (or, with no chair action, the AC) kept the paper. */
  kept: number | null;
  /** Quick-reject round reviews: assigned, submitted, overdue after PCS_PHASE_QUICKREJECT_DUE. */
  reviews: { assigned: number; submitted: number; overdue: number } | null;
  /** filed = requested + upheld + overturned; pending = requested. */
  appeals: { filed: number; upheld: number; overturned: number; pending: number } | null;
  reason: string;
}

export interface DoNotInviteInfo {
  /** The latest do-not-invite import as of now, or null. */
  run: { id: number; importedAt: number; rows: number } | null;
  /** GET path for the carry-forward CSV (keeps emails: it is the chair's own list). */
  downloadPath: string;
  note: string;
}

export interface ExportInfo {
  /** PCS_PSEUDONYM_KEY is set; without it the export refuses to run. */
  keyConfigured: boolean;
  /** Short public fingerprint of the key (to check two exports used the same key); null when unset. */
  keyId: string | null;
  files: string[];
  zipPath: string;
  filePath: string;
  note: string;
}

export interface ProcessReport {
  now: number;
  /** The extended phase at now. */
  phase: string;
  /** False before the after-decisions phase (activeModules G): numbers can still change. */
  final: boolean;
  minCell: number;
  /** Tier order used in every table. */
  tiers: string[];
  totals: { papers: number; decided: number; accepted: number; rejected: number; reviewerReviews: number; submitted: number };
  depth: { minWords: number; rows: DepthRow[] };
  timeliness: { reviewDue: number; rows: TimelinessRow[] };
  merits: { field: string; acceptMin: number; rows: MeritRow[] };
  /** enabled false: HotCRP has review ratings off (no rows; hidden, not zero). */
  ratings: { enabled: boolean; names: string[]; rows: RatingRow[] };
  agreement: { rows: AgreementRow[] };
  reserve: ReserveSection;
  earlyReject: EarlyRejectYield;
  quickReject: QuickRejectSummary;
  doNotInvite: DoNotInviteInfo;
  export: ExportInfo;
  notes: string[];
}
