// Quick-reject / desk-reject tracker (spec §10.4 B, PLAN M11): the module's API.
//
//   const report = quickRejectReport(store, cfg, { clock });
//   // report.items: [{ pid, signals, acDecision, chairAction, appealState, stage, warnings }]
//   // report.overdueReviews: quick-reject reviews not submitted after PCS_PHASE_QUICKREJECT_DUE
//
// Read-only and synchronous over the local store and the refcheck import;
// never calls HotCRP. The state comes from tags and decisions the chair and
// ACs set in HotCRP. No review text is read.

import type { Clock } from "../../clock.js";
import { DEFAULT_QUICKREJECT_POLICY, type Config, type QuickRejectPolicy } from "../../config.js";
import type { Store } from "../../store/store.js";
import { loadQrInput } from "./load.js";
import { trackQuickReject } from "./track.js";
import type { QuickRejectReport } from "./types.js";

export type * from "./types.js";
export { loadQrInput } from "./load.js";
export {
  acDecisionOf,
  acFlagSignal,
  appealStateOf,
  chairActionOf,
  refcheckSignal,
  reviewInfo,
  stageOf,
  tagSet,
  trackQuickReject,
  verdictSignal,
  warningsOf,
} from "./track.js";

type Cfg = Pick<Config, "acRole"> & { quickReject?: QuickRejectPolicy | undefined; phases: Pick<Config["phases"], "quickRejectDue"> };

export const quickRejectPolicy = (cfg: { quickReject?: QuickRejectPolicy | undefined }): QuickRejectPolicy =>
  cfg.quickReject ?? DEFAULT_QUICKREJECT_POLICY;

export function quickRejectReport(store: Store, cfg: Cfg, opts: { clock: Clock }): QuickRejectReport {
  const policy = quickRejectPolicy(cfg);
  const input = loadQrInput(store, { acRole: cfg.acRole, policy, due: cfg.phases.quickRejectDue }, opts.clock.now());
  return trackQuickReject(input, policy);
}
