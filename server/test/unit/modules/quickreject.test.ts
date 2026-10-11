// Quick-reject / desk-reject tracker (spec §10.4 B, PLAN M11): signals,
// states from tags, stage, warnings, overdue reviews, and the queue; plus the
// module activation window (modules/status.ts). Synthetic data only.

import { describe, expect, it } from "vitest";
import { DEFAULT_QUICKREJECT_POLICY, QR_TAG_DEFAULTS, type QuickRejectPolicy } from "../../../src/config.js";
import {
  acDecisionOf,
  appealStateOf,
  chairActionOf,
  refcheckSignal,
  stageOf,
  tagSet,
  trackQuickReject,
  warningsOf,
  type QrInput,
} from "../../../src/modules/quickreject/index.js";
import { describeModuleStatus, moduleStatus, phaseIntervals } from "../../../src/modules/status.js";
import type { PhaseTimes } from "../../../src/rules/phase.js";

const P = DEFAULT_QUICKREJECT_POLICY;
const H = 3_600_000;
const D = 24 * H;
const DUE = Date.UTC(2029, 11, 29, 4, 59);
const tags = (...t: string[]) => tagSet(t);

describe("signals", () => {
  it("refcheck: hallucinated >= min or in-field < min, with the numbers", () => {
    const row = (h: number, f: number, total: number | null = 30) => ({ pid: 1, total_refs: total, hallucinated_refs: h, in_field_refs: f, note: "never shown" });
    expect(refcheckSignal(undefined, 3, P)).toBeNull();
    expect(refcheckSignal(row(0, 5), 3, P)).toBeNull();
    const s = refcheckSignal(row(4, 0), 3, P)!;
    expect(s.reason).toBe(
      "refcheck import #3: 4 hallucinated references (PCS_REFCHECK_HALLUCINATED_MIN=1); 0 in-field references, fewer than PCS_REFCHECK_IN_FIELD_MIN=1 of 30 references",
    );
    expect(s.evidence).toEqual({ runId: 3, hallucinatedRefs: 4, inFieldRefs: 0, totalRefs: 30 });
    expect(JSON.stringify(s)).not.toContain("never shown");
    const strict: QuickRejectPolicy = { ...P, refcheck: { hallucinatedMin: 5, inFieldMin: 0 } };
    expect(refcheckSignal(row(4, 0, null), 3, strict)).toBeNull();
  });
});

describe("states from tags", () => {
  it("tag matching ignores case, a leading #, and tag values", () => {
    expect([...tags("#QR-Flag", "qr-ac-reject#2", "other")]).toEqual(["qr-flag", "qr-ac-reject", "other"]);
  });

  it("AC decision, chair action, appeal state", () => {
    expect(acDecisionOf(tags(), P)).toBe("none");
    expect(acDecisionOf(tags("qr-ac-keep"), P)).toBe("keep");
    expect(acDecisionOf(tags("qr-ac-keep", "qr-ac-reject"), P)).toBe("reject");
    expect(chairActionOf(tags("qr-chair-keep"), P)).toBe("keep");
    expect(chairActionOf(tags("qr-chair-desk-reject"), P)).toBe("desk-reject");
    expect(appealStateOf(tags(), P)).toBe("none");
    expect(appealStateOf(tags("qr-appeal"), P)).toBe("requested");
    expect(appealStateOf(tags("qr-appeal", "qr-appeal-upheld"), P)).toBe("upheld");
    expect(appealStateOf(tags("qr-appeal-overturned"), P)).toBe("overturned");
  });

  it("configurable vocabulary (PCS_QR_TAGS)", () => {
    const custom: QuickRejectPolicy = { ...P, tags: { ...QR_TAG_DEFAULTS, appeal: "dr-appeal" } };
    expect(appealStateOf(tags("dr-appeal"), custom)).toBe("requested");
    expect(appealStateOf(tags("qr-appeal"), custom)).toBe("none");
  });

  it("stage: open appeal, else chair after an AC reject, else AC", () => {
    expect(stageOf("none", "none", "none")).toBe("ac-decision");
    expect(stageOf("reject", "none", "none")).toBe("chair-action");
    expect(stageOf("keep", "none", "none")).toBe("done");
    expect(stageOf("reject", "desk-reject", "none")).toBe("done");
    expect(stageOf("reject", "desk-reject", "requested")).toBe("appeal");
    expect(stageOf("reject", "desk-reject", "upheld")).toBe("done");
    expect(stageOf("none", "keep", "none")).toBe("done");
  });

  it("warnings: conflicting tags, decision missing or still reject, appeal without desk reject", () => {
    const w = (decision: string | null, ...t: string[]) =>
      warningsOf({ pid: 9, title: "", decision, tags: t, acs: [] }, tags(...t), P).map((x) => `${x.code}: ${x.reason}`);
    expect(w("Rejected", "qr-ac-reject", "qr-chair-desk-reject")).toEqual([]);
    expect(w(null, "qr-ac-reject", "qr-ac-keep")).toEqual(["CONFLICTING_TAGS: #9 has both #qr-ac-reject and #qr-ac-keep; the first wins here"]);
    expect(w("Accepted", "qr-chair-desk-reject")).toEqual([
      'DECISION_MISSING: #9 is tagged #qr-chair-desk-reject but its decision is "Accepted", not a reject (PCS_QR_REJECT_DECISIONS=Rejected)',
    ]);
    expect(w("rejected", "qr-chair-desk-reject", "qr-appeal", "qr-appeal-overturned")).toEqual([
      'DECISION_STILL_REJECT: #9: the appeal was overturned (#qr-appeal-overturned) but the decision is still "rejected"',
    ]);
    expect(w(null, "qr-appeal")).toEqual(["APPEAL_WITHOUT_DESK_REJECT: #9 has an appeal tag but no #qr-chair-desk-reject"]);
  });
});

describe("trackQuickReject", () => {
  const base: QrInput = {
    papers: [
      { pid: 1, title: "A", decision: null, tags: [], acs: ["ac@example.org"] },
      { pid: 2, title: "B", decision: null, tags: ["qr-flag"], acs: [] },
      { pid: 3, title: "C", decision: null, tags: [], acs: [] },
      { pid: 4, title: "D", decision: "Rejected", tags: ["qr-ac-reject", "qr-chair-desk-reject", "qr-appeal"], acs: [] },
    ],
    reviews: [
      { rid: 10, pid: 1, email: "r1@example.org", status: "complete", value: 1 },
      { rid: 11, pid: 1, email: "r2@example.org", status: "complete", value: 3 },
      { rid: 12, pid: 3, email: "r3@example.org", status: "draft", value: 1 },
      { rid: 13, pid: 3, email: "r4@example.org", status: "complete", value: null },
    ],
    refcheck: undefined,
    due: DUE,
    now: DUE + 1.5 * D,
  };

  it("queues papers with a signal or a state tag; draft and unscored reviews cast no vote", () => {
    const r = trackQuickReject(base, P);
    expect(r.items.map((i) => [i.pid, i.stage, i.signals.map((s) => s.kind), i.appealState])).toEqual([
      [1, "ac-decision", ["qr-verdict"], "none"],
      [2, "ac-decision", ["ac-flag"], "none"],
      [4, "appeal", [], "requested"],
    ]);
    expect(r.items[0]!.signals[0]!.reason).toBe("1 of 2 submitted quick-reject reviews vote reject (OveMer <= 1, PCS_QR_REJECT_MAX; round quickreject)");
    expect(r.items[0]!.signals[0]!.evidence).toEqual({ rids: [10], rejectVotes: 1, submitted: 2, assigned: 2 });
    expect(r.items[0]!.reviews.map((x) => x.verdict)).toEqual(["reject", "keep"]);
    expect(r.items[2]!.stateTags).toEqual(["qr-ac-reject", "qr-chair-desk-reject", "qr-appeal"]);
    expect(r.counts).toEqual({
      items: 3,
      byStage: { "ac-decision": 2, "chair-action": 0, appeal: 1, done: 0 },
      byAppeal: { none: 2, requested: 1, upheld: 0, overturned: 0 },
      qrReviews: 4,
      qrReviewsSubmitted: 3,
      overdueReviews: 1,
      warnings: 0,
    });
    expect(r.overdueReviews).toEqual([
      { pid: 3, rid: 12, email: "r3@example.org", status: "draft", daysOverdue: 1.5, reason: "#3: r3@example.org's quick-reject review is draft, 1.5 days after PCS_PHASE_QUICKREJECT_DUE" },
    ]);
    expect(r.mailDrafts).toEqual([
      { label: "Overdue quick-reject reviews (round quickreject)", recipients: "Reviewers with incomplete reviews", search: "3", papers: 1 },
      { label: "Quick-reject queue: AC decision needed", recipients: "Area chairs (metareviewers) of these papers", search: "1 2", papers: 2 },
    ]);
    expect(r.notes).toEqual(["No refcheck import yet, so there are no refcheck signals (pcs import refcheck <file>)"]);
  });

  it("nothing is overdue before the due date, or without PCS_PHASE_QUICKREJECT_DUE", () => {
    expect(trackQuickReject({ ...base, now: DUE }, P).overdueReviews).toEqual([]);
    const r = trackQuickReject({ ...base, due: null }, P);
    expect(r.overdueReviews).toEqual([]);
    expect(r.notes[0]).toMatch(/PCS_PHASE_QUICKREJECT_DUE is not set/);
  });

  it("PCS_QR_REJECT_MAX moves the verdict line", () => {
    const r = trackQuickReject(base, { ...P, rejectMax: 3 });
    expect(r.items[0]!.signals[0]!.evidence).toMatchObject({ rejectVotes: 2 });
  });
});

describe("module status (activation window)", () => {
  const p: PhaseTimes = {
    reviewDue: 100 * D,
    responseOpen: null,
    responseClose: null,
    discussionOpen: 110 * D,
    discussionClose: 120 * D,
    decisionsDue: 125 * D,
    registrationDue: 10 * D,
    submissionDue: 20 * D,
    quickRejectDue: 40 * D,
    assignmentDone: 60 * D,
  };

  it("chains the pre-review phases from the configured dates", () => {
    const iv = phaseIntervals(p);
    expect(iv.registration).toEqual({ from: null, to: 10 * D });
    expect(iv["quick-reject"]).toEqual({ from: 20 * D, to: 40 * D });
    expect(iv["before-review-due"]).toEqual({ from: 60 * D, to: 100 * D });
    expect(iv.response).toBeNull();
    expect(phaseIntervals({ ...p, submissionDue: null })["quick-reject"]).toEqual({ from: 10 * D, to: 40 * D });
  });

  it("A spans registration..quick-reject; B quick-reject..assignment", () => {
    expect(moduleStatus("reserve-compliance", p, 5 * D)).toMatchObject({ letter: "A", active: true, phase: "registration", window: { from: null, to: 40 * D } });
    const b = moduleStatus("quick-reject", p, 50 * D);
    expect(b).toMatchObject({ letter: "B", active: true, phase: "assignment", window: { from: 20 * D, to: 60 * D } });
    expect(moduleStatus("quick-reject", p, 70 * D).active).toBe(false);
    expect(describeModuleStatus(b, (t) => `d${t / D}`)).toBe(
      "Module B (Quick-reject / desk-reject tracker): active now (phase assignment); window d20 .. d60",
    );
  });

  it("no window without any of the module's dates", () => {
    const mvp: PhaseTimes = { ...p, registrationDue: null, submissionDue: null, quickRejectDue: null, assignmentDone: null };
    const s = moduleStatus("reserve-compliance", mvp, 5 * D);
    expect(s).toMatchObject({ active: false, phase: "before-review-due", window: null });
    expect(describeModuleStatus(s, String)).toMatch(/no window: none of its phases \(registration, submission, quick-reject\) has a configured date/);
  });
});
