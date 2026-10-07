// Types of the quick-reject / desk-reject tracker (spec §10.4 B, PLAN M11).
// trackQuickReject() is pure: a QrInput (built from the store and the
// refcheck import by load.ts) and a QuickRejectPolicy (PCS_QR_*,
// PCS_REFCHECK_*) in, a QuickRejectReport out. Nothing here calls HotCRP.

import type { QuickRejectPolicy } from "../../config.js";
import type { RefcheckRow } from "../../imports/kinds.js";

export interface QrInputPaper {
  pid: number;
  title: string;
  /** null = undecided. */
  decision: string | null;
  /** Tag names as synced (values like "#2" are ignored). */
  tags: readonly string[];
  acs: readonly string[];
}

export interface QrInputReview {
  rid: number;
  pid: number;
  email: string;
  status: string;
  /** The verdict field's value (PCS_QR_FIELD), if numeric. */
  value: number | null;
}

export interface QrInput {
  papers: readonly QrInputPaper[];
  /** Reviews (not metareviews) in the quick-reject round. */
  reviews: readonly QrInputReview[];
  refcheck: { runId: number; rows: readonly RefcheckRow[] } | undefined;
  /** PCS_PHASE_QUICKREJECT_DUE (epoch ms), if set. */
  due: number | null;
  /** App clock (epoch ms). */
  now: number;
}

export type SignalKind = "refcheck" | "ac-flag" | "qr-verdict";

export interface Signal {
  kind: SignalKind;
  /** With numbers and the PCS_* setting involved. */
  reason: string;
  /** What the signal rests on (import run and counts, the tag, the review ids). No text. */
  evidence: Record<string, string | number | boolean | number[] | string[]>;
}

export type AcDecision = "none" | "reject" | "keep";
export type ChairAction = "none" | "desk-reject" | "keep";
/** Required on every item (spec §10.4 B); "none" when no appeal was filed. */
export type AppealState = "none" | "requested" | "upheld" | "overturned";
/** Whose move it is. */
export type QrStage = "ac-decision" | "chair-action" | "appeal" | "done";

export type QrWarningCode =
  | "CONFLICTING_TAGS"
  | "DECISION_MISSING"
  | "DECISION_STILL_REJECT"
  | "APPEAL_WITHOUT_DESK_REJECT";

export interface QrWarning {
  code: QrWarningCode;
  reason: string;
}

export interface QrReviewInfo {
  rid: number;
  email: string;
  status: string;
  submitted: boolean;
  value: number | null;
  verdict: "reject" | "keep" | null;
  overdue: boolean;
}

export interface QrItem {
  pid: number;
  title: string;
  acs: string[];
  signals: Signal[];
  reviews: QrReviewInfo[];
  acDecision: AcDecision;
  chairAction: ChairAction;
  decision: string | null;
  appealState: AppealState;
  stage: QrStage;
  /** The quick-reject vocabulary tags present on the paper (the evidence for the states). */
  stateTags: string[];
  warnings: QrWarning[];
}

export interface OverdueReview {
  pid: number;
  rid: number;
  email: string;
  status: string;
  daysOverdue: number;
  reason: string;
}

export interface QrMailDraft {
  label: string;
  search: string;
  recipients: string;
  papers: number;
}

export interface QuickRejectReport {
  policy: QuickRejectPolicy;
  due: number | null;
  imports: { refcheckRunId: number | null };
  counts: {
    items: number;
    byStage: Record<QrStage, number>;
    byAppeal: Record<AppealState, number>;
    qrReviews: number;
    qrReviewsSubmitted: number;
    overdueReviews: number;
    warnings: number;
  };
  /** Papers with at least one signal or quick-reject state tag, by pid. */
  items: QrItem[];
  overdueReviews: OverdueReview[];
  mailDrafts: QrMailDraft[];
  notes: string[];
}
