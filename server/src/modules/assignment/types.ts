// Types of the assignment validator (spec §10.4 C, PLAN M10). The validator
// is pure: validate() takes a ValidatorInput (built from the store and the
// imports by load.ts) and an AssignmentPolicy (PCS_* env), and returns an
// AssignmentReport. Nothing here talks to HotCRP or the network.

import type { AssignmentPolicy } from "../../config.js";
import type { DoNotInviteRow, InviteRow } from "../../imports/kinds.js";
import type { CoauthorshipSource } from "./dblp.js";

/** Which assignment is being validated. */
export type AssignmentSource = "hotcrp" | "tpms";

export type Check = "composition" | "load" | "conflict" | "cycle" | "reserve" | "input";

export type FindingCode =
  // composition (per paper)
  | "ALL_JUNIOR_PANEL"
  | "SENIOR_MISSING"
  | "THIRD_SLOT_MISSING"
  | "THIRD_SLOT_EXTRA"
  // load bands (per person)
  | "LOAD_OVER"
  | "LOAD_UNDER"
  // conflict sanity (per reviewer/paper)
  | "AUTHOR_IS_REVIEWER"
  | "SAME_AFFILIATION"
  | "COAUTHOR"
  // reciprocal cycles
  | "RECIPROCAL_CYCLE"
  // reserve candidates
  | "RESERVE_NOT_APPROVED"
  | "DO_NOT_INVITE"
  // input rows (mostly TPMS)
  | "UNKNOWN_PAPER"
  | "NOT_PC_MEMBER"
  | "DUPLICATE_ROW";

export interface Finding {
  check: Check;
  code: FindingCode;
  /** The paper, for per-paper and per-row findings. */
  pid?: number;
  /** People involved. For a cycle, in cycle order (each is an author whose paper the next one reviews). */
  emails: string[];
  /** For a cycle: the papers behind each edge, in the same order as `emails`. */
  cyclePids?: number[][];
  /** Human-readable, with the actual numbers and the PCS_* setting involved. Never review text. */
  reason: string;
  /** True when the row is left out of the generated assignment CSV. */
  dropped?: boolean;
}

/** One proposed review assignment. */
export interface ProposedRow {
  pid: number;
  /** Lowercased. */
  email: string;
  /** TPMS affinity, if any (higher = better). */
  score: number | null;
}

export interface PaperInfo {
  pid: number;
  authors: readonly { email: string | null; affiliation: string | null }[];
}

export interface PersonInfo {
  email: string;
  affiliation: string | null;
  /** On the PC now (in /pc, not removed). */
  isPc: boolean;
  /** PCS_TIER_TAGS tier, or "senior". */
  tier: string;
  /** Chairs and area chairs: no reviewer load band. */
  exempt: boolean;
}

/** A current HotCRP review assignment (not metareview), with its review's status. */
export interface CurrentAssignment {
  pid: number;
  email: string;
  role: "primary" | "secondary" | "pc";
  /** HotCRP review status ("empty", "draft", "complete", ...), null if no review row is stored. */
  status: string | null;
}

export interface ImportSnapshot<R> {
  runId: number;
  rows: readonly R[];
}

export interface ValidatorInput {
  source: AssignmentSource;
  /** Live papers by pid. */
  papers: ReadonlyMap<number, PaperInfo>;
  /** Everyone the store knows, by lowercased email. */
  people: ReadonlyMap<string, PersonInfo>;
  /** The assignment to validate: current HotCRP review assignments, or the latest TPMS import. */
  proposal: readonly ProposedRow[];
  /** Current HotCRP review assignments (for clearreview lines and existing roles). */
  current: readonly CurrentAssignment[];
  /** Latest `invites` import as of the validation time; undefined = none imported. */
  invites: ImportSnapshot<InviteRow> | undefined;
  /** Latest `do-not-invite` import; undefined = none imported. */
  doNotInvite: ImportSnapshot<DoNotInviteRow> | undefined;
  /** Import run the TPMS proposal came from (source "tpms"). */
  tpmsRunId?: number;
  /** Optional co-authorship evidence (PCS_CONFLICT_DBLP). */
  coauthors?: CoauthorshipSource;
}

/** One line of the generated HotCRP assignment CSV. */
export interface FixupLine {
  pid: number;
  action: "primary" | "secondary" | "pcreview" | "clearreview";
  email: string;
  /** Why the line is there: a senior slot, the third slot, or removing a dropped/trimmed assignment. */
  slot: "senior" | "third" | "remove";
}

/** What the paper still needs once the fix-up CSV is applied. */
export interface FixupGap {
  pid: number;
  seniorsMissing: number;
  thirdMissing: number;
}

export interface FixupReport {
  /** `paper,action,user` CSV with a header row, ready for HotCRP's assignment upload (dry-run first). */
  csv: string;
  lines: FixupLine[];
  gaps: FixupGap[];
  /** Dropped or trimmed assignments NOT removed because their review is already started. */
  keptStarted: { pid: number; email: string; status: string }[];
}

export interface AssignmentReport {
  source: AssignmentSource;
  policy: AssignmentPolicy;
  imports: { invitesRunId: number | null; doNotInviteRunId: number | null; tpmsRunId: number | null };
  counts: { papers: number; rows: number; rowsKept: number; findings: number; cycles: number };
  /** Ordered by check, then pid, then email. */
  findings: Finding[];
  /** True when more than PCS_CYCLE_MAX_REPORT cycles exist (the rest are not listed). */
  cyclesTruncated: boolean;
  fixup: FixupReport;
  /** Notes about checks that could not run (e.g. DBLP requested without a provider). */
  notes: string[];
}
