// Quick/desk-reject counts and appeals for the process report (spec §10.4 B
// -> G). The tracker itself is M11 (server/src/modules/quickreject/); the
// report reads it only through QuickRejectProvider, so tests can inject one
// and nothing here re-derives M11's states.

import type { Clock } from "../../clock.js";
import type { Config } from "../../config.js";
import type { Store } from "../../store/store.js";
import { quickRejectReport, type QuickRejectReport } from "../quickreject/index.js";
import type { QuickRejectSummary } from "./types.js";

/** Summarize the quick-reject tracker as of the clock. */
export type QuickRejectProvider = (store: Store, cfg: Config, clock: Clock) => QuickRejectSummary;

export const QUICK_REJECT_UNAVAILABLE: QuickRejectSummary = {
  available: false,
  queued: null,
  acReject: null,
  deskRejected: null,
  kept: null,
  reviews: null,
  appeals: null,
  reason: "the quick-reject tracker (spec §10.4 B) is not available",
};

/** Pure: M11's report -> the counts the process report shows. */
export function summarizeQuickReject(r: QuickRejectReport): QuickRejectSummary {
  const items = r.items;
  const acReject = items.filter((i) => i.acDecision === "reject").length;
  const deskRejected = items.filter((i) => i.chairAction === "desk-reject").length;
  const kept = items.filter((i) => i.chairAction === "keep" || (i.chairAction === "none" && i.acDecision === "keep")).length;
  const a = r.counts.byAppeal;
  const appeals = { filed: a.requested + a.upheld + a.overturned, upheld: a.upheld, overturned: a.overturned, pending: a.requested };
  const reviews = { assigned: r.counts.qrReviews, submitted: r.counts.qrReviewsSubmitted, overdue: r.counts.overdueReviews };
  return {
    available: true,
    queued: items.length,
    acReject,
    deskRejected,
    kept,
    reviews,
    appeals,
    reason:
      `${items.length} papers in the quick-reject queue: ${acReject} AC reject, ${deskRejected} desk-rejected by the chair, ${kept} kept; ` +
      `${appeals.filed} appeals (${appeals.upheld} upheld, ${appeals.overturned} overturned, ${appeals.pending} pending); ` +
      `${reviews.submitted} of ${reviews.assigned} quick-reject reviews submitted, ${reviews.overdue} overdue`,
  };
}

/** The default provider: M11's tracker over the store. */
export const m11QuickReject: QuickRejectProvider = (store, cfg, clock) => summarizeQuickReject(quickRejectReport(store, cfg, { clock }));
