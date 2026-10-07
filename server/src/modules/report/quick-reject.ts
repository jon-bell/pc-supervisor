// Quick/desk-reject counts and appeals for the process report (spec §10.4 B
// -> G). The tracker itself is M11 (server/src/modules/quickreject/); the
// report reads it only through this interface, so it never invents numbers:
// until a provider is wired, the section says the tracker is unavailable.

import type { Clock } from "../../clock.js";
import type { Config } from "../../config.js";
import type { Store } from "../../store/store.js";
import type { QuickRejectSummary } from "./types.js";

/** Summarize the quick-reject tracker as of the clock. */
export type QuickRejectProvider = (store: Store, cfg: Config, clock: Clock) => QuickRejectSummary;

export const QUICK_REJECT_UNAVAILABLE: QuickRejectSummary = {
  available: false,
  queued: null,
  quickRejected: null,
  deskRejected: null,
  appeals: null,
  reason: "the quick-reject tracker (spec §10.4 B) is not available in this build",
};

export const unavailableQuickReject: QuickRejectProvider = () => QUICK_REJECT_UNAVAILABLE;
