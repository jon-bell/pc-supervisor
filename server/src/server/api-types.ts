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
