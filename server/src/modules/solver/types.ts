// Types of the assignment solver (spec §10.5, PLAN M10b). The solver is pure:
// solve() takes a SolverInput (built from the store, the imports, and two
// read-only HotCRP downloads by load.ts) plus the policy and solver settings
// (PCS_* env), and returns a SolveReport. Nothing here talks to the network.

import type { AssignmentPolicy, SolverSettings } from "../../config.js";
import type { RevPrefRow } from "../../hotcrp/schemas.js";
import type { DoNotInviteRow, InviteRow } from "../../imports/kinds.js";
import type { AffinityScores } from "../../imports/scores.js";
import type { AssignmentReport, CurrentAssignment, Finding, ImportSnapshot, PaperInfo, PersonInfo } from "../assignment/types.js";

export interface SolverInput {
  /** Live papers by pid, with authors (email, affiliation). */
  papers: ReadonlyMap<number, PaperInfo>;
  /** Everyone the store knows, by lowercased email. */
  people: ReadonlyMap<string, PersonInfo>;
  /** Current slot-filling review assignments (primary/secondary/pc), with review status. */
  current: readonly CurrentAssignment[];
  /**
   * (pid, email) pairs that already hold a review that doesn't fill a slot
   * (quick-reject round under PCS_QR_EXCLUDE_FROM_SLOTS): never candidates,
   * never in the CSV.
   */
  blocked: readonly { pid: number; email: string }[];
  /** HotCRP's PC conflicts (get/pcconf), including author conflicts. */
  conflicts: readonly { pid: number; email: string }[];
  /** Latest `invites` import as of the solve time; undefined = none. */
  invites: ImportSnapshot<InviteRow> | undefined;
  /** Latest `do-not-invite` import; undefined = none. */
  doNotInvite: ImportSnapshot<DoNotInviteRow> | undefined;
  /** Merged tpms-scores + affinity-local matrix (imports/scores.ts); undefined = no scores. */
  scores: AffinityScores | undefined;
  /** HotCRP preferences (get/allrevpref); undefined = not fetched (PCS_SOLVER_W_HOTCRP=0 or no client). */
  prefs: readonly RevPrefRow[] | undefined;
}

export type SlotClass = "senior" | "third";
export type AffinitySource = "tpms" | "local" | "hotcrp" | "none";
export type CsvAction = "primary" | "secondary" | "pcreview" | "clearreview";

/** One review assignment in the solved assignment. */
export interface SolvedAssignment {
  pid: number;
  email: string;
  tier: string;
  slot: SlotClass;
  /** CSV action: the current type for kept assignments; new seniors primary, new third slot secondary. */
  action: Exclude<CsvAction, "clearreview">;
  /** Fixed by a lower bound: a started review, an AC-activated reserve, or a chair/AC placed as a reviewer. */
  pinned: "started" | "reserve" | "exempt" | null;
  /** Already assigned in HotCRP. */
  current: boolean;
  /** Normalized integer affinity (the edge's cost is its negative). */
  affinity: number;
  source: AffinitySource;
}

export interface CsvLine {
  pid: number;
  action: CsvAction;
  email: string;
  /** The round column: PCS_SOLVER_ROUND for new assignments, empty otherwise. */
  round: string;
}

export interface UnmetRequirement {
  pid: number;
  slot: SlotClass;
  have: number;
  need: number;
  /** Eligible candidates of that class for the paper before pruning (after conflicts, do-not-invite, reserve approval). */
  eligible: number;
  /** With the numbers and the PCS_* settings involved. */
  reason: string;
}

export interface LoadBandReport {
  tier: string;
  band: { min: number; max: number } | null;
  reviewers: number;
  /** load -> number of reviewers with that many assignments (a histogram, not a ranking). */
  histogram: { load: number; reviewers: number }[];
  under: number;
  over: number;
}

export type RepairKind = "cycle" | "institution";

export interface Repair {
  round: number;
  kind: RepairKind;
  /** The forbidden assignment(s): one per paper behind the cycle edge. */
  removed: { pid: number; email: string; affinity: number }[];
  /** Candidate edges forbidden: the removed assignments plus edges that would recreate the issue. */
  forbidden: number;
  reason: string;
}

export interface Unresolved {
  kind: RepairKind;
  pids: number[];
  emails: string[];
  reason: string;
}

export interface PinIssue {
  pid: number;
  email: string;
  reason: string;
}

export interface WeakCoverage {
  pid: number;
  /** Best eligible candidate score per class, 0-1 after source weighting; null = no eligible candidate. */
  bestSenior: number | null;
  bestThird: number | null;
  reason: string;
}

export interface CrossCheckFinding extends Finding {
  /** What in the solve report accounts for it; null = unexplained. */
  explainedBy: string | null;
}

export interface SolveReport {
  mode: "soft" | "hard";
  /** False only in hard mode when the lower bounds can't all be met. */
  feasible: boolean;
  /** Total cost of the final solve (load costs - affinity - slot/min bonuses). */
  objective: number;
  /** The objective without bonuses: sum of load costs minus total affinity. */
  affinityObjective: number;
  policy: AssignmentPolicy;
  settings: SolverSettings;
  sources: {
    tpmsRunId: number | null;
    localRunId: number | null;
    hotcrpPrefs: number | null;
    invitesRunId: number | null;
    doNotInviteRunId: number | null;
    conflicts: number;
  };
  counts: {
    papers: number;
    reviewers: number;
    nodes: number;
    edges: number;
    candidates: number;
    pinned: number;
    assignments: number;
    kept: number;
    added: number;
    cleared: number;
    solves: number;
  };
  /** Per paper and slot class, what the assignment still lacks (soft mode), or the lower bounds that failed (hard). */
  unmet: UnmetRequirement[];
  load: LoadBandReport[];
  repairs: Repair[];
  unresolved: Unresolved[];
  pinIssues: PinIssue[];
  coverage: { threshold: number; weak: WeakCoverage[]; unscoredAssignments: number; scoredPairs: number };
  assignments: SolvedAssignment[];
  /** Current assignments the CSV clears (unstarted reviews the solve dropped). */
  cleared: { pid: number; email: string }[];
  /** `paper,action,email,round`, header first: apply only through HotCRP, dry-run first. */
  csv: string;
  lines: CsvLine[];
  /** M10's validator run on the solved assignment. */
  crossCheck: { findings: CrossCheckFinding[]; unexplained: number; counts: AssignmentReport["counts"] };
  notes: string[];
  timing: { buildMs: number; solveMs: number[]; totalMs: number };
}
