// JSON shapes of the local API (/api/*), shared by the server routes and the
// web app (type-only import from "@pcs/server/server/api-types").
// Self-contained on purpose: no imports, so the browser build can type-check
// it without Node types.
//
// Conventions: times are epoch milliseconds; emails are lowercase. Nothing
// here ever carries the HotCRP token. Review and comment text appears only in
// the paper drawer (PaperDetail), straight from the local store.

export interface Person {
  email: string;
  name: string;
  tier: string;
}

export interface Reason {
  rule: string;
  weight: number;
  /** Human-readable, with the actual numbers (spec §5c). */
  reason: string;
}

export interface MetaResponse {
  now: number;
  /** True when PCS_NOW pins the clock. */
  pinned: boolean;
  phase: string;
  tz: string;
  /** Base URL for deep links: `${hotcrpUrl}/paper/{pid}`, `/review/{pid}{ordinal}`. */
  hotcrpUrl: string;
  phases: {
    reviewDue: number;
    responseOpen: number | null;
    responseClose: number | null;
    discussionOpen: number;
    discussionClose: number;
    decisionsDue: number;
  };
  rules: { name: string; weight: number }[];
  /** Tier names in use: "senior" plus PCS_TIER_TAGS tiers. */
  tiers: string[];
  fields: { merit: string; expertise: string };
}

export interface TriageRow {
  pid: number;
  title: string;
  decision: string | null;
  acs: Person[];
  /** Current merits / expertise of submitted reviewer reviews, in review order. */
  merits: number[];
  expertise: number[];
  reviews: { submitted: number; assigned: number };
  /** Reviewer count per tier on this paper, e.g. { senior: 2, junior: 1 }. */
  tiers: Record<string, number>;
  severity: number;
  reasons: Reason[];
  lastActivity: number | null;
  decisionsDue: number;
}

export interface TriageResponse {
  now: number;
  /** Papers before filtering. */
  total: number;
  /** Severity desc, then time to decisions due, then pid. */
  papers: TriageRow[];
  facets: {
    acs: (Person & { papers: number })[];
    rules: { rule: string; papers: number }[];
    tiers: { tier: string; papers: number }[];
  };
}

export interface VersionInfo {
  at: number | null;
  source: "snapshot" | "history";
  status: string;
  merit: number | null;
  expertise: number | null;
  approximate: boolean;
}

export interface ReviewDetail {
  rid: number;
  ordinal: string | null;
  reviewer: Person;
  /** "AC" for the paper's area chairs, else "reviewer". */
  role: "AC" | "reviewer";
  rtype: number;
  status: string;
  merit: number | null;
  expertise: number | null;
  wordCount: number;
  ratings: string[];
  modifiedAt: number | null;
  /** When the review was first seen submitted (first complete version), if ever. */
  submittedAt: number | null;
  approximate: boolean;
  versions: VersionInfo[];
  /** Field display name -> text, in form order (current version). */
  text: { field: string; text: string }[];
}

export interface CommentDetail {
  cid: number;
  author: Person;
  role: "AC" | "reviewer" | "author" | "other";
  isResponse: boolean;
  draft: boolean;
  visibility: string;
  wordCount: number;
  mentions: Person[];
  /** Earliest known time (see views/snapshot.ts). */
  time: number;
  approximate: boolean;
  /** HotCRP modified_at, when later than `time` (edited). */
  editedAt: number | null;
  text: string;
}

export type TimelineEvent =
  | { kind: "review"; at: number; approximate: boolean; rid: number }
  | { kind: "score"; at: number; approximate: boolean; rid: number; field: "merit" | "expertise"; from: number; to: number }
  | { kind: "comment" | "response"; at: number; approximate: boolean; cid: number }
  | { kind: "decision"; at: number; approximate: boolean; decision: string };

export interface PaperDetail {
  now: number;
  pid: number;
  title: string;
  decision: string | null;
  tags: string[];
  acs: Person[];
  severity: number;
  reasons: Reason[];
  lastActivity: number | null;
  reviews: ReviewDetail[];
  comments: CommentDetail[];
  /** Oldest first. */
  timeline: TimelineEvent[];
}

export interface SyncRunInfo {
  id: number;
  kind: "sync" | "backfill";
  startedAt: number;
  finishedAt: number | null;
  /** The app clock at the run (PCS_NOW when pinned). */
  nowUsed: number;
  ok: boolean | null;
  counts: Record<string, number>;
  errors: string[];
}

export interface SyncStatus {
  running: boolean;
  /** The last finished manual sync's error, if it failed in this server process. */
  lastError: string | null;
  last: SyncRunInfo | null;
  lastSuccessful: SyncRunInfo | null;
  lastBackfill: SyncRunInfo | null;
  intervalMin: number;
}

export interface ApiError {
  error: string;
}

// ---------------------------------------------------------------------------
// M6: AC table, reviewer outliers, person page, overview (spec §5a, §5b, §5c)

export interface AcRow {
  person: Person;
  pids: number[];
  /** Papers they are an AC on, and those with severity > 0 (load vs flagged). */
  load: number;
  flagged: number;
  flaggedPids: number[];
  coverage: { covered: number; of: number; share: number | null };
  timeToFirstPost: { medianDays: number | null; posted: number; waiting: number };
  /** A labeled proxy: AC comments that @mention a reviewer, or posted while a reviewer had no comment yet. */
  nudges: { total: number; mentions: number; proxy: number };
  stale: number;
  stalePids: number[];
  /** Their comments since DISCUSSION_OPEN, across their papers. */
  discussionComments: number;
  metareview: { byStatus: Record<string, number>; submitted: number; of: number; due: number };
  /** Comments per 24 h from `start` (DISCUSSION_OPEN) to now. */
  activity: { start: number; daily: number[] };
}

export interface AcsResponse {
  now: number;
  /** Largest load, for the load bars. */
  maxLoad: number;
  /** Alphabetical by name (not ranked). */
  acs: AcRow[];
}

export type OutlierListId = "silentOnSplit" | "unansweredPings" | "late" | "thin";

export interface OutlierEntry {
  person: Person;
  /** The count compared against the list's bar. */
  count: number;
  pids: number[];
  detail: string;
}

export interface OutlierList {
  id: OutlierListId;
  label: string;
  /** The absolute bar a person must cross to appear (never a rank). */
  bar: string;
  total: number;
  /** One group per tier in /api/meta order (then any other tier seen); empty groups included. */
  byTier: { tier: string; entries: OutlierEntry[] }[];
}

export interface ReviewersResponse {
  now: number;
  /** People with at least one non-AC review assignment. */
  reviewers: number;
  tiers: string[];
  lists: OutlierList[];
}

export interface PersonPaper {
  pid: number;
  title: string;
  decision: string | null;
  role: "AC" | "reviewer";
  /** Their review on the paper (reviewer review, or the AC's metareview). */
  review: {
    rid: number;
    ordinal: string | null;
    status: string;
    submitted: boolean;
    merit: number | null;
    expertise: number | null;
    wordCount: number;
  } | null;
  /** All submitted reviewer merits on the paper, for context. */
  merits: number[];
  /** Their published non-response comments on the paper, and those since DISCUSSION_OPEN. */
  comments: number;
  discussionComments: number;
  lastComment: { cid: number; time: number; approximate: boolean; wordCount: number; excerpt: string } | null;
  /** The paper's fired rules (names) and severity. */
  rules: string[];
  severity: number;
  /** Their own flags on this paper. */
  flags: { silentOnSplit: boolean; outstanding: boolean; thin: boolean; unansweredPing: boolean };
}

export interface OpenPing {
  pid: number;
  title: string;
  since: number;
  ageDays: number;
  pings: number;
  mentionedAt: number | null;
  /** Older than PCS_THRESH_PING_DAYS (so it is in the unanswered-pings list). */
  overThreshold: boolean;
}

export interface PersonReviewerSummary {
  assigned: number;
  submitted: number;
  outstanding: number[];
  late: boolean;
  depth: {
    medianWords: number | null;
    pcMedianWords: number | null;
    thin: number;
    bottomDecile: number;
    ratedShort: number;
    ratedVague: number;
  };
  participation: { papers: number; commented: number; share: number | null };
  responsiveness: { medianDays: number | null; answered: number };
  movement: { reviews: number; pids: number[] };
  silentOnSplit: number[];
}

export interface PersonResponse {
  now: number;
  person: Person & { roles: string[] };
  pingDays: number;
  reviewer: PersonReviewerSummary | null;
  ac: AcRow | null;
  /** Outlier lists this person appears in. */
  outliers: OutlierListId[];
  /** AC papers first, then reviewer papers; pid order within each. */
  papers: PersonPaper[];
  openPings: OpenPing[];
}

export interface OverviewResponse {
  now: number;
  phase: string;
  /** Configured phase dates, in time order. */
  phases: { key: string; label: string; at: number }[];
  counts: {
    papers: number;
    /** Undecided, fewer than PCS_REVIEWS_REQUIRED submitted reviewer reviews. */
    reviewing: number;
    /** Undecided, with enough reviews. */
    discussing: number;
    decided: number;
    /** Undecided and split (no consensus). */
    noConsensus: number;
    /** Severity > 0. */
    flagged: number;
  };
  reviewsRequired: number;
  /** Papers by merit range (max - min) over >= 2 submitted reviewer merits, range 0..max. */
  spread: { range: number; papers: number; split: boolean }[];
  splitRange: number;
  /** Papers with fewer than 2 submitted merits (no spread yet). */
  spreadUnknown: number;
  /** Per AC, alphabetical by name (not ranked). */
  flaggedPerAc: { person: Person; load: number; flagged: number }[];
  /** Daily from REVIEW_DUE to now (rules/burndown.ts). */
  burndown: { t: number; undecided: number; noConsensus: number }[];
}

// ---------------------------------------------------------------------------
// Phase-2 modules (spec §10.4, PLAN M11). Structural copies of the module
// reports (server/src/modules/*/types.ts), kept import-free like the rest;
// the routes type-check the reports against them.

/** A module's activation (server/src/modules/status.ts). */
export interface ModuleStatusInfo {
  id: string;
  letter: string;
  title: string;
  /** The current extended phase (spec §10.1). */
  phase: string;
  active: boolean;
  activeIn: readonly string[];
  /** Span of the module's phases under the configured dates; null if none is configured. */
  window: { from: number | null; to: number | null } | null;
}

export interface ModuleResponseBase {
  now: number;
  tz: string;
  module: ModuleStatusInfo;
}

export interface AuthorHintInfo {
  name: string;
  source: string;
  venues: Record<string, number>;
  atVenues: number;
  matchedPapers: number;
  possiblySenior: boolean;
  /** Always says it's a hint, not a verdict. */
  text: string;
}

export interface ReserveFindingInfo {
  code: string;
  severity: "noncompliant" | "warning";
  pids: number[];
  emails: string[];
  reason: string;
}

export interface MailDraftInfo {
  label: string;
  /** HotCRP search (paper numbers) for the Mail tool. */
  search: string;
  recipients: string;
  papers: number;
}

export interface ReserveResponse extends ModuleResponseBase {
  policy: {
    designeeField: string;
    exemptionField: string;
    seniorityField: string;
    exemptions: readonly string[];
    exemptionAllPc: string;
    maxCover: number;
    tpmsMinPapers: number;
    dblp: { enabled: boolean; url: string; venues: readonly string[]; seniorMin: number; rps: number };
  };
  imports: { tpmsRegistrationsRunId: number | null };
  counts: { papers: number; designee: number; exempt: number; noncompliant: number; designees: number; warnings: number };
  papers: {
    pid: number;
    title: string;
    state: "designee" | "exempt" | "noncompliant" | "unchecked";
    designee: string | null;
    identifiedBy: "email" | "name" | null;
    exemption: string | null;
    seniorityNote: string | null;
    codes: string[];
    hints: AuthorHintInfo[];
  }[];
  designees: {
    email: string;
    name: string | null;
    pids: number[];
    cover: number;
    aliases: string[];
    tpms: { registered: boolean; papersUploaded: number | null } | null;
    codes: string[];
    hint: AuthorHintInfo | null;
  }[];
  findings: ReserveFindingInfo[];
  mailDrafts: (MailDraftInfo & { code: string })[];
  dblp: { enabled: boolean; source: string | null; looked: number; pending: number; failed: number };
  notes: string[];
}

export type QrStageName = "ac-decision" | "chair-action" | "appeal" | "done";
export type QrAppealState = "none" | "requested" | "upheld" | "overturned";

export interface QuickRejectItemInfo {
  pid: number;
  title: string;
  acs: string[];
  signals: {
    kind: "refcheck" | "ac-flag" | "qr-verdict";
    reason: string;
    evidence: Record<string, string | number | boolean | number[] | string[]>;
  }[];
  reviews: { rid: number; email: string; status: string; submitted: boolean; value: number | null; verdict: "reject" | "keep" | null; overdue: boolean }[];
  acDecision: "none" | "reject" | "keep";
  chairAction: "none" | "desk-reject" | "keep";
  decision: string | null;
  appealState: QrAppealState;
  stage: QrStageName;
  stateTags: string[];
  warnings: { code: string; reason: string }[];
}

export interface QuickRejectResponse extends ModuleResponseBase {
  policy: {
    round: string;
    field: string;
    rejectMax: number;
    acFlagTag: string;
    tags: Readonly<Record<string, string>>;
    rejectDecisions: readonly string[];
    excludeFromSlots: boolean;
    refcheck: { hallucinatedMin: number; inFieldMin: number };
  };
  due: number | null;
  imports: { refcheckRunId: number | null };
  counts: {
    items: number;
    byStage: Record<QrStageName, number>;
    byAppeal: Record<QrAppealState, number>;
    qrReviews: number;
    qrReviewsSubmitted: number;
    overdueReviews: number;
    warnings: number;
  };
  items: QuickRejectItemInfo[];
  overdueReviews: { pid: number; rid: number; email: string; status: string; daysOverdue: number; reason: string }[];
  mailDrafts: MailDraftInfo[];
  notes: string[];
}
