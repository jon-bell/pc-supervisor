// The quick-reject / desk-reject tracker (spec §10.4 B, PLAN M11). Pure
// functions, one per signal or state; reasons carry the numbers and the
// PCS_* setting involved. trackQuickReject() assembles the queue. See
// docs/spec.md §10.4 B for the semantics.
//
// The tool is read-only: AC decisions, chair actions, and appeal state are
// what the chair and ACs record in HotCRP as paper tags (PCS_QR_TAGS) and
// decisions. Nothing here writes them.

import type { QrTagKey, QuickRejectPolicy } from "../../config.js";
import type { RefcheckRow } from "../../imports/kinds.js";
import { DAY_MS } from "../../rules/phase.js";
import type {
  AcDecision,
  AppealState,
  ChairAction,
  OverdueReview,
  QrInput,
  QrInputPaper,
  QrInputReview,
  QrItem,
  QrMailDraft,
  QrReviewInfo,
  QrStage,
  QrWarning,
  QuickRejectReport,
  Signal,
} from "./types.js";

const SUBMITTED: ReadonlySet<string> = new Set(["delivered", "approved", "complete"]);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const days = (d: number) => `${Math.round(d * 10) / 10} days`;

/** Tag names, lowercased, without a "#value" suffix. */
export function tagSet(tags: readonly string[]): Set<string> {
  return new Set(tags.map((t) => t.replace(/^#/, "").replace(/#.*$/, "").toLowerCase()));
}

const has = (tags: Set<string>, policy: QuickRejectPolicy, k: QrTagKey) => tags.has(policy.tags[k].toLowerCase());

export function refcheckSignal(row: RefcheckRow | undefined, runId: number, policy: QuickRejectPolicy): Signal | null {
  if (!row) return null;
  const { hallucinatedMin, inFieldMin } = policy.refcheck;
  const why: string[] = [];
  if (row.hallucinated_refs >= hallucinatedMin) {
    why.push(`${plural(row.hallucinated_refs, "hallucinated reference")} (PCS_REFCHECK_HALLUCINATED_MIN=${hallucinatedMin})`);
  }
  if (row.in_field_refs < inFieldMin) {
    why.push(`${plural(row.in_field_refs, "in-field reference")}, fewer than PCS_REFCHECK_IN_FIELD_MIN=${inFieldMin}`);
  }
  if (why.length === 0) return null;
  return {
    kind: "refcheck",
    reason: `refcheck import #${runId}: ${why.join("; ")}${row.total_refs !== null ? ` of ${row.total_refs} references` : ""}`,
    evidence: {
      runId,
      hallucinatedRefs: row.hallucinated_refs,
      inFieldRefs: row.in_field_refs,
      ...(row.total_refs !== null ? { totalRefs: row.total_refs } : {}),
    },
  };
}

export function acFlagSignal(tags: Set<string>, policy: QuickRejectPolicy): Signal | null {
  if (!tags.has(policy.acFlagTag.toLowerCase())) return null;
  return { kind: "ac-flag", reason: `tagged #${policy.acFlagTag} (PCS_QR_AC_FLAG_TAG)`, evidence: { tag: policy.acFlagTag } };
}

export function reviewInfo(r: QrInputReview, input: Pick<QrInput, "due" | "now">, policy: QuickRejectPolicy): QrReviewInfo {
  const submitted = SUBMITTED.has(r.status);
  return {
    rid: r.rid,
    email: r.email,
    status: r.status,
    submitted,
    value: r.value,
    verdict: !submitted || r.value === null ? null : r.value <= policy.rejectMax ? "reject" : "keep",
    overdue: !submitted && input.due !== null && input.now > input.due,
  };
}

export function verdictSignal(reviews: readonly QrReviewInfo[], policy: QuickRejectPolicy): Signal | null {
  const done = reviews.filter((r) => r.submitted);
  const reject = done.filter((r) => r.verdict === "reject");
  if (reject.length === 0) return null;
  return {
    kind: "qr-verdict",
    reason: `${reject.length} of ${plural(done.length, "submitted quick-reject review")} vote reject (${policy.field} <= ${policy.rejectMax}, PCS_QR_REJECT_MAX; round ${policy.round})`,
    evidence: { rids: reject.map((r) => r.rid), rejectVotes: reject.length, submitted: done.length, assigned: reviews.length },
  };
}

export function acDecisionOf(tags: Set<string>, policy: QuickRejectPolicy): AcDecision {
  return has(tags, policy, "ac-reject") ? "reject" : has(tags, policy, "ac-keep") ? "keep" : "none";
}

export function chairActionOf(tags: Set<string>, policy: QuickRejectPolicy): ChairAction {
  return has(tags, policy, "chair-desk-reject") ? "desk-reject" : has(tags, policy, "chair-keep") ? "keep" : "none";
}

export function appealStateOf(tags: Set<string>, policy: QuickRejectPolicy): AppealState {
  if (has(tags, policy, "appeal-overturned")) return "overturned";
  if (has(tags, policy, "appeal-upheld")) return "upheld";
  return has(tags, policy, "appeal") ? "requested" : "none";
}

/** Whose move it is: an open appeal, else the chair after an AC reject, else the AC. */
export function stageOf(ac: AcDecision, chair: ChairAction, appeal: AppealState): QrStage {
  if (appeal === "requested") return "appeal";
  if (appeal !== "none" || chair !== "none") return "done";
  if (ac === "reject") return "chair-action";
  if (ac === "keep") return "done";
  return "ac-decision";
}

export function warningsOf(p: QrInputPaper, tags: Set<string>, policy: QuickRejectPolicy): QrWarning[] {
  const t = policy.tags;
  const out: QrWarning[] = [];
  const both = (a: QrTagKey, b: QrTagKey) => has(tags, policy, a) && has(tags, policy, b);
  for (const [a, b] of [["ac-reject", "ac-keep"], ["chair-desk-reject", "chair-keep"], ["appeal-upheld", "appeal-overturned"]] as const) {
    if (both(a, b)) out.push({ code: "CONFLICTING_TAGS", reason: `#${p.pid} has both #${t[a]} and #${t[b]}; the first wins here` });
  }
  const rejected = p.decision !== null && policy.rejectDecisions.some((d) => d.toLowerCase() === p.decision!.toLowerCase());
  const chair = chairActionOf(tags, policy);
  const appeal = appealStateOf(tags, policy);
  const decisions = `PCS_QR_REJECT_DECISIONS=${policy.rejectDecisions.join(",")}`;
  if (chair === "desk-reject" && appeal !== "overturned" && !rejected) {
    out.push({
      code: "DECISION_MISSING",
      reason: `#${p.pid} is tagged #${t["chair-desk-reject"]} but its decision is ${p.decision === null ? "unset" : `"${p.decision}"`}, not a reject (${decisions})`,
    });
  }
  if (appeal === "overturned" && rejected) {
    out.push({ code: "DECISION_STILL_REJECT", reason: `#${p.pid}: the appeal was overturned (#${t["appeal-overturned"]}) but the decision is still "${p.decision}"` });
  }
  if (appeal !== "none" && chair !== "desk-reject") {
    out.push({ code: "APPEAL_WITHOUT_DESK_REJECT", reason: `#${p.pid} has an appeal tag but no #${t["chair-desk-reject"]}` });
  }
  return out;
}

const QR_KEYS: readonly QrTagKey[] = ["ac-reject", "ac-keep", "chair-desk-reject", "chair-keep", "appeal", "appeal-upheld", "appeal-overturned"];

export function trackQuickReject(input: QrInput, policy: QuickRejectPolicy): QuickRejectReport {
  const notes: string[] = [];
  if (input.due === null) notes.push("PCS_PHASE_QUICKREJECT_DUE is not set, so no quick-reject review counts as overdue");
  if (!input.refcheck) notes.push("No refcheck import yet, so there are no refcheck signals (pcs import refcheck <file>)");

  const refcheck = new Map((input.refcheck?.rows ?? []).map((r) => [r.pid, r]));
  const reviewsByPid = new Map<number, QrInputReview[]>();
  for (const r of input.reviews) reviewsByPid.set(r.pid, [...(reviewsByPid.get(r.pid) ?? []), r]);

  const items: QrItem[] = [];
  const overdue: OverdueReview[] = [];
  let qrReviews = 0;
  let qrSubmitted = 0;
  for (const p of [...input.papers].sort((a, b) => a.pid - b.pid)) {
    const tags = tagSet(p.tags);
    const reviews = (reviewsByPid.get(p.pid) ?? []).sort((a, b) => a.rid - b.rid).map((r) => reviewInfo(r, input, policy));
    qrReviews += reviews.length;
    qrSubmitted += reviews.filter((r) => r.submitted).length;
    for (const r of reviews) {
      if (!r.overdue) continue;
      const d = (input.now - input.due!) / DAY_MS;
      overdue.push({
        pid: p.pid,
        rid: r.rid,
        email: r.email,
        status: r.status,
        daysOverdue: Math.round(d * 10) / 10,
        reason: `#${p.pid}: ${r.email}'s quick-reject review is ${r.status}, ${days(d)} after PCS_PHASE_QUICKREJECT_DUE`,
      });
    }
    const signals = [
      input.refcheck ? refcheckSignal(refcheck.get(p.pid), input.refcheck.runId, policy) : null,
      acFlagSignal(tags, policy),
      verdictSignal(reviews, policy),
    ].filter((s): s is Signal => s !== null);
    const stateTags = QR_KEYS.map((k) => policy.tags[k]).filter((t) => tags.has(t.toLowerCase()));
    if (signals.length === 0 && stateTags.length === 0) continue;
    const acDecision = acDecisionOf(tags, policy);
    const chairAction = chairActionOf(tags, policy);
    const appealState = appealStateOf(tags, policy);
    items.push({
      pid: p.pid,
      title: p.title,
      acs: [...p.acs].sort(),
      signals,
      reviews,
      acDecision,
      chairAction,
      decision: p.decision,
      appealState,
      stage: stageOf(acDecision, chairAction, appealState),
      stateTags,
      warnings: warningsOf(p, tags, policy),
    });
  }

  const byStage: Record<QrStage, number> = { "ac-decision": 0, "chair-action": 0, appeal: 0, done: 0 };
  const byAppeal: Record<AppealState, number> = { none: 0, requested: 0, upheld: 0, overturned: 0 };
  for (const i of items) {
    byStage[i.stage]++;
    byAppeal[i.appealState]++;
  }

  const draft = (label: string, recipients: string, pids: Iterable<number>): QrMailDraft[] => {
    const list = [...new Set(pids)].sort((a, b) => a - b);
    return list.length ? [{ label, recipients, search: list.join(" "), papers: list.length }] : [];
  };
  const mailDrafts = [
    ...draft(
      `Overdue quick-reject reviews (round ${policy.round})`,
      "Reviewers with incomplete reviews",
      overdue.map((o) => o.pid),
    ),
    ...draft("Quick-reject queue: AC decision needed", "Area chairs (metareviewers) of these papers", items.filter((i) => i.stage === "ac-decision").map((i) => i.pid)),
  ];

  return {
    policy,
    due: input.due,
    imports: { refcheckRunId: input.refcheck?.runId ?? null },
    counts: {
      items: items.length,
      byStage,
      byAppeal,
      qrReviews,
      qrReviewsSubmitted: qrSubmitted,
      overdueReviews: overdue.length,
      warnings: items.reduce((n, i) => n + i.warnings.length, 0),
    },
    items,
    overdueReviews: overdue,
    mailDrafts,
    notes,
  };
}
